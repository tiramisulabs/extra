import type { Adapter, AdapterEntry, AdapterRelationship } from 'seyfert';

/**
 * Decorates the configured cache adapter.
 *
 * Every `Adapter` member is implemented explicitly, so a member Seyfert adds as required fails to compile
 * instead of silently bypassing reconciliation.
 *
 * @internal
 */
export class ReconciledAdapter implements Adapter {
	/** Present only while the backing adapter offers an atomic increment. */
	increment?: Adapter['increment'];

	constructor(readonly inner: Adapter) {
		this.exposeIncrement();
	}

	get isAsync(): boolean {
		return this.inner.isAsync;
	}

	start(): ReturnType<Adapter['start']> {
		const started = this.inner.start();
		// An adapter may only learn whether it can increment while it starts.
		if (isThenable(started)) return Promise.resolve(started).then(() => this.exposeIncrement());
		this.exposeIncrement();
	}

	private exposeIncrement(): void {
		this.increment = this.inner.increment
			? (key, field, delta, options) => this.inner.increment!(key, field, delta, options)
			: undefined;
	}

	scan(query: string, keys?: false): ReturnType<Adapter['scan']>;
	scan(query: string, keys: true): ReturnType<Adapter['scan']>;
	scan(query: string, keys?: boolean): ReturnType<Adapter['scan']> {
		return this.inner.scan(query, keys as true);
	}

	bulkGet(keys: string[]): ReturnType<Adapter['bulkGet']> {
		return this.inner.bulkGet(keys);
	}

	get(key: string): ReturnType<Adapter['get']> {
		return this.inner.get(key);
	}

	bulkSet(entries: AdapterEntry[]): ReturnType<Adapter['bulkSet']> {
		return this.inner.bulkSet(entries);
	}

	set(key: string, value: any, relationship: AdapterRelationship): ReturnType<Adapter['set']> {
		return this.inner.set(key, value, relationship);
	}

	bulkPatch(entries: AdapterEntry[]): ReturnType<Adapter['bulkPatch']> {
		return this.inner.bulkPatch(entries);
	}

	patch(key: string, value: any, relationship: AdapterRelationship): ReturnType<Adapter['patch']> {
		return this.inner.patch(key, value, relationship);
	}

	values(to: string): ReturnType<Adapter['values']> {
		return this.inner.values(to);
	}

	keys(to: string): ReturnType<Adapter['keys']> {
		return this.inner.keys(to);
	}

	count(to: string): ReturnType<Adapter['count']> {
		return this.inner.count(to);
	}

	bulkRemove(keys: string[]): ReturnType<Adapter['bulkRemove']> {
		return this.inner.bulkRemove(keys);
	}

	remove(key: string): ReturnType<Adapter['remove']> {
		return this.inner.remove(key);
	}

	flush(): ReturnType<Adapter['flush']> {
		return this.inner.flush();
	}

	contains(to: string, key: string): ReturnType<Adapter['contains']> {
		return this.inner.contains(to, key);
	}

	getToRelationship(to: string): ReturnType<Adapter['getToRelationship']> {
		return this.inner.getToRelationship(to);
	}

	removeToRelationship(to: string, keys: string | string[]): ReturnType<Adapter['removeToRelationship']> {
		return this.inner.removeToRelationship(to, keys);
	}

	removeRelationship(to: string | string[]): ReturnType<Adapter['removeRelationship']> {
		return this.inner.removeRelationship(to);
	}
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'then') === 'function';
}
