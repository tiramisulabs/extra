import {
	type CausalPosition,
	type DeleteClaim,
	type FlushAttempt,
	type GatewayMutationContext,
	ReconciliationState,
	type RemoveAttempt,
	type ShardGeneration,
	type SnapshotCut,
	type VisibilityScope,
	type WriteAttempt,
} from './reconciliation-state';
import { TaskLocalScope } from './task-local-scope';

export type AdapterMutationOperation = 'add-relationship' | 'patch' | 'remove' | 'remove-relationship' | 'set';

export type AdapterMutationAdmission =
	| { readonly kind: 'denied' }
	| { readonly kind: 'tracked'; readonly scope: VisibilityScope }
	| { readonly kind: 'unmanaged' };

export type AdapterMutationTarget =
	| {
			readonly data?: unknown;
			readonly key: string;
			readonly kind: 'value';
			readonly operation: AdapterMutationOperation;
	  }
	| {
			readonly entityKey?: string;
			readonly id?: string;
			readonly kind: 'relationship';
			readonly operation: AdapterMutationOperation;
			readonly to: string;
	  };

interface AdapterReconciliationControllerBaseOptions {
	/** Maps adapter arguments and returned storage keys to one injective state identity. */
	readonly canonicalizeKey?: (key: string) => string;
	readonly guildRelatedNamespaces?: ReadonlySet<string>;
	readonly isManagedRelationship?: (to: string) => boolean;
	readonly isManagedValue?: (key: string) => boolean;
	/** Resolves an ID from a canonical key returned by Adapter.keys(). */
	readonly resolveRelationshipId?: (to: string, canonicalKey: string) => string | undefined;
}

export type AdapterReconciliationControllerOptions = AdapterReconciliationControllerBaseOptions &
	(
		| {
				readonly resolveAdmission: (
					target: AdapterMutationTarget,
					context: GatewayMutationContext | undefined,
				) => AdapterMutationAdmission;
				readonly resolveScope?: never;
		  }
		| {
				readonly resolveAdmission?: never;
				readonly resolveScope: (
					target: AdapterMutationTarget,
					position: CausalPosition | undefined,
				) => VisibilityScope | undefined;
		  }
	);

export type StagedMutationAttempt<T> = T | 'denied' | undefined;

export interface StagedWrites {
	readonly attempts: readonly StagedMutationAttempt<WriteAttempt>[];
	readonly locks: readonly string[];
}

export interface StagedRemoves {
	readonly attempts: readonly StagedMutationAttempt<readonly StagedRemoveAttempt[]>[];
	readonly locks: readonly string[];
}

export type StagedRemoveAttempt =
	| {
			readonly attempt: RemoveAttempt;
			readonly kind: 'remove';
			readonly physicallyRemoved: boolean;
	  }
	| {
			readonly claim: DeleteClaim;
			readonly kind: 'claim';
			readonly physicallyRemoved: boolean;
	  };

interface PlannedClaim {
	readonly claim: DeleteClaim;
	readonly kind: 'claim';
	readonly lock: string;
	readonly physicallyRemoved: boolean;
}

interface PlannedDeniedMutation {
	readonly kind: 'denied';
	readonly lock: string;
}

interface PlannedTrackedMutation {
	readonly kind: 'tracked';
	readonly lock: string;
	readonly state: {
		readonly generation: VisibilityScope;
		readonly key: string;
		readonly position?: CausalPosition;
	};
}

interface PlannedUnmanagedMutation {
	readonly kind: 'unmanaged';
	readonly lock: string;
}

interface StagedRemoveClaim {
	readonly claim: DeleteClaim;
	readonly kind: 'claim';
	readonly physicallyRemoved: boolean;
}

type PlannedMutation = PlannedClaim | PlannedDeniedMutation | PlannedTrackedMutation | PlannedUnmanagedMutation;

const CORE_GUILD_RELATED_NAMESPACES = new Set([
	'channel',
	'emoji',
	'message',
	'overwrite',
	'presence',
	'role',
	'stage_instance',
	'sticker',
]);

function valueToken(key: string): string {
	return JSON.stringify(['value', key]);
}

