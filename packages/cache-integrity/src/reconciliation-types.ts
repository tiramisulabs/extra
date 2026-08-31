export type ReconciliationLifecycle = 'installing' | 'active' | 'closing' | 'closed' | 'failed';

export type GuildTerminalOutcome =
	| 'reconciled'
	| 'unavailable-preserved'
	| 'disabled-preserved'
	| 'deleted'
	| 'failure';

export type Visibility = 'visible' | 'unknown-preserved' | 'hidden-pending';

export interface ShardGeneration {
	readonly id: number;
	readonly kind: 'shard';
	readonly sessionId: string;
	readonly shardId: number;
}

export interface GlobalVisibilityScope {
	readonly kind: 'global';
}

export type VisibilityScope = GlobalVisibilityScope | ShardGeneration;

export interface CausalPosition {
	readonly fence: number;
	readonly generation: ShardGeneration;
	readonly sequence: number;
}

export interface GatewayMutationContext {
	readonly deleteClaim?: DeleteClaim;
	readonly event: string;
	readonly guildId?: string;
	readonly mode: 'packet' | 'snapshot' | 'stale-guild-cascade';
	readonly position: CausalPosition;
	readonly shardId: number;
}

export interface SnapshotCut extends CausalPosition {
	readonly completeness: SnapshotCompleteness;
	readonly guildId: string;
	readonly resource: string;
	readonly supersessionTarget?: string;
}

export type SnapshotCompleteness = 'authoritative' | 'partial';

export interface VisibilityRecord {
	readonly causal?: boolean;
	readonly fence: number;
	readonly generation: VisibilityScope;
	readonly state: Visibility;
}

export interface WriteAttempt {
	readonly causal: boolean;
	readonly fence: number;
	readonly generation: VisibilityScope;
	readonly id: number;
	readonly key: string;
	readonly origin?: ShardGeneration;
}

export interface DeleteClaim {
	readonly cut: SnapshotCut;
	readonly fence: number;
	readonly generation: ShardGeneration;
	readonly id: number;
	readonly key: string;
	readonly supersessionTarget: string;
}

export interface RemoveAttempt {
	readonly fence: number;
	readonly generation: VisibilityScope;
	readonly id: number;
	readonly key: string;
	readonly origin?: ShardGeneration;
}

export interface FlushAttempt {
	readonly fence: number;
	readonly id: number;
}

export interface ReconciliationWork {
	readonly generation?: ShardGeneration;
	readonly id: number;
	readonly kind: 'flush' | 'physical-delete' | 'reconciliation' | 'remove' | 'startup-barrier' | 'write';
	readonly label?: string;
}

export interface GenerationStatus {
	readonly committed: boolean;
	readonly expectedGuildIds: readonly string[];
	readonly guildOutcomes: Readonly<Record<string, GuildTerminalOutcome>>;
	readonly latestSequence: number;
	readonly sessionId: string;
	readonly shardId: number;
	readonly streamFinished: boolean;
}

export type WriteCompletion = 'committed' | 'failed' | 'stale' | 'superseded';

export type DeleteCompletion = 'completed' | 'failed' | 'stale';

export type SnapshotArrayDecision<T> =
	| { readonly action: 'preserve' }
	| { readonly action: 'replace'; readonly values: readonly T[] };

export const GLOBAL_VISIBILITY_SCOPE: GlobalVisibilityScope = Object.freeze({ kind: 'global' });

export function sameVisibilityScope(left: VisibilityScope, right: VisibilityScope): boolean {
	if (left.kind === 'global' || right.kind === 'global') return left.kind === right.kind;
	return left === right;
}

/**
 * Reads an array supplied by an authoritative snapshot without conflating an
 * absent optional field with a present empty array.
 *
 * @internal
 */
export function snapshotArrayField<T>(payload: object, field: PropertyKey): SnapshotArrayDecision<T> {
	if (!Object.prototype.hasOwnProperty.call(payload, field)) return { action: 'preserve' };
	const value = Reflect.get(payload, field);
	if (!Array.isArray(value)) throw new TypeError(`Snapshot field ${String(field)} must be an array when present.`);
	return { action: 'replace', values: [...value] as T[] };
}
