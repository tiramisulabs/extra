import {
	type CausalPosition,
	type DeleteClaim,
	type DeleteCompletion,
	type FlushAttempt,
	type GenerationStatus,
	GLOBAL_VISIBILITY_SCOPE,
	type GuildTerminalOutcome,
	type ReconciliationLifecycle,
	type ReconciliationWork,
	type RemoveAttempt,
	type ShardGeneration,
	type SnapshotCompleteness,
	type SnapshotCut,
	sameVisibilityScope,
	type Visibility,
	type VisibilityRecord,
	type VisibilityScope,
	type WriteAttempt,
	type WriteCompletion,
} from './reconciliation-types';

export * from './reconciliation-types';

interface MutableGeneration {
	committed: boolean;
	expectedGuildIds: Set<string>;
	guildOutcomes: Map<string, GuildTerminalOutcome>;
	latestSequence: number;
	ref: ShardGeneration;
	startupWork: ReconciliationWork;
	streamFinished: boolean;
}

interface MutableVisibilityRecord {
	activeDeleteClaim?: number;
	activeRemoveAttempt?: number;
	causal?: boolean;
	fence: number;
	generation: VisibilityScope;
	physicallyDeleted?: boolean;
	retentionGenerations?: ReadonlySet<ShardGeneration>;
	state: Visibility;
}

interface MutableDeleteClaim {
	deleteEpoch: number;
	handle: DeleteClaim;
	phase: WorkPhase;
	previousVisibility?: MutableVisibilityRecord;
	work: ReconciliationWork;
}

interface MutableRemoveAttempt {
	handle: RemoveAttempt;
	phase: WorkPhase;
	previousVisibility?: MutableVisibilityRecord;
	work: ReconciliationWork;
}

interface MutableFlushAttempt {
	handle: FlushAttempt;
	phase: WorkPhase;
	work: ReconciliationWork;
}

interface MutableWriteAttempt {
	createdOwnership: boolean;
	handle: WriteAttempt;
	phase: WorkPhase;
	work: ReconciliationWork;
}

interface MutableWork {
	handle: ReconciliationWork;
	phase: WorkPhase;
}

type WorkPhase = 'executing' | 'queued';

type KeyOwnership = { readonly kind: 'global' } | { readonly kind: 'shard'; readonly shardId: number };

interface StagingInput {
	readonly generation: VisibilityScope;
	readonly key: string;
	readonly position?: CausalPosition;
}

/**
 * Pure ownership, startup-barrier, work, and visibility state. Its sole causal
 * ordering mechanism is the monotonic fence issued here for each observation;
 * a Gateway sequence is only generation-local metadata validation. It has no
 * knowledge of Seyfert adapters, Gateway payloads, or Redis storage.
 *
 * @internal
 */
export class ReconciliationState {
	#activeDeletes = new Map<number, MutableDeleteClaim>();
	#activeFlushes = new Map<number, MutableFlushAttempt>();
	#activeRemoves = new Map<number, MutableRemoveAttempt>();
	#deleteEpoch = 0;
	#destructiveFloor = 0;
	#generations = new Map<number, MutableGeneration>();
	#issuedGenerations = new WeakSet<ShardGeneration>();
	#keyOwnership = new Map<string, KeyOwnership>();
	#lifecycle: ReconciliationLifecycle = 'installing';
	#nextFence = 0;
	#nextGenerationId = 0;
	#nextOperationId = 0;
	#pendingWork = new Map<number, MutableWork>();
	#positions = new WeakSet<CausalPosition>();
	#snapshotCuts = new Map<number, Map<string, SnapshotCut>>();
	#visibility = new Map<string, MutableVisibilityRecord>();
	#waiters = new Set<() => void>();
	#waitingForReady = new Set<number>();
	#writeAttempts = new Map<string, Map<number, MutableWriteAttempt>>();

	get lifecycle(): ReconciliationLifecycle {
		return this.#lifecycle;
	}

	get pendingWork(): number {
		return this.#pendingWork.size;
	}

	activate(): void {
		if (this.#lifecycle !== 'installing') {
			throw new Error(`Cannot activate reconciliation state from ${this.#lifecycle}.`);
		}
		this.#lifecycle = 'active';
	}