function relationshipToken(to: string, id: string): string {
	return JSON.stringify(['relationship', to, id]);
}

function relationshipClearToken(to: string): string {
	return JSON.stringify(['relationship-clear', to]);
}

function valueLock(key: string): string {
	return JSON.stringify(['value', key]);
}

function relationshipLock(to: string): string {
	return JSON.stringify(['relationship-bucket', to]);
}

function isStagedRemoveClaim(value: RemoveAttempt | StagedRemoveClaim): value is StagedRemoveClaim {
	return (value as Partial<StagedRemoveClaim>).kind === 'claim';
}

/**
 * The adapter/state bridge is deliberately not exported from the package root.
 * Phase 4 supplies the task-local Gateway position and the resource ownership
 * resolver; without this controller the adapter remains a transparent wrapper.
 *
 * @internal
 */
export class AdapterReconciliationController {
	#canonicalizeKey: (key: string) => string;
	#context = new TaskLocalScope<GatewayMutationContext | CausalPosition>();
	#ownershipHints = new TaskLocalScope<ReadonlyMap<string, VisibilityScope>>();
	#guildRelatedNamespaces: ReadonlySet<string>;
	#isManagedRelationship: (to: string) => boolean;
	#isManagedValue: (key: string) => boolean;
	#resolveRelationshipId: (to: string, canonicalKey: string) => string | undefined;

	constructor(
		readonly state: ReconciliationState,
		private readonly options: AdapterReconciliationControllerOptions,
	) {
		this.#canonicalizeKey = options.canonicalizeKey ?? (key => key);
		this.#guildRelatedNamespaces = options.guildRelatedNamespaces ?? CORE_GUILD_RELATED_NAMESPACES;
		this.#isManagedRelationship = options.isManagedRelationship ?? (() => true);
		this.#isManagedValue = options.isManagedValue ?? (() => true);
		this.#resolveRelationshipId =
			options.resolveRelationshipId ??
			((to, key) => {
				const prefix = `${to}.`;
				return key.startsWith(prefix) ? key.slice(prefix.length) : undefined;
			});
	}

	runWithCause<T>(position: CausalPosition, callback: () => T): T {
		return this.#context.run(position, callback);
	}

	runWithContext<T>(context: GatewayMutationContext, callback: () => T): T {
		return this.#context.run(context, callback);
	}

	/** Carries paired Seyfert cache-entry ownership across relationship and value adapter calls. @internal */
	runWithOwnershipHints<T>(hints: ReadonlyMap<string, VisibilityScope>, callback: () => T): T {
		return this.#ownershipHints.run(hints, callback);
	}

	stageValueWrites(entries: readonly (readonly [string, unknown])[], operation: 'patch' | 'set'): StagedWrites {
		const position = this.currentPosition();
		const plans = entries.map(([key, data]) => {
			const canonicalKey = this.canonicalKey(key);
			const target: AdapterMutationTarget = { data, key: canonicalKey, kind: 'value', operation };
			return this.planMutation(valueToken(canonicalKey), valueLock(canonicalKey), target, position);
		});
		return { attempts: this.stageWritePlans(plans), locks: plans.map(plan => plan.lock) };
	}

	stageValueRemoves(keys: readonly string[]): StagedRemoves {
		const position = this.currentPosition();
		const plans = keys.map(key => {
			const canonicalKey = this.canonicalKey(key);
			const target: AdapterMutationTarget = { key: canonicalKey, kind: 'value', operation: 'remove' };
			return this.planMutation(valueToken(canonicalKey), valueLock(canonicalKey), target, position);
		});
		return {
			attempts: this.toStagedRemoves(this.stageRemovePlans(plans)),
			locks: plans.map(plan => plan.lock),
		};
	}

