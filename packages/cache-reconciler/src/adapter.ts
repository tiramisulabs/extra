import { AsyncLocalStorage } from 'node:async_hooks';
import type { Adapter, AdapterEntry, AdapterRelationship } from 'seyfert';
import type { CoordinatorBinding } from './coordinator';
import type { KeyLayout } from './keys';
import type { GuildClaim, ReconciliationState } from './state';
import { type Awaitable, isThenable, like, map } from './sync';

/** @internal */
export interface ReconciledAdapterHost {
	readonly state: ReconciliationState;
	readonly layout: KeyLayout;
	readonly binding: CoordinatorBinding;
	/** Throws to refuse a start before the wrapped adapter is touched; unlike a later failure it is not terminal. */
	beforeStart?(): void;
}

interface UnfilteredScope {
	readonly adapter: ReconciledAdapter;
	readonly claim: GuildClaim;
}

// One storage for every wrapper keeps a rebuilt plugin from accumulating AsyncLocalStorage instances.
const unfilteredScope = new AsyncLocalStorage<UnfilteredScope>();

/**
 * Runs reconciliation that must see and remove what is left of a guild, including entries hidden from callers.
 * The scope follows the calling async task, so concurrent callers stay filtered. It lifts read visibility
 * only: every removal inside still revalidates `claim`.
 *
 * It is a module function on purpose: nothing reachable from `client.cache.adapter` can open the scope.
 *
 * @internal
 */
export function runUnfiltered<T>(adapter: ReconciledAdapter, claim: GuildClaim, run: () => T): T {
	return unfilteredScope.run({ adapter, claim }, run);
}

/**
 * Decorates the configured cache adapter so callers only read entries the reconciliation state confirms.
 *
 * Every `Adapter` member is implemented explicitly, so a member Seyfert adds as required fails to compile
 * instead of silently bypassing reconciliation. Reads of a non-visible entry behave as a cache miss, every
 * mutation goes through the coordinator binding, and keys outside Seyfert's core resources pass through.
 * The wrapper keeps the wrapped adapter's synchronous or asynchronous contract and never closes it.
 *
 * @internal
 */
export class ReconciledAdapter implements Adapter {
	/** Present only while the backing adapter offers an atomic increment. */
	increment?: Adapter['increment'];

	private readonly state: ReconciliationState;
	private readonly layout: KeyLayout;
	private readonly binding: CoordinatorBinding;
	private readonly beforeStart: (() => void) | undefined;
	private startup:
		| { status: 'pending' }
		| { status: 'started'; result: Awaitable<void> }
		| { status: 'failed'; cause: unknown } = { status: 'pending' };

	constructor(
		readonly inner: Adapter,
		host: ReconciledAdapterHost,
	) {
		this.state = host.state;
		this.layout = host.layout;
		this.binding = host.binding;
		this.beforeStart = host.beforeStart;
		this.exposeIncrement();
	}

	get isAsync(): boolean {
		return this.inner.isAsync;
	}

	/**
	 * Starts the wrapped adapter, then the coordinator that may reuse its transport, exactly once. A failure is
	 * terminal because the wrapped adapter may be partly started: later calls rethrow the same cause without
	 * touching it again.
	 */
	start(): ReturnType<Adapter['start']> {
		if (this.startup.status === 'failed') return this.rethrow(this.startup.cause);
		if (this.startup.status === 'started') return this.startup.result;
		try {
			this.beforeStart?.();
		} catch (cause) {
			return this.rethrow(cause);
		}
		let result: Awaitable<void>;
		try {
			result = map(
				map(this.inner.start(), () => this.binding.start()),
				() => {
					this.exposeIncrement();
					this.state.activate();
				},
			);
		} catch (cause) {
			return this.rethrow(this.failStart(cause));
		}
		if (isThenable(result)) {
			result = Promise.resolve(result).catch(cause => {
				throw this.failStart(cause);
			});
		}
		this.startup = { status: 'started', result };
		return result;
	}

	/** Whether `start()` was ever called, and with it the wrapped adapter possibly touched. */
	get startAttempted(): boolean {
		return this.startup.status !== 'pending';
	}

	scan(query: string, keys?: false): ReturnType<Adapter['scan']>;
	scan(query: string, keys: true): ReturnType<Adapter['scan']>;
	scan(query: string, keys?: boolean): ReturnType<Adapter['scan']> {
		if (this.claim() || !this.managesQuery(query)) return this.inner.scan(query, keys as true);
		return map(this.inner.scan(query, true), found =>
			map(this.readable(found), readable => (keys ? readable : this.inner.bulkGet(readable))),
		);
	}

