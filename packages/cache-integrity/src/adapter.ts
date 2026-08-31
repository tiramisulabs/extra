import type { Adapter } from 'seyfert';

function isThenable<T>(value: unknown): value is PromiseLike<T> {
	return (
		((typeof value === 'object' && value !== null) || typeof value === 'function') &&
		typeof Reflect.get(value, 'then') === 'function'
	);
}

function asArray(value: string | string[]): string[] {
	return Array.isArray(value) ? value : [value];
}

function adapterKeyPrefix(adapter: object): string | undefined {
	try {
		const buildKey = Reflect.get(adapter, 'buildKey');
		if (typeof buildKey !== 'function') return;
		const probe = '__slipher_cache_integrity_probe__';
		const physical = Reflect.apply(buildKey, adapter, [probe]);
		if (typeof physical !== 'string' || !physical.endsWith(probe)) return;
		if (Reflect.apply(buildKey, adapter, [physical]) !== physical) return;
		return physical.slice(0, -probe.length);
	} catch {
		return;
	}
}

/**
 * Makes persisted cache data invisible until the current process writes it.
 *
 * The backing adapter remains the source of storage. This wrapper only keeps
 * the current process generation in memory, so restarting the process begins
 * with no visible values or relationships.
 *
 * @internal
 */
export class ProcessGenerationAdapter implements Adapter {
	readonly #keyPrefix: string | undefined;
	readonly #relationships = new Map<string, Set<string>>();
	readonly #values = new Set<string>();

	constructor(readonly inner: Adapter) {
		this.#keyPrefix = adapterKeyPrefix(inner);
	}

	get isAsync(): boolean {
		return this.inner.isAsync;
	}

	start(): ReturnType<Adapter['start']> {
		return this.inner.start.call(this.inner);
	}

	scan(query: string, keys?: false): ReturnType<Adapter['scan']>;
	scan(query: string, keys: true): ReturnType<Adapter['scan']>;
	scan(query: string, keys?: boolean): ReturnType<Adapter['scan']> {
		const result = this.inner.scan.call(this.inner, query, true);
		return this.map(result, discovered => {
			const visible = discovered.filter(key => this.isVisibleValueKey(key));
			return keys ? visible : this.inner.bulkGet.call(this.inner, visible);
		}) as ReturnType<Adapter['scan']>;
	}

	bulkGet(keys: string[]): ReturnType<Adapter['bulkGet']> {
		return this.inner.bulkGet.call(
			this.inner,
			keys.filter(key => this.isVisibleValueKey(key)),
		);
	}

	get(key: string): ReturnType<Adapter['get']> {
		if (!this.isVisibleValueKey(key)) return this.miss(null) as ReturnType<Adapter['get']>;
		return this.inner.get.call(this.inner, key);
	}

	bulkSet(entries: [string, any][]): ReturnType<Adapter['bulkSet']> {
		const snapshot = entries.map(([key, value]) => [key, value] as [string, any]);
		return this.commit(this.inner.bulkSet.call(this.inner, snapshot), () => {
			for (const [key] of snapshot) this.#values.add(this.canonicalKey(key));
		});
	}