	stageRelationshipWrites(
		entries: readonly (readonly [string, string])[],
		emptyBuckets: readonly string[] = [],
	): StagedWrites {
		const position = this.currentPosition();
		const plans = entries.map(([to, id]) => {
			const canonicalTo = this.canonicalKey(to);
			const entityKey = this.relationshipEntityKeyFromCanonical(canonicalTo, id);
			const target: AdapterMutationTarget = {
				entityKey,
				id,
				kind: 'relationship',
				operation: 'add-relationship',
				to: canonicalTo,
			};
			return this.planMutation(relationshipToken(canonicalTo, id), relationshipLock(canonicalTo), target, position);
		});
		const locks = [...plans.map(plan => plan.lock), ...emptyBuckets.map(to => relationshipLock(this.canonicalKey(to)))];
		return { attempts: this.stageWritePlans(plans), locks };
	}

	stageRelationshipRemoves(
		entries: readonly (readonly [string, string])[],
		emptyBuckets: readonly string[] = [],
	): StagedRemoves {
		const position = this.currentPosition();
		const plans = entries.map(([to, id]) => {
			const canonicalTo = this.canonicalKey(to);
			const entityKey = this.relationshipEntityKeyFromCanonical(canonicalTo, id);
			const target: AdapterMutationTarget = {
				entityKey,
				id,
				kind: 'relationship',
				operation: 'remove-relationship',
				to: canonicalTo,
			};
			return this.planMutation(relationshipToken(canonicalTo, id), relationshipLock(canonicalTo), target, position);
		});
		const locks = [...plans.map(plan => plan.lock), ...emptyBuckets.map(to => relationshipLock(this.canonicalKey(to)))];
		return { attempts: this.toStagedRemoves(this.stageRemovePlans(plans)), locks };
	}

	stageRelationshipClears(toValues: readonly string[]): StagedRemoves {
		const position = this.currentPosition();
		const plans = toValues.map(to => {
			const canonicalTo = this.canonicalKey(to);
			const target: AdapterMutationTarget = {
				kind: 'relationship',
				operation: 'remove-relationship',
				to: canonicalTo,
			};
			return this.planMutation(relationshipClearToken(canonicalTo), relationshipLock(canonicalTo), target, position);
		});
		return {
			attempts: this.toStagedRemoves(this.stageRemovePlans(plans)),
			locks: plans.map(plan => plan.lock),
		};
	}

	beginWrite(attempt: WriteAttempt): boolean {
		return this.state.beginWrite(attempt);
	}

	completeWrites(attempts: readonly WriteAttempt[], succeeded: boolean): void {
		for (const attempt of attempts) this.state.completeWrite(attempt, succeeded);
	}

	/** Completes writes that were rejected before their storage mutation. @internal */
	rejectWrites(attempts: readonly WriteAttempt[]): void {
		for (const attempt of attempts) this.state.rejectWrite(attempt);
	}

	beginRemove(attempt: RemoveAttempt): boolean {
		return this.state.beginRemove(attempt);
	}

	completeRemove(attempt: RemoveAttempt, succeeded: boolean): void {
		this.state.completeRemove(attempt, succeeded);
	}

	/** @internal */
	abortRemoveBeforeMutation(attempt: RemoveAttempt): boolean {
		return this.state.abortRemoveBeforeMutation(attempt);
	}

	stageFlush(): FlushAttempt {
		return this.state.stageFlush();
	}

	beginFlush(attempt: FlushAttempt): boolean {
		return this.state.beginFlush(attempt);
	}

	completeFlush(attempt: FlushAttempt, succeeded: boolean): void {
		this.state.completeFlush(attempt, succeeded);
	}

	canonicalKey(key: string): string {
		return this.#canonicalizeKey(key);
	}

	/** @internal */
	currentDeleteClaim(): DeleteClaim | undefined {
		return this.currentGatewayContext()?.deleteClaim;
	}

	/** @internal */
	currentGeneration(): ShardGeneration | undefined {
		return this.currentPosition()?.generation;
	}

	/** @internal */
	isManagedValue(key: string): boolean {
		return this.#isManagedValue(this.canonicalKey(key));
	}

	/** @internal */
	isManagedRelationship(to: string): boolean {
		return this.#isManagedRelationship(this.canonicalKey(to));
	}

	/** @internal */
	valueStateKey(key: string): string {
		return valueToken(this.canonicalKey(key));
	}

	/** @internal */
	relationshipStateKey(to: string, id: string): string {
		return relationshipToken(this.canonicalKey(to), id);
	}