	fail(): void {
		if (this.#lifecycle === 'closing' || this.#lifecycle === 'closed') return;
		this.#lifecycle = 'failed';
		this.#deleteEpoch++;
		this.cancelQueuedWork();
	}

	beginClosing(): void {
		if (this.#lifecycle === 'closing' || this.#lifecycle === 'closed') return;
		if (this.#lifecycle !== 'active' && this.#lifecycle !== 'failed') {
			throw new Error(`Cannot close reconciliation state from ${this.#lifecycle}.`);
		}
		this.#lifecycle = 'closing';
		this.#deleteEpoch++;
		this.cancelQueuedWork();
	}

	finishClosing(): void {
		if (this.#lifecycle === 'closed') return;
		if (this.#lifecycle !== 'closing') {
			throw new Error(`Cannot finish closing reconciliation state from ${this.#lifecycle}.`);
		}
		if (this.#pendingWork.size !== 0) {
			throw new Error('Cannot close reconciliation state while work is pending.');
		}
		this.#lifecycle = 'closed';
	}

	openGeneration(input: {
		expectedGuildIds: Iterable<string>;
		sequence: number;
		sessionId: string;
		shardId: number;
	}): ShardGeneration {
		this.assertActive();
		const expectedGuildIds = new Set(input.expectedGuildIds);
		const ref = Object.freeze({
			id: ++this.#nextGenerationId,
			kind: 'shard' as const,
			sessionId: input.sessionId,
			shardId: input.shardId,
		});
		this.#issuedGenerations.add(ref);
		const startupWork = this.createWork('startup-barrier', ref, `READY shard ${input.shardId}`);
		const previous = this.#generations.get(input.shardId);
		this.#generations.set(input.shardId, {
			committed: false,
			expectedGuildIds,
			guildOutcomes: new Map(),
			latestSequence: input.sequence,
			ref,
			startupWork,
			streamFinished: false,
		});
		this.#snapshotCuts.set(input.shardId, new Map());
		if (previous) this.retireGeneration(previous);
		this.#waitingForReady.delete(input.shardId);
		return ref;
	}

	activeGeneration(shardId: number): ShardGeneration | undefined {
		return this.#generations.get(shardId)?.ref;
	}

	isCurrentGeneration(generation: ShardGeneration): boolean {
		const current = this.#generations.get(generation.shardId)?.ref;
		return this.#issuedGenerations.has(generation) && current === generation;
	}

	resume(shardId: number, sequence: number): ShardGeneration | undefined {
		this.assertActive();
		const generation = this.#generations.get(shardId);
		if (!generation) {
			this.#waitingForReady.add(shardId);
			return;
		}
		this.updateSequence(generation, sequence);
		return generation.ref;
	}

	isAwaitingReady(shardId: number): boolean {
		return this.#waitingForReady.has(shardId);
	}

	observePacket(generation: ShardGeneration, sequence: number): CausalPosition {
		this.assertActive();
		const current = this.requireGeneration(generation);
		this.updateSequence(current, sequence);
		const position = Object.freeze({ fence: this.nextFence(), generation, sequence });
		this.#positions.add(position);
		return position;
	}

	beginSnapshot(
		generation: ShardGeneration,
		sequence: number,
		target: { completeness: SnapshotCompleteness; guildId: string; resource: string; supersessionTarget?: string },
	): SnapshotCut {
		return this.recordSnapshot(this.observePacket(generation, sequence), target);
	}

	recordSnapshot(
		position: CausalPosition,
		target: { completeness: SnapshotCompleteness; guildId: string; resource: string; supersessionTarget?: string },
	): SnapshotCut {
		this.assertActive();
		this.assertPosition(position);
		const cut = Object.freeze({ ...position, ...target });
		this.#positions.add(cut);
		const cuts = this.#snapshotCuts.get(position.generation.shardId)!;
		const key = this.snapshotKey(target.guildId, target.resource, target.supersessionTarget);
		const current = cuts.get(key);
		if (!current || current.fence < cut.fence) {
			cuts.set(key, cut);
			this.cancelSupersededSnapshotDeletes(cut);
		}
		return cut;
	}

	latestSnapshotCut(
		generation: ShardGeneration,
		target: { guildId: string; resource: string; supersessionTarget?: string },
	): SnapshotCut | undefined {
		this.requireGeneration(generation);
		return this.#snapshotCuts
			.get(generation.shardId)
			?.get(this.snapshotKey(target.guildId, target.resource, target.supersessionTarget));
	}

	markGuildOutcome(generation: ShardGeneration, guildId: string, outcome: GuildTerminalOutcome): boolean {
		this.assertActive();
		const current = this.requireGeneration(generation);
		if (!current.expectedGuildIds.has(guildId)) {
			throw new Error(`Guild ${guildId} is not part of this READY snapshot.`);
		}
		const existing = current.guildOutcomes.get(guildId);
		if (existing && existing !== outcome) {
			throw new Error(`Guild ${guildId} already has terminal outcome ${existing}.`);
		}
		current.guildOutcomes.set(guildId, outcome);
		return this.maybeCommit(current);
	}

	markGuildsReady(generation: ShardGeneration): boolean {
		this.assertActive();
		const current = this.requireGeneration(generation);
		current.streamFinished = true;
		return this.maybeCommit(current);
	}

	generationStatus(generation: ShardGeneration): GenerationStatus {
		const current = this.requireGeneration(generation);
		return {
			committed: current.committed,
			expectedGuildIds: [...current.expectedGuildIds],
			guildOutcomes: Object.fromEntries(current.guildOutcomes),
			latestSequence: current.latestSequence,
			sessionId: current.ref.sessionId,
			shardId: current.ref.shardId,
			streamFinished: current.streamFinished,
		};
	}

	hasExpectedGuild(generation: ShardGeneration, guildId: string): boolean {
		return this.requireGeneration(generation).expectedGuildIds.has(guildId);
	}

	registerWork(input: { generation?: ShardGeneration; label?: string } = {}): ReconciliationWork {
		this.assertActive();
		if (input.generation) this.requireGeneration(input.generation);
		return this.createWork('reconciliation', input.generation, input.label);
	}

	beginWork(work: ReconciliationWork): boolean {
		const active = this.#pendingWork.get(work.id);
		if (active?.handle !== work || active.phase !== 'queued' || this.#lifecycle !== 'active') return false;
		if (work.generation && !this.isCurrentGeneration(work.generation)) return false;
		active.phase = 'executing';
		return true;
	}

	settleWork(work: ReconciliationWork): boolean {
		const active = this.#pendingWork.get(work.id);
		if (active?.handle !== work || active.phase !== 'executing') return false;
		return this.removeWork(work);
	}

	waitForIdle(): Promise<void> {
		if (this.#pendingWork.size === 0) return Promise.resolve();
		return new Promise(resolve => this.#waiters.add(resolve));
	}

	stageWrite(key: string, position: CausalPosition | ShardGeneration): WriteAttempt {
		const generation = 'fence' in position ? position.generation : position;
		if (generation.kind !== 'shard') throw new Error('Shard writes require a shard generation.');
		return this.stageWriteBatch([{ generation, key, position: 'fence' in position ? position : undefined }])[0]!;
	}

	stageGlobalWrite(key: string, position?: CausalPosition): WriteAttempt {
		return this.stageWriteBatch([{ generation: GLOBAL_VISIBILITY_SCOPE, key, position }])[0]!;
	}

	/** Atomically validates every input before creating queued attempts. @internal */
	stageWriteBatch(inputs: readonly StagingInput[]): WriteAttempt[] {
		this.preflightStaging(inputs);
		return inputs.map(input => {
			const createdOwnership = !this.#keyOwnership.has(input.key);
			this.establishKeyScope(input.key, input.generation);
			return this.createWriteAttempt(
				input.key,
				input.generation,
				input.position?.fence ?? this.nextFence(),
				input.position?.generation,
				input.position !== undefined,
				createdOwnership,
			);
		});
	}

	private createWriteAttempt(
		key: string,
		generation: VisibilityScope,
		fence: number,
		origin?: ShardGeneration,
		causal = false,
		createdOwnership = false,
	): WriteAttempt {
		const id = ++this.#nextOperationId;
		const work = this.createWork('write', origin ?? (generation.kind === 'shard' ? generation : undefined), key);
		const attempt = Object.freeze({
			causal,
			fence,
			generation,
			id,
			key,
			origin,
		});
		let attempts = this.#writeAttempts.get(key);
		if (!attempts) {
			attempts = new Map();
			this.#writeAttempts.set(key, attempts);
		}
		attempts.set(attempt.id, { createdOwnership, handle: attempt, phase: 'queued', work });
		return attempt;
	}

	beginWrite(attempt: WriteAttempt): boolean {
		const active = this.#writeAttempts.get(attempt.key)?.get(attempt.id);
		if (active?.handle !== attempt || active.phase !== 'queued') return false;
		const current = this.recordFor(attempt.key, attempt.generation);
		const fencedByDestruction = attempt.fence <= this.#destructiveFloor;
		const admitted =
			this.#lifecycle === 'active' &&
			this.isCurrentScope(attempt.generation) &&
			(attempt.origin === undefined || this.isCurrentGeneration(attempt.origin)) &&
			!fencedByDestruction &&
			(current?.fence ?? 0) <= attempt.fence &&
			this.latestWriteFence(attempt.key, attempt.generation) <= attempt.fence;
		if (!admitted) {
			this.cancelWrite(attempt, fencedByDestruction);
			return false;
		}
		if (current?.activeDeleteClaim && !this.cancelDelete(current.activeDeleteClaim)) {
			this.cancelWrite(attempt);
			return false;
		}
		if (current?.activeRemoveAttempt && !this.cancelRemove(current.activeRemoveAttempt)) {
			this.cancelWrite(attempt);
			return false;
		}
		if (!this.beginWork(active.work)) {
			this.cancelWrite(attempt);
			return false;
		}
		active.phase = 'executing';
		return true;
	}

	completeWrite(attempt: WriteAttempt, succeeded: boolean): WriteCompletion {
		return this.settleWrite(attempt, succeeded ? 'committed' : 'ambiguous');
	}

	/** Completes an attempt that was atomically rejected before storage mutation. @internal */
	rejectWrite(attempt: WriteAttempt): WriteCompletion {
		return this.settleWrite(attempt, 'rejected');
	}

	private settleWrite(attempt: WriteAttempt, outcome: 'ambiguous' | 'committed' | 'rejected'): WriteCompletion {
		const attempts = this.#writeAttempts.get(attempt.key);
		if (!attempts) return 'superseded';
		const active = attempts.get(attempt.id);
		if (active?.handle !== attempt || active.phase !== 'executing') return 'superseded';
		attempts.delete(attempt.id);
		if (attempts.size === 0) this.#writeAttempts.delete(attempt.key);
		this.settleWork(active.work);
		if (outcome === 'ambiguous') {
			const current = this.recordForOwner(attempt.key, attempt.generation);
			if (!current || current.fence <= attempt.fence) {
				this.#visibility.set(attempt.key, {
					fence: attempt.fence,
					generation: attempt.generation,
					state: 'unknown-preserved',
				});
			}
			return this.finishWriteAttempt(attempt.key, 'failed');
		}
		if (outcome === 'rejected') return this.finishWriteAttempt(attempt.key, 'failed');
		if (
			this.#lifecycle !== 'active' ||
			!this.isCurrentScope(attempt.generation) ||
			(attempt.origin !== undefined && !this.isCurrentGeneration(attempt.origin)) ||
			attempt.fence <= this.#destructiveFloor
		) {
			return this.finishWriteAttempt(attempt.key, 'stale');
		}

		const current = this.recordForOwner(attempt.key, attempt.generation);
		if (current && current.fence > attempt.fence) {
			return this.finishWriteAttempt(attempt.key, 'superseded');
		}
		if (current?.activeDeleteClaim && current.fence < attempt.fence) {
			this.cancelDelete(current.activeDeleteClaim);
		}
		this.#visibility.set(attempt.key, {
			causal: attempt.causal,
			fence: attempt.fence,
			generation: attempt.generation,
			state: 'visible',
		});
		return this.finishWriteAttempt(attempt.key, 'committed');
	}