	bulkGet(keys: string[]): ReturnType<Adapter['bulkGet']> {
		if (this.claim()) return this.inner.bulkGet(keys);
		return map(this.readable(keys), readable => this.inner.bulkGet(readable));
	}

	get(key: string): ReturnType<Adapter['get']> {
		if (this.claim() || !this.layout.manages(key)) return this.inner.get(key);
		return map(this.binding.visibleKeys([key]), visible =>
			visible.length ? this.inner.get(key) : like(this.inner, null),
		);
	}

	bulkSet(entries: AdapterEntry[]): ReturnType<Adapter['bulkSet']> {
		return this.binding.write('bulkSet', entries);
	}

	set(key: string, value: any, relationship: AdapterRelationship): ReturnType<Adapter['set']> {
		return this.binding.write('set', [[key, value, relationship]]);
	}

	bulkPatch(entries: AdapterEntry[]): ReturnType<Adapter['bulkPatch']> {
		return this.binding.write('bulkPatch', entries);
	}

	patch(key: string, value: any, relationship: AdapterRelationship): ReturnType<Adapter['patch']> {
		return this.binding.write('patch', [[key, value, relationship]]);
	}

	values(to: string): ReturnType<Adapter['values']> {
		if (this.claim() || !this.layout.manages(to)) return this.inner.values(to);
		return map(this.binding.visibleMembers(to), members => this.inner.bulkGet(members.map(member => member.key)));
	}

	keys(to: string): ReturnType<Adapter['keys']> {
		if (this.claim() || !this.layout.manages(to)) return this.inner.keys(to);
		return map(this.binding.visibleMembers(to), members => members.map(member => member.key));
	}

	count(to: string): ReturnType<Adapter['count']> {
		if (this.claim() || !this.layout.manages(to)) return this.inner.count(to);
		return map(this.binding.visibleMembers(to), members => members.length);
	}

	bulkRemove(keys: string[]): ReturnType<Adapter['bulkRemove']> {
		return this.binding.remove('bulkRemove', keys, this.claim());
	}

	remove(key: string): ReturnType<Adapter['remove']> {
		return this.binding.remove('remove', [key], this.claim());
	}

	flush(): ReturnType<Adapter['flush']> {
		return this.binding.flush();
	}

	contains(to: string, key: string): ReturnType<Adapter['contains']> {
		if (this.claim() || !this.layout.manages(to)) return this.inner.contains(to, key);
		return this.binding.containsMember(to, key);
	}

	getToRelationship(to: string): ReturnType<Adapter['getToRelationship']> {
		if (this.claim() || !this.layout.manages(to)) return this.inner.getToRelationship(to);
		return map(this.binding.visibleMembers(to), members => members.map(member => member.id));
	}

	removeToRelationship(to: string, keys: string | string[]): ReturnType<Adapter['removeToRelationship']> {
		return this.binding.removeMembers(to, Array.isArray(keys) ? keys : [keys], this.claim());
	}

	removeRelationship(to: string | string[]): ReturnType<Adapter['removeRelationship']> {
		return this.binding.removeRelationships(Array.isArray(to) ? to : [to], this.claim());
	}

	/** The engine claim of the calling async task, when it runs inside this wrapper's unfiltered scope. */
	private claim(): GuildClaim | undefined {
		const scope = unfilteredScope.getStore();
		return scope?.adapter === this ? scope.claim : undefined;
	}

	/** A scan query is `resource.*`-shaped; a wildcard resource could match managed keys too. */
	private managesQuery(query: string): boolean {
		return query.startsWith('*') || this.layout.manages(query);
	}

	/** Keeps unmanaged keys and the managed keys a caller may read, in input order. */
	private readable(keys: readonly string[]): Awaitable<string[]> {
		const managed = keys.filter(key => this.layout.manages(key));
		if (!managed.length) return like(this.inner, [...keys]);
		return map(this.binding.visibleKeys(managed), visible => {
			const allowed = new Set(visible);
			return keys.filter(key => allowed.has(key) || !this.layout.manages(key));
		});
	}

	/** Records the terminal start failure and hands the cause back to be raised. */
	private failStart(cause: unknown): unknown {
		this.startup = { status: 'failed', cause };
		this.state.fail(cause);
		return cause;
	}

	/** Raises a start failure the way the wrapped adapter raises its own: a rejection, or a throw. */
	private rethrow(cause: unknown): Promise<never> {
		if (this.inner.isAsync) return Promise.reject(cause);
		throw cause;
	}

	private exposeIncrement(): void {
		this.increment = this.inner.increment
			? (key, field, delta, options) => this.binding.increment(key, field, delta, options)
			: undefined;
	}
}