	/** @internal */
	relationshipClearStateKey(to: string): string {
		return relationshipClearToken(this.canonicalKey(to));
	}

	/** @internal */
	isStateExplicitlyHidden(key: string): boolean {
		const record = this.state.ownedVisibilityOf(key);
		return record !== undefined && record.state !== 'visible';
	}

	isValueVisible(key: string): boolean {
		const canonicalKey = this.canonicalKey(key);
		return !this.#isManagedValue(canonicalKey) || this.state.canReadOwned(valueToken(canonicalKey));
	}

	isRelationshipKeyVisible(to: string, key: string): boolean {
		const canonicalTo = this.canonicalKey(to);
		if (!this.#isManagedRelationship(canonicalTo)) return true;
		const id = this.#resolveRelationshipId(canonicalTo, this.canonicalKey(key));
		return id !== undefined && this.filterRelationshipIds(canonicalTo, [id]).length !== 0;
	}

	filterRelationshipIds(to: string, ids: readonly string[]): string[] {
		const canonicalTo = this.canonicalKey(to);
		if (!this.#isManagedRelationship(canonicalTo)) return [...ids];
		if (this.state.lifecycle !== 'active') return [];
		const clearFence = this.state.ownedVisibilityOf(relationshipClearToken(canonicalTo))?.fence ?? 0;
		return ids.filter(id => {
			const relationship = this.state.ownedVisibilityOf(relationshipToken(canonicalTo, id));
			const entity = this.state.ownedVisibilityOf(valueToken(this.relationshipEntityKeyFromCanonical(canonicalTo, id)));
			return (
				relationship?.state === 'visible' &&
				relationship.fence > clearFence &&
				entity?.state === 'visible' &&
				(!relationship.causal || entity.fence >= relationship.fence)
			);
		});
	}

	relationshipEntityKey(to: string, id: string): string {
		return this.relationshipEntityKeyFromCanonical(this.canonicalKey(to), id);
	}

	/** Resolves a relationship entity from a key that was canonicalized during staging. @internal */
	relationshipEntityKeyCanonical(to: string, id: string): string {
		return this.relationshipEntityKeyFromCanonical(to, id);
	}

	preserveValueUnknown(key: string, position: CausalPosition | VisibilityScope): boolean {
		return this.state.preserveUnknown(valueToken(this.canonicalKey(key)), position);
	}

	claimValueDelete(key: string, cut: SnapshotCut, supersessionTarget?: string): DeleteClaim | undefined {
		return this.state.claimDelete(valueToken(this.canonicalKey(key)), cut, supersessionTarget);
	}

	supersedeValueDelete(key: string, position: CausalPosition): boolean {
		return this.state.supersedeDelete(valueToken(this.canonicalKey(key)), position);
	}

	isDeleteClaimCurrent(claim: DeleteClaim): boolean {
		return this.state.isDeleteClaimCurrent(claim);
	}

	/** @internal */
	isExecutingDeleteCurrent(claim: DeleteClaim): boolean {
		return this.state.isExecutingDeleteCurrent(claim);
	}

	/** @internal */
	abortPhysicalDeleteBeforeMutation(claim: DeleteClaim): boolean {
		return this.state.abortPhysicalDeleteBeforeMutation(claim);
	}

	isCurrentContextAdmitted(): boolean {
		const context = this.currentGatewayContext();
		return !context?.deleteClaim || this.state.isDeleteClaimCurrent(context.deleteClaim);
	}

	releaseDeleteClaim(claim: DeleteClaim): boolean {
		return this.state.releaseDeleteClaim(claim);
	}

	beginPhysicalDelete(claim: DeleteClaim): boolean {
		return this.state.beginPhysicalDelete(claim);
	}

	completePhysicalDelete(claim: DeleteClaim, succeeded: boolean): void {
		this.state.completeDelete(claim, succeeded);
	}

	private relationshipEntityKeyFromCanonical(to: string, id: string): string {
		const separator = to.indexOf('.');
		const namespace = separator === -1 ? to : to.slice(0, separator);
		return this.#guildRelatedNamespaces.has(namespace) ? `${namespace}.${id}` : `${to}.${id}`;
	}

	private planMutation(
		stateKey: string,
		lock: string,
		target: AdapterMutationTarget,
		position: CausalPosition | undefined,
	): PlannedMutation {
		const context = this.currentGatewayContext();
		if (
			context?.deleteClaim &&
			target.kind === 'value' &&
			target.operation === 'remove' &&
			stateKey === context.deleteClaim.key
		) {
			return this.state.isDeleteClaimCurrent(context.deleteClaim)
				? { claim: context.deleteClaim, kind: 'claim', lock, physicallyRemoved: true }
				: { kind: 'denied', lock };
		}
		let admission = this.options.resolveAdmission
			? this.options.resolveAdmission(target, context)
			: this.legacyAdmission(target, position);
		if (admission.kind === 'unmanaged') {
			const hintedScope = this.#ownershipHints.get()?.get(stateKey);
			const existingScope = this.state.ownedScopeOf(stateKey);
			const scope = hintedScope ?? existingScope;
			if (scope) admission = { kind: 'tracked', scope };
		}
		if (admission.kind !== 'tracked') return { kind: admission.kind, lock };
		const scope = admission.scope;
		if (position && scope.kind === 'shard' && position.generation !== scope) {
			throw new Error('The task-local causal position belongs to a different shard generation.');
		}
		return { kind: 'tracked', lock, state: { generation: scope, key: stateKey, position } };
	}

	private stageWritePlans(plans: readonly PlannedMutation[]): StagedMutationAttempt<WriteAttempt>[] {
		const resolved = plans.flatMap(plan => (plan.kind === 'tracked' ? [plan.state] : []));
		if (resolved.length === 0) return plans.map(plan => (plan.kind === 'denied' ? 'denied' : undefined));
		const staged = this.state.stageWriteBatch(resolved);
		let index = 0;
		return plans.map(plan => {
			if (plan.kind === 'denied') return 'denied';
			return plan.kind === 'tracked' ? staged[index++]! : undefined;
		});
	}

	private stageRemovePlans(
		plans: readonly PlannedMutation[],
	): StagedMutationAttempt<RemoveAttempt | StagedRemoveClaim>[] {
		const resolved = plans.flatMap(plan => (plan.kind === 'tracked' ? [plan.state] : []));
		if (resolved.length === 0) {
			return plans.map(plan => {
				if (plan.kind === 'denied') return 'denied';
				return plan.kind === 'claim'
					? { claim: plan.claim, kind: 'claim', physicallyRemoved: plan.physicallyRemoved }
					: undefined;
			});
		}
		const staged = this.state.stageRemoveBatch(resolved);
		let index = 0;
		return plans.map(plan => {
			if (plan.kind === 'denied') return 'denied';
			if (plan.kind === 'claim') {
				return { claim: plan.claim, kind: 'claim', physicallyRemoved: plan.physicallyRemoved };
			}
			return plan.kind === 'tracked' ? staged[index++]! : undefined;
		});
	}

	private toStagedRemoves(
		attempts: readonly StagedMutationAttempt<RemoveAttempt | StagedRemoveClaim>[],
	): StagedMutationAttempt<readonly StagedRemoveAttempt[]>[] {
		return attempts.map(attempt => {
			if (attempt === undefined || attempt === 'denied') return attempt;
			return isStagedRemoveClaim(attempt)
				? [{ claim: attempt.claim, kind: 'claim', physicallyRemoved: attempt.physicallyRemoved }]
				: [{ attempt, kind: 'remove', physicallyRemoved: true }];
		});
	}

	private currentPosition(): CausalPosition | undefined {
		const context = this.#context.get();
		return context && 'position' in context ? context.position : context;
	}

	private currentGatewayContext(): GatewayMutationContext | undefined {
		const context = this.#context.get();
		return context && 'position' in context ? context : undefined;
	}

	private legacyAdmission(
		target: AdapterMutationTarget,
		position: CausalPosition | undefined,
	): AdapterMutationAdmission {
		const scope = this.options.resolveScope?.(target, position);
		return scope ? { kind: 'tracked', scope } : { kind: 'unmanaged' };
	}
}