	preserveUnknown(key: string, position: CausalPosition | VisibilityScope): boolean {
		this.assertActive();
		const generation = 'fence' in position ? position.generation : position;
		this.assertCurrentScope(generation);
		if ('fence' in position) this.assertPosition(position);
		const fence = 'fence' in position ? position.fence : this.nextFence();
		if (fence <= this.#destructiveFloor) return false;
		if (!this.canUseKeyScope(key, generation)) return false;
		this.establishKeyScope(key, generation);
		if (this.latestEvidenceFence(key, generation) > fence) return false;
		const current = this.recordForOwner(key, generation);
		if (current?.activeDeleteClaim && !this.cancelDelete(current.activeDeleteClaim)) return false;
		if (current?.activeRemoveAttempt && !this.cancelRemove(current.activeRemoveAttempt)) return false;
		this.#visibility.set(key, {
			fence,
			generation,
			state: 'unknown-preserved',
		});
		return true;
	}

	visibilityOf(key: string, generation: VisibilityScope): VisibilityRecord | undefined {
		const current = this.recordFor(key, generation);
		if (!current || !this.isCurrentScope(generation)) return;
		return this.toVisibilityRecord(current);
	}

	/** Resolves visibility through the key's established owner. @internal */
	ownedVisibilityOf(key: string): VisibilityRecord | undefined {
		const current = this.#visibility.get(key);
		if (!current || !this.isCurrentScope(current.generation)) return;
		return this.toVisibilityRecord(current);
	}

	ownedScopeOf(key: string): VisibilityScope | undefined {
		const current = this.#visibility.get(key);
		return current && this.isCurrentScope(current.generation) ? current.generation : undefined;
	}

	canRead(key: string, generation: VisibilityScope): boolean {
		return this.#lifecycle === 'active' && this.visibilityOf(key, generation)?.state === 'visible';
	}

	/** Resolves read admission through the key's established owner. @internal */
	canReadOwned(key: string): boolean {
		return this.#lifecycle === 'active' && this.ownedVisibilityOf(key)?.state === 'visible';
	}

	stageRemove(key: string, position: CausalPosition | ShardGeneration): RemoveAttempt {
		const generation = 'fence' in position ? position.generation : position;
		if (generation.kind !== 'shard') throw new Error('Shard removes require a shard generation.');
		return this.stageRemoveBatch([{ generation, key, position: 'fence' in position ? position : undefined }])[0]!;
	}

	stageGlobalRemove(key: string, position?: CausalPosition): RemoveAttempt {
		return this.stageRemoveBatch([{ generation: GLOBAL_VISIBILITY_SCOPE, key, position }])[0]!;
	}

	/** Atomically validates every input before hiding any key. @internal */
	stageRemoveBatch(inputs: readonly StagingInput[]): RemoveAttempt[] {
		this.preflightStaging(inputs);
		return inputs.map(input => {
			this.establishKeyScope(input.key, input.generation);
			return this.createRemoveAttempt(
				input.key,
				input.generation,
				input.position?.fence ?? this.nextFence(),
				input.generation.kind === 'global' ? this.snapshotCurrentGenerations() : new Set([input.generation]),
				input.position?.generation,
			);
		});
	}

	private createRemoveAttempt(
		key: string,
		generation: VisibilityScope,
		fence: number,
		retentionGenerations: ReadonlySet<ShardGeneration>,
		origin?: ShardGeneration,
	): RemoveAttempt {
		const current = this.recordForOwner(key, generation);
		if (current?.activeDeleteClaim) this.cancelDelete(current.activeDeleteClaim);
		if (current?.activeRemoveAttempt) this.cancelRemove(current.activeRemoveAttempt);

		const id = ++this.#nextOperationId;
		const work = this.createWork('remove', origin ?? (generation.kind === 'shard' ? generation : undefined), key);
		const handle = Object.freeze({
			fence,
			generation,
			id,
			key,
			origin,
		});
		this.#activeRemoves.set(id, {
			handle,
			phase: 'queued',
			previousVisibility: current ? this.copyVisibility(current) : undefined,
			work,
		});
		if ((current?.fence ?? 0) <= fence && this.latestWriteFence(key, generation) <= fence) {
			this.#visibility.set(key, {
				activeRemoveAttempt: id,
				fence,
				generation,
				retentionGenerations,
				state: 'hidden-pending',
			});
		}
		return handle;
	}

	beginRemove(attempt: RemoveAttempt): boolean {
		const active = this.#activeRemoves.get(attempt.id);
		if (active?.handle !== attempt || active.phase !== 'queued') return false;
		const current = this.recordFor(attempt.key, attempt.generation);
		const admitted =
			this.#lifecycle === 'active' &&
			this.isCurrentScope(attempt.generation) &&
			(attempt.origin === undefined || this.isCurrentGeneration(attempt.origin)) &&
			current?.state === 'hidden-pending' &&
			current.activeRemoveAttempt === attempt.id &&
			current.fence === attempt.fence &&
			this.latestWriteFence(attempt.key, attempt.generation) <= attempt.fence;
		if (!admitted || !this.beginWork(active.work)) {
			this.cancelRemove(attempt.id);
			return false;
		}
		active.phase = 'executing';
		return true;
	}

	completeRemove(attempt: RemoveAttempt, succeeded: boolean): DeleteCompletion {
		const active = this.#activeRemoves.get(attempt.id);
		if (active?.handle !== attempt || active.phase !== 'executing') return 'stale';
		const current = this.recordForOwner(attempt.key, attempt.generation);
		const stillOwned = current?.activeRemoveAttempt === attempt.id;
		this.#activeRemoves.delete(attempt.id);
		this.settleWork(active.work);
		if (!stillOwned) return 'stale';
		delete current.activeRemoveAttempt;
		if (succeeded) {
			current.physicallyDeleted = true;
			this.maybeCollectKey(attempt.key);
		} else {
			delete current.physicallyDeleted;
		}
		return succeeded ? 'completed' : 'failed';
	}

	stageFlush(): FlushAttempt {
		this.assertActive();
		const fence = this.nextFence();
		this.#destructiveFloor = Math.max(this.#destructiveFloor, fence);
		const retentionGenerations = this.snapshotCurrentGenerations();
		const id = ++this.#nextOperationId;
		const work = this.createWork('flush', undefined, 'adapter flush');
		const handle = Object.freeze({ fence, id });
		this.#activeFlushes.set(id, { handle, phase: 'queued', work });

		for (const [key, current] of this.#visibility) {
			if (current.activeDeleteClaim) this.cancelDelete(current.activeDeleteClaim);
			if (current.activeRemoveAttempt) this.cancelRemove(current.activeRemoveAttempt);
			if (current.fence <= fence) {
				this.#visibility.set(key, {
					fence,
					generation: current.generation,
					retentionGenerations,
					state: 'hidden-pending',
				});
			}
		}
		for (const [key, attempts] of this.#writeAttempts) {
			const latest = [...attempts.values()].reduce<MutableWriteAttempt | undefined>(
				(selected, attempt) => (!selected || attempt.handle.fence > selected.handle.fence ? attempt : selected),
				undefined,
			);
			if (latest && latest.handle.fence <= fence && this.isCurrentScope(latest.handle.generation)) {
				this.#visibility.set(key, {
					fence,
					generation: latest.handle.generation,
					retentionGenerations,
					state: 'hidden-pending',
				});
			}
		}
		return handle;
	}

	beginFlush(attempt: FlushAttempt): boolean {
		const active = this.#activeFlushes.get(attempt.id);
		if (active?.handle !== attempt || active.phase !== 'queued' || this.#lifecycle !== 'active') return false;
		if (!this.beginWork(active.work)) return false;
		active.phase = 'executing';
		return true;
	}

	completeFlush(attempt: FlushAttempt, succeeded: boolean): DeleteCompletion {
		const active = this.#activeFlushes.get(attempt.id);
		if (active?.handle !== attempt || active.phase !== 'executing') return 'stale';
		this.#activeFlushes.delete(attempt.id);
		this.settleWork(active.work);
		if (succeeded) {
			for (const [key, current] of this.#visibility) {
				if (current.state === 'hidden-pending' && current.fence === attempt.fence) {
					current.physicallyDeleted = true;
					this.maybeCollectKey(key);
				}
			}
		}
		return succeeded ? 'completed' : 'failed';
	}

	claimDelete(
		key: string,
		cut: SnapshotCut,
		supersessionTarget = cut.supersessionTarget ?? key,
	): DeleteClaim | undefined {
		this.assertActive();
		this.assertPosition(cut);
		if (cut.completeness !== 'authoritative' || !this.isCurrentSnapshotCut(cut, supersessionTarget)) return;
		if (!this.canUseKeyScope(key, cut.generation)) return;
		const current = this.recordForOwner(key, cut.generation);
		if (current?.activeDeleteClaim) return;
		if (current?.state === 'unknown-preserved' && current.fence >= cut.fence) return;
		if ((current?.fence ?? 0) > cut.fence || this.latestWriteFence(key, cut.generation) > cut.fence) return;
		this.establishKeyScope(key, cut.generation);

		const id = ++this.#nextOperationId;
		const work = this.createWork('physical-delete', cut.generation, key);
		const handle = Object.freeze({
			cut,
			fence: cut.fence,
			generation: cut.generation,
			id,
			key,
			supersessionTarget,
		});
		const claim: MutableDeleteClaim = {
			deleteEpoch: this.#deleteEpoch,
			handle,
			phase: 'queued',
			previousVisibility: current ? this.copyVisibility(current) : undefined,
			work,
		};
		this.#activeDeletes.set(id, claim);
		this.#visibility.set(key, {
			activeDeleteClaim: id,
			fence: cut.fence,
			generation: cut.generation,
			retentionGenerations: new Set([cut.generation]),
			state: 'hidden-pending',
		});
		return handle;
	}

	isDeleteClaimCurrent(claim: DeleteClaim): boolean {
		const active = this.#activeDeletes.get(claim.id);
		if (
			active?.handle !== claim ||
			active.phase !== 'queued' ||
			this.#lifecycle !== 'active' ||
			active.deleteEpoch !== this.#deleteEpoch ||
			!this.isCurrentGeneration(claim.generation)
		) {
			return false;
		}
		const record = this.recordFor(claim.key, claim.generation);
		return (
			record?.state === 'hidden-pending' &&
			record.activeDeleteClaim === claim.id &&
			record.fence === claim.fence &&
			this.isCurrentSnapshotCut(claim.cut, claim.supersessionTarget) &&
			this.latestWriteFence(claim.key, claim.generation) <= claim.fence
		);
	}

	/** Cancels an executing remove before its physical mutation was sent. @internal */
	abortRemoveBeforeMutation(attempt: RemoveAttempt): boolean {
		const active = this.#activeRemoves.get(attempt.id);
		if (active?.handle !== attempt || active.phase !== 'executing') return false;
		const current = this.recordFor(attempt.key, attempt.generation);
		this.#activeRemoves.delete(attempt.id);
		this.settleWork(active.work);
		if (current?.activeRemoveAttempt === attempt.id) {
			if (active.previousVisibility) this.#visibility.set(attempt.key, active.previousVisibility);
			else this.#visibility.delete(attempt.key);
		}
		return true;
	}

	/** Revalidates a claimed delete after an awaited distributed ownership check. @internal */
	isExecutingDeleteCurrent(claim: DeleteClaim): boolean {
		const active = this.#activeDeletes.get(claim.id);
		if (
			active?.handle !== claim ||
			active.phase !== 'executing' ||
			this.#lifecycle !== 'active' ||
			active.deleteEpoch !== this.#deleteEpoch ||
			!this.isCurrentGeneration(claim.generation) ||
			!this.isCurrentSnapshotCut(claim.cut, claim.supersessionTarget)
		) {
			return false;
		}
		const record = this.recordFor(claim.key, claim.generation);
		return (
			record?.state === 'hidden-pending' &&
			record.activeDeleteClaim === claim.id &&
			record.fence === claim.fence &&
			this.latestWriteFence(claim.key, claim.generation) <= claim.fence
		);
	}

	/** Cancels an executing claim before its physical mutation was sent. @internal */
	abortPhysicalDeleteBeforeMutation(claim: DeleteClaim): boolean {
		const active = this.#activeDeletes.get(claim.id);
		if (active?.handle !== claim || active.phase !== 'executing') return false;
		const record = this.recordFor(claim.key, claim.generation);
		this.#activeDeletes.delete(claim.id);
		this.settleWork(active.work);
		if (record?.activeDeleteClaim === claim.id) {
			if (active.previousVisibility) this.#visibility.set(claim.key, active.previousVisibility);
			else this.#visibility.delete(claim.key);
		}
		return true;
	}

	supersedeDelete(key: string, position: CausalPosition): boolean {
		this.assertActive();
		this.assertPosition(position);
		const current = this.recordForOwner(key, position.generation);
		if (!current?.activeDeleteClaim || current.fence >= position.fence) return false;
		return this.cancelDelete(current.activeDeleteClaim);
	}

	releaseDeleteClaim(claim: DeleteClaim): boolean {
		const active = this.#activeDeletes.get(claim.id);
		return active?.handle === claim && active.phase === 'queued' ? this.cancelDelete(claim.id) : false;
	}

	/**
	 * Claims the destructive boundary. Phase 3 must call this transition and
	 * start storage deletion in one per-key serialized or atomic section; pure
	 * bookkeeping cannot make a separately awaited adapter operation atomic.
	 */
	beginPhysicalDelete(claim: DeleteClaim): boolean {
		const active = this.#activeDeletes.get(claim.id);
		if (active?.handle !== claim || active.phase !== 'queued') return false;
		if (
			this.#lifecycle !== 'active' ||
			active.deleteEpoch !== this.#deleteEpoch ||
			!this.isCurrentGeneration(claim.generation)
		) {
			this.cancelDelete(claim.id);
			return false;
		}
		if (!this.isCurrentSnapshotCut(claim.cut, claim.supersessionTarget)) {
			this.cancelDelete(claim.id, true);
			return false;
		}
		const record = this.recordFor(claim.key, claim.generation);
		const current =
			record?.state === 'hidden-pending' &&
			record.activeDeleteClaim === claim.id &&
			record.fence === claim.fence &&
			this.latestWriteFence(claim.key, claim.generation) <= claim.fence;
		if (!current || !this.beginWork(active.work)) {
			this.cancelDelete(claim.id);
			return false;
		}
		active.phase = 'executing';
		return true;
	}

	completeDelete(claim: DeleteClaim, succeeded: boolean): DeleteCompletion {
		const active = this.#activeDeletes.get(claim.id);
		if (active?.handle !== claim || active.phase !== 'executing') return 'stale';
		const current = this.recordForOwner(claim.key, claim.generation);
		const stillOwned = current?.activeDeleteClaim === claim.id;
		this.#activeDeletes.delete(claim.id);
		this.settleWork(active.work);
		if (!stillOwned) return 'stale';
		if (current) {
			delete current.activeDeleteClaim;
			if (succeeded) current.physicallyDeleted = true;
			else delete current.physicallyDeleted;
		}
		if (succeeded) this.maybeCollectKey(claim.key);
		return succeeded ? 'completed' : 'failed';
	}

	private assertActive(): void {
		if (this.#lifecycle !== 'active') {
			throw new Error(`Reconciliation state is not active (${this.#lifecycle}).`);
		}
	}

	private assertCurrentScope(generation: VisibilityScope): void {
		if (!this.isCurrentScope(generation)) throw new Error('The visibility scope is not current.');
	}

	private assertPosition(position: CausalPosition): void {
		this.requireGeneration(position.generation);
		if (!this.#positions.has(position)) {
			throw new Error('The causal position was not issued by this reconciliation state.');
		}
	}

	private cancelDelete(id: number, restoreVisibility = false): boolean {
		const claim = this.#activeDeletes.get(id);
		if (!claim || claim.phase !== 'queued') return false;
		this.#activeDeletes.delete(id);
		const record = this.#visibility.get(claim.handle.key);
		if (record?.activeDeleteClaim === id) {
			if (restoreVisibility) {
				if (claim.previousVisibility) {
					this.#visibility.set(claim.handle.key, claim.previousVisibility);
				} else {
					this.#visibility.delete(claim.handle.key);
				}
			} else {
				delete record.activeDeleteClaim;
			}
		}
		this.removeWork(claim.work);
		return true;
	}

	private cancelSupersededSnapshotDeletes(cut: SnapshotCut): void {
		for (const claim of this.#activeDeletes.values()) {
			const previous = claim.handle.cut;
			if (
				claim.phase === 'queued' &&
				previous.generation === cut.generation &&
				previous.guildId === cut.guildId &&
				previous.resource === cut.resource &&
				(cut.supersessionTarget === undefined || claim.handle.supersessionTarget === cut.supersessionTarget) &&
				previous.fence < cut.fence
			) {
				this.cancelDelete(claim.handle.id, true);
			}
		}
	}

	private copyVisibility(record: MutableVisibilityRecord): MutableVisibilityRecord {
		return {
			...record,
			retentionGenerations: record.retentionGenerations ? new Set(record.retentionGenerations) : undefined,
		};
	}

	private isCurrentSnapshotCut(cut: SnapshotCut, supersessionTarget: string): boolean {
		const cuts = this.#snapshotCuts.get(cut.generation.shardId);
		if (cuts?.get(this.snapshotKey(cut.guildId, cut.resource, cut.supersessionTarget)) !== cut) return false;
		const collection = cuts.get(this.snapshotKey(cut.guildId, cut.resource));
		if (collection && collection.fence > cut.fence) return false;
		const targeted = cuts.get(this.snapshotKey(cut.guildId, cut.resource, supersessionTarget));
		return !targeted || targeted.fence <= cut.fence;
	}

	private cancelRemove(id: number): boolean {
		const attempt = this.#activeRemoves.get(id);
		if (!attempt || attempt.phase !== 'queued') return false;
		this.#activeRemoves.delete(id);
		const record = this.#visibility.get(attempt.handle.key);
		if (record?.activeRemoveAttempt === id) delete record.activeRemoveAttempt;
		this.removeWork(attempt.work);
		return true;
	}

	private cancelWrite(attempt: WriteAttempt, releaseProvisionalOwnership = false): boolean {
		const attempts = this.#writeAttempts.get(attempt.key);
		const active = attempts?.get(attempt.id);
		if (!attempts || active?.handle !== attempt || active.phase !== 'queued') return false;
		attempts.delete(attempt.id);
		if (attempts.size === 0) {
			this.#writeAttempts.delete(attempt.key);
		} else if (releaseProvisionalOwnership && active.createdOwnership && !this.#visibility.has(attempt.key)) {
			attempts.values().next().value!.createdOwnership = true;
		}
		this.removeWork(active.work);
		if (
			releaseProvisionalOwnership &&
			active.createdOwnership &&
			attempts.size === 0 &&
			!this.#visibility.has(attempt.key) &&
			this.keyHasScope(attempt.key, attempt.generation)
		) {
			this.#keyOwnership.delete(attempt.key);
		}
		this.maybeCollectKey(attempt.key);
		return true;
	}

	private cancelQueuedWork(generation?: ShardGeneration): void {
		for (const claim of [...this.#activeDeletes.values()]) {
			if (!generation || claim.handle.generation === generation) this.cancelDelete(claim.handle.id);
		}
		for (const attempt of [...this.#activeRemoves.values()]) {
			if (!generation || attempt.handle.generation === generation || attempt.work.generation === generation) {
				this.cancelRemove(attempt.handle.id);
			}
		}
		for (const attempts of [...this.#writeAttempts.values()]) {
			for (const attempt of [...attempts.values()]) {
				if (attempt.phase === 'queued' && (!generation || attempt.work.generation === generation)) {
					this.cancelWrite(attempt.handle);
				}
			}
		}
		for (const attempt of [...this.#activeFlushes.values()]) {
			if (attempt.phase === 'queued' && (!generation || attempt.work.generation === generation)) {
				this.#activeFlushes.delete(attempt.handle.id);
				this.removeWork(attempt.work);
			}
		}
		for (const work of [...this.#pendingWork.values()]) {
			if (work.phase === 'queued' && (!generation || work.handle.generation === generation)) {
				this.removeWork(work.handle);
			}
		}
	}

	private canUseKeyScope(key: string, generation: VisibilityScope): boolean {
		return this.canUseOwnership(this.#keyOwnership.get(key), generation);
	}

	private canUseOwnership(ownership: KeyOwnership | undefined, generation: VisibilityScope): boolean {
		if (!ownership) return true;
		if (ownership.kind === 'global' || generation.kind === 'global') {
			return ownership.kind === generation.kind;
		}
		return ownership.shardId === generation.shardId;
	}

	private preflightStaging(inputs: readonly StagingInput[]): void {
		this.assertActive();
		const provisionalOwnership = new Map<string, KeyOwnership>();
		for (const input of inputs) {
			this.assertCurrentScope(input.generation);
			if (input.position) {
				this.assertPosition(input.position);
				if (input.generation.kind === 'shard' && input.position.generation !== input.generation) {
					throw new Error('The causal position belongs to a different shard generation.');
				}
			}
			const ownership = provisionalOwnership.get(input.key) ?? this.#keyOwnership.get(input.key);
			if (!this.canUseOwnership(ownership, input.generation)) {
				throw new Error(`Cache key ${input.key} is already owned by a different visibility scope.`);
			}
			provisionalOwnership.set(input.key, this.ownershipFor(input.generation));
		}
	}

	private createWork(
		kind: ReconciliationWork['kind'],
		generation?: ShardGeneration,
		label?: string,
		phase: WorkPhase = 'queued',
	): ReconciliationWork {
		const work = Object.freeze({
			generation,
			id: ++this.#nextOperationId,
			kind,
			label,
		});
		this.#pendingWork.set(work.id, { handle: work, phase });
		return work;
	}

	private isCurrentScope(generation: VisibilityScope): boolean {
		return generation.kind === 'global' || this.isCurrentGeneration(generation);
	}

	private establishKeyScope(key: string, generation: VisibilityScope): void {
		if (this.#keyOwnership.has(key)) return;
		this.#keyOwnership.set(key, this.ownershipFor(generation));
	}

	private keyHasScope(key: string, generation: VisibilityScope): boolean {
		const ownership = this.#keyOwnership.get(key);
		return ownership !== undefined && this.canUseOwnership(ownership, generation);
	}

	private ownershipFor(generation: VisibilityScope): KeyOwnership {
		return generation.kind === 'global'
			? GLOBAL_VISIBILITY_SCOPE
			: Object.freeze({ kind: 'shard', shardId: generation.shardId });
	}

	private retireGeneration(generation: MutableGeneration): void {
		this.cancelQueuedWork(generation.ref);
		for (const [key, record] of this.#visibility) {
			if (record.generation === generation.ref || record.retentionGenerations?.has(generation.ref)) {
				this.maybeCollectKey(key);
			}
		}
	}

	private finishWriteAttempt(key: string, completion: WriteCompletion): WriteCompletion {
		this.maybeCollectKey(key);
		return completion;
	}

	private latestEvidenceFence(key: string, generation: VisibilityScope): number {
		return Math.max(this.recordForOwner(key, generation)?.fence ?? 0, this.latestWriteFence(key, generation));
	}

	private latestWriteFence(key: string, generation: VisibilityScope): number {
		let latest = 0;
		for (const attempt of this.#writeAttempts.get(key)?.values() ?? []) {
			if (sameVisibilityScope(attempt.handle.generation, generation)) {
				latest = Math.max(latest, attempt.handle.fence);
			}
		}
		return latest;
	}

	private maybeCommit(generation: MutableGeneration): boolean {
		if (
			!generation.committed &&
			generation.streamFinished &&
			generation.guildOutcomes.size === generation.expectedGuildIds.size
		) {
			generation.committed = true;
			this.removeWork(generation.startupWork);
		}
		return generation.committed;
	}

	private maybeCollectKey(key: string): void {
		const record = this.#visibility.get(key);
		const retainedByGeneration = [...(record?.retentionGenerations ?? [])].some(generation =>
			this.isCurrentGeneration(generation),
		);
		if (
			record?.state !== 'hidden-pending' ||
			!record.physicallyDeleted ||
			record.activeDeleteClaim ||
			record.activeRemoveAttempt ||
			this.#writeAttempts.has(key) ||
			retainedByGeneration
		) {
			return;
		}
		for (const claim of this.#activeDeletes.values()) {
			if (claim.handle.key === key) return;
		}
		for (const attempt of this.#activeRemoves.values()) {
			if (attempt.handle.key === key) return;
		}
		this.#visibility.delete(key);
		this.#keyOwnership.delete(key);
	}

	private snapshotCurrentGenerations(): ReadonlySet<ShardGeneration> {
		return new Set([...this.#generations.values()].map(generation => generation.ref));
	}

	private nextFence(): number {
		return ++this.#nextFence;
	}

	private recordFor(key: string, generation: VisibilityScope): MutableVisibilityRecord | undefined {
		const record = this.#visibility.get(key);
		return record && sameVisibilityScope(record.generation, generation) ? record : undefined;
	}

	private recordForOwner(key: string, generation: VisibilityScope): MutableVisibilityRecord | undefined {
		if (!this.canUseKeyScope(key, generation)) return;
		return this.#visibility.get(key);
	}

	private toVisibilityRecord(record: MutableVisibilityRecord): VisibilityRecord {
		return {
			causal: record.causal,
			fence: record.fence,
			generation: record.generation,
			state: record.state,
		};
	}

	private removeWork(work: ReconciliationWork): boolean {
		if (this.#pendingWork.get(work.id)?.handle !== work) return false;
		this.#pendingWork.delete(work.id);
		this.resolveIdleIfNeeded();
		return true;
	}

	private requireGeneration(generation: ShardGeneration): MutableGeneration {
		const current = this.#generations.get(generation.shardId);
		if (!this.#issuedGenerations.has(generation) || current?.ref !== generation) {
			throw new Error('The shard generation is no longer active.');
		}
		return current;
	}

	private resolveIdleIfNeeded(): void {
		if (this.#pendingWork.size !== 0) return;
		for (const resolve of this.#waiters) resolve();
		this.#waiters.clear();
	}

	private snapshotKey(guildId: string, resource: string, supersessionTarget?: string): string {
		return JSON.stringify([guildId, resource, supersessionTarget ?? null]);
	}

	private updateSequence(generation: MutableGeneration, sequence: number): void {
		if (sequence < generation.latestSequence) {
			throw new Error(
				`Gateway sequence ${sequence} precedes ${generation.latestSequence} in the active shard generation.`,
			);
		}
		generation.latestSequence = sequence;
	}
}
