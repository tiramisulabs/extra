import type { Adapter, AdapterEntry, AdapterRelationship } from 'seyfert';

const FRESHNESS_RESOURCE = '__slipher_cache_integrity__';

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
	readonly #relationships = new Map<string, Map<string, string>>();
	readonly #values = new Map<string, AdapterRelationship>();

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

	bulkSet(entries: AdapterEntry[]): ReturnType<Adapter['bulkSet']> {
		return this.runBulk(entries, ([key, value, relationship]) => this.set(key, value, relationship));
	}

	set(key: string, data: any, relationship: AdapterRelationship): ReturnType<Adapter['set']> {
		return this.commitFreshness(this.inner.set(key, data, relationship), key, relationship);
	}

	bulkPatch(entries: AdapterEntry[]): ReturnType<Adapter['bulkPatch']> {
		const snapshot = [...entries];
		if (new Set(snapshot.map(([key]) => this.canonicalKey(key))).size !== snapshot.length) {
			return this.runBulk(snapshot, ([key, data, relationship]) => this.patch(key, data, relationship), 1);
		}
		return this.runBulk(snapshot, ([key, data, relationship]) => this.patch(key, data, relationship));
	}

	patch(key: string, data: any, relationship: AdapterRelationship): ReturnType<Adapter['patch']> {
		return this.map(this.canPatch(key), preserve => {
			const result = preserve ? this.inner.patch(key, data, relationship) : this.inner.set(key, data, relationship);
			return this.commitFreshness(result, key, relationship);
		});
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
		return this.runBulk(keys, key => this.remove(key));
	}

	remove(key: string): ReturnType<Adapter['remove']> {
		return this.chain(this.inner.remove(key), () => {
			this.deleteValueVisibility(key);
			return this.inner.remove(this.freshnessKey(key));
		});
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

	removeToRelationship(to: string, keys: string | string[]): ReturnType<Adapter['removeToRelationship']> {
		const snapshot = [...asArray(keys)];
		return this.runBulk(snapshot, id =>
			this.commit(this.inner.removeToRelationship(to, id), () => {
				const key = this.#relationships.get(to)?.get(id);
				if (key !== undefined) this.deleteValueVisibility(key);
			}),
		);
	}

	removeRelationship(to: string | string[]): ReturnType<Adapter['removeRelationship']> {
		return this.runBulk(asArray(to), target =>
			this.commit(this.inner.removeRelationship(target), () => {
				const pattern = new RegExp(
					`^${target
						.split('*')
						.map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
						.join('.*')}$`,
				);
				for (const [relationship, members] of this.#relationships) {
					if (!pattern.test(relationship)) continue;
					for (const key of members.values()) this.deleteValueVisibility(key);
				}
			}),
		);
	}

	private publishValue(key: string, relationship: AdapterRelationship): void {
		const logical = this.canonicalKey(key);
		const [to, id] = relationship;
		this.#values.set(logical, [to, id]);
		let members = this.#relationships.get(to);
		if (!members) {
			members = new Map();
			this.#relationships.set(to, members);
		}
		members.set(id, logical);
	}

	private runBulk<T>(
		items: T[],
		operation: (item: T) => void | PromiseLike<void>,
		batchSize = 100,
	): void | Promise<void> {
		const snapshot = [...items];
		const failures: unknown[] = [];
		const batch = (items: T[]) =>
			this.mapAll(
				items.map(item => {
					try {
						const result = operation(item);
						return isThenable(result)
							? Promise.resolve(result).catch(error => {
									failures.push(error);
								})
							: result;
					} catch (error) {
						failures.push(error);
					}
				}),
				() => undefined,
			);
		let pending: void | Promise<void> = this.miss(undefined);
		for (let offset = 0; offset < snapshot.length; offset += batchSize) {
			const entries = snapshot.slice(offset, offset + batchSize);
			pending = this.chain(pending, () => batch(entries));
		}
		return this.chain(pending, () => {
			if (failures.length) throw new AggregateError(failures, 'CacheIntegrityAdapter bulk operation failed');
		});
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

	private commitFreshness(
		result: void | PromiseLike<void>,
		key: string,
		relationship: AdapterRelationship,
	): void | Promise<void> {
		return this.chain(result, () => {
			const id = this.freshnessId(key);
			return this.commit(
				this.inner.set(this.freshnessKey(key), { writtenAt: Date.now() } satisfies FreshnessMetadata, [
					FRESHNESS_RESOURCE,
					id,
				]),
				() => {
					this.publishValue(key, relationship);
				},
			);
		});
	}

	private deleteValueVisibility(key: string): void {
		const logical = this.canonicalKey(key);
		const relationship = this.#values.get(logical);
		this.#values.delete(logical);
		if (!relationship) return;
		const [to, id] = relationship;
		const members = this.#relationships.get(to);
		members?.delete(id);
		if (members?.size === 0) this.#relationships.delete(to);
	}

	private isVisibleRelationshipKey(to: string, key: string): boolean {
		const logical = this.canonicalKey(key);
		const relationship = this.#values.get(logical);
		return relationship?.[0] === to && this.#relationships.get(to)?.get(relationship[1]) === logical;
	}

	private isVisibleValueKey(key: string): boolean {
		return this.#values.has(this.canonicalKey(key));
	}

	private freshnessId(key: string): string {
		return Buffer.from(this.canonicalKey(key)).toString('hex');
	}

	private freshnessKey(key: string): string {
		return `${FRESHNESS_RESOURCE}.${this.freshnessId(key)}`;
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
}
