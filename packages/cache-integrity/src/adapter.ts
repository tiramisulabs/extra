import type { Adapter } from 'seyfert';

const FRESHNESS_PREFIX = '__slipher_cache_integrity__.freshness.';

interface FreshnessMetadata {
	writtenAt: number;
}

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
 * Makes persisted cache data invisible unless it was written recently or by
 * the current process.
 *
 * Explicit value lookups can reuse persisted entries within the configured
 * freshness window. Relationships and enumerations remain process-local.
 *
 * @internal
 */
export class CacheIntegrityAdapter implements Adapter {
	readonly #keyPrefix: string | undefined;
	readonly #relationships = new Map<string, Set<string>>();
	readonly #values = new Set<string>();

	constructor(
		readonly inner: Adapter,
		readonly maxAge: number,
	) {
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
		return this.map(this.readableKeys(keys), readable => this.inner.bulkGet.call(this.inner, readable)) as ReturnType<
			Adapter['bulkGet']
		>;
	}

	get(key: string): ReturnType<Adapter['get']> {
		if (this.isVisibleValueKey(key)) return this.inner.get.call(this.inner, key);
		return this.map(this.hasFreshMetadata(key), fresh =>
			fresh ? this.inner.get.call(this.inner, key) : null,
		) as ReturnType<Adapter['get']>;
	}

	bulkSet(entries: [string, any][]): ReturnType<Adapter['bulkSet']> {
		const snapshot = entries.map(([key, value]) => [key, value] as [string, any]);
		return this.commitFreshness(
			this.inner.bulkSet.call(this.inner, snapshot),
			snapshot.map(([key]) => key),
			() => {
				for (const [key] of snapshot) this.#values.add(this.canonicalKey(key));
			},
		) as ReturnType<Adapter['bulkSet']>;
	}

	set(key: string, data: any): ReturnType<Adapter['set']> {
		return this.commitFreshness(this.inner.set.call(this.inner, key, data), [key], () =>
			this.#values.add(this.canonicalKey(key)),
		) as ReturnType<Adapter['set']>;
	}

	bulkPatch(entries: [string, any][]): ReturnType<Adapter['bulkPatch']> {
		const snapshot = entries.map(([key, value]) => [key, value] as [string, any]);
		if (!snapshot.length) return this.miss(undefined) as ReturnType<Adapter['bulkPatch']>;
		if (new Set(snapshot.map(([key]) => this.canonicalKey(key))).size !== snapshot.length) {
			return this.patchSequentially(snapshot) as ReturnType<Adapter['bulkPatch']>;
		}
		return this.map(this.partitionPatches(snapshot), ({ patches, replacements }) => {
			const replaceResult = replacements.length ? this.inner.bulkSet.call(this.inner, replacements) : undefined;
			return this.chain(replaceResult, () => {
				const patchResult = patches.length ? this.inner.bulkPatch.call(this.inner, patches) : undefined;
				return this.commitFreshness(
					patchResult,
					snapshot.map(([key]) => key),
					() => {
						for (const [key] of snapshot) this.#values.add(this.canonicalKey(key));
					},
				);
			});
		}) as ReturnType<Adapter['bulkPatch']>;
	}

	patch(key: string, data: any): ReturnType<Adapter['patch']> {
		return this.map(this.canPatch(key), preserve => {
			const result = preserve
				? this.inner.patch.call(this.inner, key, data)
				: this.inner.set.call(this.inner, key, data);
			return this.commitFreshness(result, [key], () => this.#values.add(this.canonicalKey(key)));
		}) as ReturnType<Adapter['patch']>;
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
		return this.chain(this.inner.bulkRemove.call(this.inner, snapshot), () => {
			for (const key of snapshot) this.deleteValueVisibility(key);
			return this.inner.bulkRemove.call(
				this.inner,
				snapshot.map(key => this.freshnessKey(key)),
			);
		}) as ReturnType<Adapter['bulkRemove']>;
	}

	remove(key: string): ReturnType<Adapter['remove']> {
		return this.chain(this.inner.remove.call(this.inner, key), () => {
			this.deleteValueVisibility(key);
			return this.inner.remove.call(this.inner, this.freshnessKey(key));
		}) as ReturnType<Adapter['remove']>;
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

	private canPatch(key: string): boolean | Promise<boolean> {
		if (this.isVisibleValueKey(key)) return true;
		return this.map(this.hasFreshMetadata(key), fresh => {
			if (!fresh) return false;
			return this.map(this.inner.get.call(this.inner, key), value => value != null);
		});
	}

	private commitFreshness<T>(result: T | PromiseLike<T>, keys: string[], apply: () => void): T | Promise<T> {
		return this.map(result, value =>
			this.map(this.writeFreshness(keys), () => {
				apply();
				return value;
			}),
		);
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

	private freshnessKey(key: string): string {
		return `${FRESHNESS_PREFIX}${encodeURIComponent(this.canonicalKey(key))}`;
	}

	private hasFreshMetadata(key: string): boolean | Promise<boolean> {
		return this.map(this.inner.get.call(this.inner, this.freshnessKey(key)), metadata => {
			if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
			const writtenAt = Reflect.get(metadata, 'writtenAt');
			const now = Date.now();
			return (
				typeof writtenAt === 'number' &&
				Number.isFinite(writtenAt) &&
				writtenAt <= now &&
				now - writtenAt <= this.maxAge
			);
		});
	}

	private partitionPatches(
		entries: [string, any][],
	):
		| { patches: [string, any][]; replacements: [string, any][] }
		| Promise<{ patches: [string, any][]; replacements: [string, any][] }> {
		const decisions = entries.map(([key]) => this.canPatch(key));
		return this.mapAll(decisions, preserve => {
			const patches: [string, any][] = [];
			const replacements: [string, any][] = [];
			for (let index = 0; index < entries.length; index++) {
				(preserve[index] ? patches : replacements).push(entries[index]);
			}
			return { patches, replacements };
		});
	}

	private readableKeys(keys: string[]): string[] | Promise<string[]> {
		const decisions = keys.map(key => this.isVisibleValueKey(key) || this.hasFreshMetadata(key));
		return this.mapAll(decisions, readable => keys.filter((_, index) => readable[index]));
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

	private mapAll<T, R>(values: (T | PromiseLike<T>)[], transform: (values: T[]) => R): R | Promise<R> {
		if (values.some(isThenable<T>)) return Promise.all(values.map(value => Promise.resolve(value))).then(transform);
		return transform(values as T[]);
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

	private writeFreshness(keys: string[]): void | Promise<void> {
		if (!keys.length) return this.miss(undefined);
		const metadata: FreshnessMetadata = { writtenAt: Date.now() };
		if (keys.length === 1) return this.inner.set.call(this.inner, this.freshnessKey(keys[0]), metadata);
		return this.inner.bulkSet.call(
			this.inner,
			keys.map(key => [this.freshnessKey(key), metadata]),
		);
	}
}