	set(key: string, data: any): ReturnType<Adapter['set']> {
		return this.commit(this.inner.set.call(this.inner, key, data), () => this.#values.add(this.canonicalKey(key)));
	}

	bulkPatch(entries: [string, any][]): ReturnType<Adapter['bulkPatch']> {
		const snapshot = entries.map(([key, value]) => [key, value] as [string, any]);
		if (!snapshot.length) return this.miss(undefined) as ReturnType<Adapter['bulkPatch']>;
		if (new Set(snapshot.map(([key]) => this.canonicalKey(key))).size !== snapshot.length) {
			return this.patchSequentially(snapshot) as ReturnType<Adapter['bulkPatch']>;
		}
		const replacements: [string, any][] = [];
		const patches: [string, any][] = [];
		for (const entry of snapshot) {
			(this.isVisibleValueKey(entry[0]) ? patches : replacements).push(entry);
		}

		const replaceResult = replacements.length ? this.inner.bulkSet.call(this.inner, replacements) : undefined;
		return this.chain(replaceResult, () => {
			for (const [key] of replacements) this.#values.add(this.canonicalKey(key));
			if (!patches.length) return;
			return this.commit(this.inner.bulkPatch.call(this.inner, patches), () => {
				for (const [key] of patches) this.#values.add(this.canonicalKey(key));
			});
		}) as ReturnType<Adapter['bulkPatch']>;
	}

	patch(key: string, data: any): ReturnType<Adapter['patch']> {
		const result = this.isVisibleValueKey(key)
			? this.inner.patch.call(this.inner, key, data)
			: this.inner.set.call(this.inner, key, data);
		return this.commit(result, () => this.#values.add(this.canonicalKey(key)));
	}

	values(to: string): ReturnType<Adapter['values']> {
		return this.map(this.keys(to), keys =>
			this.inner.bulkGet.call(
				this.inner,
				keys.filter(key => this.isVisibleValueKey(key)),
			),
		) as ReturnType<Adapter['values']>;
	}

	keys(to: string): ReturnType<Adapter['keys']> {
		return this.map(this.inner.keys.call(this.inner, to), keys =>
			keys.filter(key => this.isVisibleRelationshipKey(to, key)),
		) as ReturnType<Adapter['keys']>;
	}

	count(to: string): ReturnType<Adapter['count']> {
		return this.map(this.getToRelationship(to), relationships => relationships.length) as ReturnType<Adapter['count']>;
	}

	bulkRemove(keys: string[]): ReturnType<Adapter['bulkRemove']> {
		const snapshot = [...keys];
		return this.commit(this.inner.bulkRemove.call(this.inner, snapshot), () => {
			for (const key of snapshot) this.deleteValueVisibility(key);
		});
	}

	remove(key: string): ReturnType<Adapter['remove']> {
		return this.commit(this.inner.remove.call(this.inner, key), () => this.deleteValueVisibility(key));
	}

	flush(): ReturnType<Adapter['flush']> {
		return this.commit(this.inner.flush.call(this.inner), () => {
			this.#relationships.clear();
			this.#values.clear();
		});
	}

	contains(to: string, key: string): ReturnType<Adapter['contains']> {
		if (!this.#relationships.get(to)?.has(key)) return this.miss(false) as ReturnType<Adapter['contains']>;
		return this.inner.contains.call(this.inner, to, key);
	}

	getToRelationship(to: string): ReturnType<Adapter['getToRelationship']> {
		const visible = this.#relationships.get(to);
		if (!visible) return this.miss([]) as ReturnType<Adapter['getToRelationship']>;
		return this.map(this.inner.getToRelationship.call(this.inner, to), relationships =>
			relationships.filter(key => visible.has(key)),
		) as ReturnType<Adapter['getToRelationship']>;
	}

	bulkAddToRelationShip(data: Record<string, string[]>): ReturnType<Adapter['bulkAddToRelationShip']> {
		const snapshot = Object.fromEntries(Object.entries(data).map(([to, keys]) => [to, [...keys]]));
		return this.commit(this.inner.bulkAddToRelationShip.call(this.inner, snapshot), () => {
			for (const [to, keys] of Object.entries(snapshot)) this.addVisibleRelationships(to, keys);
		});
	}

	addToRelationship(to: string, keys: string | string[]): ReturnType<Adapter['addToRelationship']> {
		const snapshot = asArray(keys);
		return this.commit(this.inner.addToRelationship.call(this.inner, to, snapshot), () => {
			this.addVisibleRelationships(to, snapshot);
		});
	}

	removeToRelationship(to: string, keys: string | string[]): ReturnType<Adapter['removeToRelationship']> {
		const snapshot = asArray(keys);
		return this.commit(this.inner.removeToRelationship.call(this.inner, to, snapshot), () => {
			const relationship = this.#relationships.get(to);
			for (const key of snapshot) relationship?.delete(key);
			if (relationship?.size === 0) this.#relationships.delete(to);
		});
	}

	removeRelationship(to: string | string[]): ReturnType<Adapter['removeRelationship']> {
		const snapshot = asArray(to);
		return this.commit(this.inner.removeRelationship.call(this.inner, snapshot), () => {
			for (const key of snapshot) this.#relationships.delete(key);
		});
	}

	private addVisibleRelationships(to: string, keys: string[]): void {
		let relationship = this.#relationships.get(to);
		if (!relationship) {
			relationship = new Set();
			this.#relationships.set(to, relationship);
		}
		for (const key of keys) relationship.add(key);
	}

	private chain<T>(result: T | PromiseLike<T>, next: () => void | PromiseLike<void>): void | Promise<void> {
		if (isThenable<T>(result)) return Promise.resolve(result).then(next);
		const nextResult = next();
		return isThenable<void>(nextResult) ? Promise.resolve(nextResult) : nextResult;
	}

	private canonicalKey(key: string): string {
		return this.#keyPrefix && key.startsWith(this.#keyPrefix) ? key.slice(this.#keyPrefix.length) : key;
	}

	private deleteValueVisibility(key: string): void {
		this.#values.delete(this.canonicalKey(key));
	}

	private isVisibleRelationshipKey(to: string, key: string): boolean {
		const relationships = this.#relationships.get(to);
		if (!relationships) return false;
		const logical = this.canonicalKey(key);
		const relationshipPrefix = `${to}.`;
		return logical.startsWith(relationshipPrefix) && relationships.has(logical.slice(relationshipPrefix.length));
	}

	private isVisibleValueKey(key: string): boolean {
		return this.#values.has(this.canonicalKey(key));
	}

	private commit<T>(result: T | PromiseLike<T>, apply: () => void): T | Promise<T> {
		if (isThenable<T>(result)) {
			return Promise.resolve(result).then(value => {
				apply();
				return value;
			});
		}
		apply();
		return result;
	}

	private map<T, R>(result: T | PromiseLike<T>, transform: (value: T) => R | PromiseLike<R>): R | Promise<R> {
		if (isThenable<T>(result)) return Promise.resolve(result).then(transform);
		const transformed = transform(result);
		return isThenable<R>(transformed) ? Promise.resolve(transformed) : transformed;
	}

	private miss<T>(value: T): T | Promise<T> {
		return this.inner.isAsync ? Promise.resolve(value) : value;
	}

	private patchSequentially(entries: [string, any][]): void | Promise<void> {
		let pending: Promise<void> | undefined;
		for (const [key, data] of entries) {
			if (pending) {
				pending = pending.then(() => this.patch(key, data));
				continue;
			}
			const result = this.patch(key, data);
			if (isThenable<void>(result)) pending = Promise.resolve(result);
		}
		return pending;
	}
}
