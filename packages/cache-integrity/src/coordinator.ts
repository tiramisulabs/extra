import type { Adapter } from 'seyfert';
import type { AdapterReconciliationController } from './adapter-controller';
import type {
	DeleteClaim,
	FlushAttempt,
	ReconciliationState,
	RemoveAttempt,
	ShardGeneration,
	WriteAttempt,
} from './reconciliation-state';

export interface ReconciliationCoordinator {
	readonly kind: string;
	start(): void | Promise<void>;
	close(): void | Promise<void>;
}

/** @internal */
export interface CoordinatedReadRequest {
	readonly args: readonly unknown[];
	readonly generation?: ShardGeneration;
	readonly guard?: DeleteClaim;
	readonly kind: 'bulk-get' | 'contains' | 'count' | 'get' | 'keys' | 'relationship-ids' | 'scan' | 'values';
	readonly unfiltered: boolean;
}

/** @internal */
export interface CoordinatedMutationEntry<T> {
	readonly attempt?: T;
	readonly value: unknown;
}

/** @internal */
export type CoordinatedMutationRequest =
	| {
			readonly entries: readonly CoordinatedMutationEntry<WriteAttempt>[];
			readonly kind: 'value-write';
			readonly operation: 'patch' | 'set';
	  }
	| {
			readonly entries: readonly CoordinatedMutationEntry<RemoveAttempt | DeleteClaim>[];
			readonly guard?: DeleteClaim;
			readonly kind: 'value-remove';
	  }
	| {
			readonly entries: readonly CoordinatedMutationEntry<WriteAttempt>[];
			readonly kind: 'relationship-add';
	  }
	| {
			readonly entries: readonly CoordinatedMutationEntry<RemoveAttempt | DeleteClaim>[];
			readonly guard?: DeleteClaim;
			readonly kind: 'relationship-remove';
	  }
	| {
			readonly entries: readonly CoordinatedMutationEntry<RemoveAttempt | DeleteClaim>[];
			readonly guard?: DeleteClaim;
			readonly kind: 'relationship-clear';
	  }
	| {
			readonly attempt?: FlushAttempt;
			readonly kind: 'flush';
	  }
	| {
			readonly claim: DeleteClaim;
			readonly key: string;
			readonly kind: 'claimed-delete';
			readonly relationship?: { readonly id: string; readonly to: string };
	  };

/** @internal */
export interface CoordinatedMutationResult {
	readonly admitted: readonly boolean[];
}

/** @internal */
export interface CoordinatedStorage {
	read(request: CoordinatedReadRequest): Promise<unknown>;
	mutate(request: CoordinatedMutationRequest): Promise<CoordinatedMutationResult>;
}

/** @internal */
export interface CoordinatorBinding {
	readonly storage?: CoordinatedStorage;
	commitGeneration?(generation: ShardGeneration): Promise<void>;
	deactivate?(): void | Promise<void>;
	stageReady?(generation: ShardGeneration): void;
	stageResumed?(generation: ShardGeneration | undefined): void;
}

/** @internal */
export interface CoordinatorBindInput {
	readonly adapter: Adapter;
	readonly controller: AdapterReconciliationController;
	readonly onTerminal: (code: string, error: unknown) => void;
	readonly state: ReconciliationState;
}

/** @internal */
export interface BindableReconciliationCoordinator extends ReconciliationCoordinator {
	bind?(input: CoordinatorBindInput): CoordinatorBinding;
}

/** @internal */
export function bindCoordinator(
	coordinator: ReconciliationCoordinator,
	input: CoordinatorBindInput,
): CoordinatorBinding | undefined {
	return (coordinator as BindableReconciliationCoordinator).bind?.(input);
}
