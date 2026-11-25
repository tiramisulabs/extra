import type { Adapter, AdapterEntry, AdapterIncrementOptions } from 'seyfert';
import type { KeyLayout } from './keys';
import type { GuildClaim, KeyTarget, ReconciliationState, SnapshotCut } from './state';
import type { Awaitable } from './sync';

/** Coordination backend selected through `cacheReconciler({ coordinator })`. */
export interface CacheReconcilerCoordinator {
	/** `memory` coordinates a single process. */
	readonly kind: 'memory';
	/** @internal Binds the coordinator to one installation. Throws to refuse an adapter it cannot fence. */
	bind(host: CoordinatorHost): CoordinatorBinding;
}

/** @internal */
export interface CoordinatorHost {
	/** The adapter the plugin wraps. */
	readonly inner: Adapter;
	readonly state: ReconciliationState;
	readonly layout: KeyLayout;
	/** Called with the keys of a caller's write or removal that failed, before the failure reaches the caller. */
	mutationFailed?(keys: readonly string[], cause: unknown): void;
}

export interface RelationshipMember {
	readonly id: string;
	readonly key: string;
}

export type WriteMethod = 'set' | 'patch' | 'bulkSet' | 'bulkPatch';

export interface SweepResult {
	/** Keys deleted from the store. */
	removed: string[];
	/** Keys whose removal failed; they stay hidden until a later reconciliation claims them again. */
	failed: string[];
}

/**
 * Owns the visibility of reconciled keys and every mutation behind `ReconciledAdapter`. The adapter itself only
 * decides what never reaches the binding: unmanaged keys and the engine's unfiltered reads.
 *
 * Each method either returns directly or returns a promise, following the adapter it stands in front of, so a
 * synchronous adapter stays synchronous.
 *
 * @internal
 */
export interface CoordinatorBinding {
	/** Runs after the wrapped adapter started. */
	start(): Awaitable<void>;
	close(): Awaitable<void>;

	/** The managed keys a caller may read, in input order. */
	visibleKeys(keys: readonly string[]): Awaitable<string[]>;
	/** The members of a managed relationship a caller may read. */
	visibleMembers(to: string): Awaitable<RelationshipMember[]>;
	/** Whether a caller may read this member of a managed relationship. */
	containsMember(to: string, id: string): Awaitable<boolean>;

	write(method: WriteMethod, entries: AdapterEntry[]): Awaitable<void>;
	increment(
		key: string,
		field: string,
		delta: number,
		options?: AdapterIncrementOptions,
	): Awaitable<number | undefined>;
	/** `claim` is present when the reconciliation engine removes what is left of a guild. */
	remove(method: 'remove' | 'bulkRemove', keys: string[], claim?: GuildClaim): Awaitable<void>;
	removeMembers(to: string, ids: string[], claim?: GuildClaim): Awaitable<void>;
	removeRelationships(relationships: string[], claim?: GuildClaim): Awaitable<void>;
	flush(): Awaitable<void>;

	/** Deletes the snapshot candidates the fence still allows. A failed removal is recorded, not thrown. */
	sweep(targets: readonly KeyTarget[], cut: SnapshotCut): Awaitable<SweepResult>;
}

/** Thrown inside an engine removal whose claim no longer holds, so the remaining cascade stops. */
export class ReconciliationCancelled extends Error {
	override name = 'ReconciliationCancelled';

	constructor() {
		super('@slipher/cache-reconciler cancelled a stale removal because newer evidence superseded its claim.');
	}
}

export function isCoordinator(value: unknown): value is CacheReconcilerCoordinator {
	return (
		typeof value === 'object' &&
		value !== null &&
		Reflect.get(value, 'kind') === 'memory' &&
		typeof Reflect.get(value, 'bind') === 'function'
	);
}
