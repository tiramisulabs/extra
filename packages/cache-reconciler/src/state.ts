/** Admission state of one plugin instance. */
export type ManagerLifecycle = 'installing' | 'active' | 'closing' | 'closed' | 'failed';

/**
 * What a reader and the sweep may do with a key.
 *
 * - `visible`: a write in the current evidence window confirmed it; reads return it.
 * - `unknown-preserved`: it predates the current evidence; reads miss and nothing may delete it.
 * - `hidden-pending`: authoritative evidence marked it stale; reads miss and its claim may delete it.
 */
export type Visibility = 'visible' | 'unknown-preserved' | 'hidden-pending';

/** Terminal result for a guild listed in READY. */
export type GuildOutcome = 'reconciled' | 'unavailable-preserved' | 'deleted' | 'failed';

export type GuildWorkKind = 'snapshot' | 'unavailable' | 'delete';

/** Reconciliation registered for one guild packet before Seyfert's core cache processes it. */
export interface GuildWork {
	readonly kind: GuildWorkKind;
	readonly generation: number;
	readonly shardId: number;
	readonly guildId: string;
	/** `packet.s` of the packet, scoped to its generation. */
	readonly sequence: number;
	/** Whether the guild was listed in READY, so its outcome gates the startup snapshot. */
	readonly startup: boolean;
	/** `cancelled` when a newer READY, a failure, or teardown fenced the work before it settled. */
	readonly settled: GuildOutcome | 'cancelled' | undefined;
}

/** The causal fence: a position inside one `(shard, Discord session)` generation. */
export interface CausalPosition {
	/** Generation that governs the key, or `0` when no generation owns its guild. */
	readonly generation: number;
	/** Latest `packet.s` that generation had observed when the mutation was issued. */
	readonly sequence: number;
}

/** Evidence boundary of one guild snapshot. */
export interface SnapshotCut {
	readonly generation: number;
	readonly guildId: string;
	readonly sequence: number;
}

/** Authority to remove what is left of a guild the generation no longer knows. */
export interface GuildClaim {
	readonly generation: number;
	readonly guildId: string;
	/** The registered delete this claim cleans up after; absent for a guild the startup snapshot never listed. */
	readonly work: GuildWork | undefined;
}

export interface KeyTarget {
	readonly key: string;
	readonly to: string;
	readonly id: string;
	/** Guild partition the key belongs to; `undefined` for resources no shard owns. */
	readonly guildId: string | undefined;
	/** Whether a complete guild snapshot may delete the key when the snapshot does not list it. */
	readonly replaceable: boolean;
}

export interface WriteAttempt {
	readonly order: number;
	readonly targets: readonly (KeyTarget & CausalPosition)[];
}

export interface RemovalClaim {
	readonly order: number;
	readonly keys: readonly string[];
}

/**
 * - `write` / `removal`: a cache mutation failed in the store.
 * - `guild`: a guild packet could not be reconciled.
 * - `session`: a shard has no usable generation and stays unreadable until its next READY.
 * - `dispatch`: Seyfert reported a failure while a guild packet was being cached.
 * - `observation`: the plugin's own bookkeeping failed.
 */
export type ReconcilerFailureKind = 'write' | 'removal' | 'guild' | 'session' | 'dispatch' | 'observation';

export interface ReconcilerFailure {
	readonly kind: ReconcilerFailureKind;
	readonly message: string;
	readonly shardId?: number;
	readonly guildId?: string;
	readonly key?: string;
	readonly cause?: unknown;
}

export type ShardStartup = 'awaiting-ready' | 'awaiting-guilds' | 'committed';

export interface ShardSnapshot {
	shardId: number;
	/** `undefined` while a RESUMED arrived without a generation this instance validated. */
	generation: number | undefined;
	sessionId: string | undefined;
	startup: ShardStartup;
	expectedGuilds: number;
	settledGuilds: number;
	outcomes: Record<GuildOutcome, number>;
}

export interface StateSnapshot {
	lifecycle: ManagerLifecycle;
	idle: boolean;
	pending: {
		/** Guild packets registered and not settled yet. */
		guilds: number;
		/** Keys hidden while their physical removal is outstanding or failed. */
		deletions: number;
		/** Background sweeps in flight. */
		tasks: number;
	};
	shards: ShardSnapshot[];
	failures: ReconcilerFailure[];
	failureCount: number;
	cause: unknown;
}

interface Generation {
	readonly id: number;
	readonly shardId: number;
	readonly sessionId: string;
	readonly totalShards: number;
	/** Latest `packet.s` observed in this generation. */
	sequence: number;
	/** Guild IDs from `READY.d.guilds` and their terminal outcome once known. */
	readonly expected: Map<string, GuildOutcome | undefined>;
	/** Open guild partitions and the sequence their current evidence starts at. */
	readonly cuts: Map<string, number>;
	guildsReady: boolean;
	committed: boolean;
}

interface KeyRecord extends KeyTarget {
	/** `removed` is a tombstone kept only while a write issued before the removal is still in flight. */
	state: 'visible' | 'hidden-pending' | 'removed';
	generation: number;
	sequence: number;
	/** Removal that owns the hidden key; `undefined` once a failed removal gave it up. */
	claim: number | undefined;
	/** Issue order of the latest removal. A write issued before it cannot make the key visible. */
	removedAt: number;
}

type MutableGuildWork = { -readonly [K in keyof GuildWork]: GuildWork[K] };

const MAX_FAILURES = 50;

/**
 * Generation, visibility, and pending-work bookkeeping for one plugin instance.
 *
 * It has no I/O and no dependency on Seyfert or Redis: callers report what they observed and ask what is
 * currently allowed.
 *
 * Causal order between evidence comes only from `packet.s` inside one `(shard, session)` generation. A write
 * cannot be traced back to its packet, so it is stamped with the latest sequence its generation had observed
 * when the mutation was issued: an upper bound on the packet that caused it. Mutations of one key are also
 * numbered in the order they were issued, which mirrors the last writer in a store that applies them in order.
 */
export class ReconciliationState {
	private currentLifecycle: ManagerLifecycle = 'installing';
	private failed = false;
	private failureCause: unknown;
	private nextGeneration = 1;
	private nextOrder = 1;
	private readonly generations = new Map<number, Generation>();
	private readonly awaitingReady = new Set<number>();
	private readonly owners = new Map<string, Generation | null>();
	private readonly records = new Map<string, KeyRecord>();
	private readonly members = new Map<string, Map<string, string>>();
	private readonly attempts = new Map<string, number>();
	private readonly work = new Set<MutableGuildWork>();
	private tasks = 0;
	private hidden = 0;
	private readonly failures: ReconcilerFailure[] = [];
	private failureCount = 0;
	private idleWaiters: (() => void)[] = [];

	get lifecycle(): ManagerLifecycle {
		return this.currentLifecycle;
	}

	/** Only an active instance may register reconciliation work or authorize a delete. */
	get admits(): boolean {
		return this.currentLifecycle === 'active';
	}

	activate(): void {
		if (this.currentLifecycle === 'installing') this.currentLifecycle = 'active';
	}

	/** Terminal except for cleanup: nothing is visible again and no work is admitted afterwards. */
	fail(cause: unknown): void {
		if (this.currentLifecycle !== 'installing' && this.currentLifecycle !== 'active') return;
		this.currentLifecycle = 'failed';
		this.failed = true;
		this.failureCause = cause;
		this.cancelWork();
	}

	/**
	 * Fences every claim and cancels registered work before the caller drains running operations. Reachable
	 * from any earlier state, including an instance that never started or already failed.
	 */
	beginClose(): void {
		if (this.currentLifecycle === 'closing' || this.currentLifecycle === 'closed') return;
		this.currentLifecycle = 'closing';
		this.cancelWork();
	}

	close(): void {
		this.beginClose();
		this.currentLifecycle = 'closed';
	}

	// Gateway observations

	/**
	 * Opens a generation for `(shardId, sessionId)`. The sequence baseline restarts, the shard's previous work
	 * is cancelled, and every guild of the shard stays unreadable until its own packet arrives.
	 */
	ready(
		shardId: number,
		sessionId: string,
		totalShards: number,
		guildIds: readonly string[],
		sequence: number,
	): GuildWork[] {
		if (!this.admits) return [];
		const cancelled = this.cancelWork(shardId);
		const generation: Generation = {
			id: this.nextGeneration++,
			shardId,
			sessionId,
			totalShards: totalShards > 0 ? totalShards : 1,
			sequence,
			expected: new Map(guildIds.map(id => [id, undefined])),
			cuts: new Map(),
			guildsReady: false,
			committed: false,
		};
		this.generations.set(shardId, generation);
		this.awaitingReady.delete(shardId);
		this.owners.clear();
		return cancelled;
	}

	/**
	 * RESUMED carries no session identity, so it only continues a generation this instance already validated.
	 * Otherwise the shard fails closed until a new READY. While any shard waits, guilds that no generation owns
	 * are unreadable too: without a READY this instance cannot tell which of them the waiting shard owns.
	 */
	resumed(shardId: number): boolean {
		if (!this.admits) return false;
		if (this.generations.has(shardId)) return true;
		this.awaitingReady.add(shardId);
		return false;
	}

	/**
	 * The shard's cache stopped following the Gateway, so nothing recorded for its generation can be trusted.
	 * Its guilds fail closed until a new READY, like an unvalidated RESUMED. Returns whether this call changed
	 * the shard.
	 */
	suspend(shardId: number): boolean {
		if (!this.admits || (this.awaitingReady.has(shardId) && !this.generations.has(shardId))) return false;
		this.generations.delete(shardId);
		this.awaitingReady.add(shardId);
		this.owners.clear();
		this.cancelWork(shardId);
		return true;
	}

	/** Records the causal position of a packet before core cache processes it. */
	observe(shardId: number, sequence: number): void {
		const generation = this.generations.get(shardId);
		if (generation) advance(generation, sequence);
	}

	/**
	 * A guild became available. A startup snapshot starts the guild's evidence window at its own sequence and
	 * registers its reconciliation; a later GUILD_CREATE only opens a guild this generation did not know.
	 */
	guildAvailable(
		shardId: number,
		guildId: string,
		sequence: number,
		options: { startup: boolean; unavailable: boolean },
	): GuildWork | undefined {
		const generation = this.admits ? this.generations.get(shardId) : undefined;
		if (!generation) return;
		advance(generation, sequence);
		if (options.startup || !generation.cuts.has(guildId)) generation.cuts.set(guildId, sequence);
		if (!options.startup) return;
		return this.register(generation, options.unavailable ? 'unavailable' : 'snapshot', guildId, sequence, true);
	}

	/**
	 * A guild delete arrived. `unavailable` is an outage, never a removal: the guild and its descendants stay.
	 * A real removal only registers the cleanup; the caller closes the partition with `closeGuild` when the
	 * guild record is actually removed, so listeners still read the guild while the delete is dispatched.
	 */
	guildGone(
		shardId: number,
		guildId: string,
		sequence: number,
		options: { startup: boolean; unavailable: boolean },
	): GuildWork | undefined {
		const generation = this.admits ? this.generations.get(shardId) : undefined;
		if (!generation) return;
		advance(generation, sequence);
		if (!options.unavailable) return this.register(generation, 'delete', guildId, sequence, options.startup);
		if (!options.startup) return;
		if (!generation.cuts.has(guildId)) generation.cuts.set(guildId, sequence);
		return this.register(generation, 'unavailable', guildId, sequence, true);
	}

	/**
	 * Discord finished the startup guild stream. Returns the generation to commit when every READY guild
	 * already has a terminal outcome.
	 */
	guildsReady(shardId: number): number | undefined {
		const generation = this.admits ? this.generations.get(shardId) : undefined;
		if (!generation) return;
		generation.guildsReady = true;
		return this.commitIfComplete(generation);
	}

	/**
	 * Gives registered work its single terminal outcome. Returns the generation whose startup snapshot this
	 * completed, if any.
	 */
	settle(work: GuildWork, outcome: GuildOutcome): number | undefined {
		const entry = work as MutableGuildWork;
		// Registered work always belongs to its shard's current generation: READY cancels the older work.
		if (entry.settled !== undefined || !this.work.delete(entry)) return;
		entry.settled = outcome;
		const generation = this.generations.get(entry.shardId);
		let committed: number | undefined;
		if (generation && entry.startup && generation.expected.has(entry.guildId)) {
			generation.expected.set(entry.guildId, outcome);
			committed = this.commitIfComplete(generation);
		}
		this.resolveIdle();
		return committed;
	}

	/** Closes a guild partition: every descendant stops being readable at once. */
	closeGuild(guildId: string): void {
		this.ownerOf(guildId)?.cuts.delete(guildId);
	}

	/** Guild IDs the generation currently knows: the READY list plus guilds that became available since. */
	knownGuilds(generation: number): Set<string> | undefined {
		const current = this.findGeneration(generation);
		if (!current) return;
		return new Set([...current.expected.keys(), ...current.cuts.keys()]);
	}

	/** Whether Discord's shard formula assigns the guild to this generation's shard. */
	ownsGuild(generation: number, guildId: string): boolean {
		const current = this.findGeneration(generation);
		return current !== undefined && shardOf(guildId, current.totalShards) === current.shardId;
	}

	// Visibility

	visibility(key: string): Visibility {
		const record = this.records.get(key);
		if (record?.state === 'hidden-pending') return 'hidden-pending';
		return record?.state === 'visible' && this.isCurrent(record) ? 'visible' : 'unknown-preserved';
	}

	isVisible(key: string): boolean {
		return this.visibility(key) === 'visible';
	}

	/** Returns the visible key filed under a relationship member, if any. */
	visibleMember(to: string, id: string): string | undefined {
		const key = this.memberKey(to, id);
		return key !== undefined && this.isVisible(key) ? key : undefined;
	}

	/** Returns the key filed under a relationship member, whether or not it is readable. */
	memberKey(to: string, id: string): string | undefined {
		return this.members.get(to)?.get(id);
	}

	/** The guild partition a filed key belongs to. */
	guildOf(key: string): string | undefined {
		return this.records.get(key)?.guildId;
	}

	/**
	 * Whether a partial write may merge into what the store holds for the key. A key that is neither readable
	 * nor being written is a cache miss, and merging into it would surface fields nothing confirmed.
	 */
	canPatch(key: string): boolean {
		return this.attempts.has(key) || this.isVisible(key);
	}

	/** Every key this instance filed under relationships matching `to`, where `*` matches any run of characters. */
	relationshipKeys(to: string): string[] {
		if (!to.includes('*')) return [...(this.members.get(to)?.values() ?? [])];
		const pattern = new RegExp(
			`^${to
				.split('*')
				.map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
				.join('.*')}$`,
		);
		const keys: string[] = [];
		for (const [relationship, members] of this.members) {
			if (pattern.test(relationship)) keys.push(...members.values());
		}
		return keys;
	}

	// Writes

	/** Stamps a write with its causal position before the owning mutation runs. */
	beginWrite(targets: readonly KeyTarget[]): WriteAttempt {
		const stamped = targets.map(target => {
			this.attempts.set(target.key, (this.attempts.get(target.key) ?? 0) + 1);
			return { ...target, ...this.position(target.guildId) };
		});
		return { order: this.nextOrder++, targets: stamped };
	}

	/**
	 * The mutation succeeded: each key becomes visible at its stamped position and a pending delete issued
	 * before the write is cancelled. Two things outrank it: evidence from a newer generation, and a removal
	 * issued after the write, because that removal is what the store ends up reflecting.
	 */
	commitWrite(attempt: WriteAttempt): void {
		for (const target of attempt.targets) {
			const previous = this.records.get(target.key);
			if (!previous || (previous.generation <= target.generation && previous.removedAt < attempt.order)) {
				if (previous) this.forget(previous);
				this.records.set(target.key, {
					...target,
					sequence:
						previous?.generation === target.generation && previous.sequence > target.sequence
							? previous.sequence
							: target.sequence,
					state: 'visible',
					claim: undefined,
					removedAt: previous?.removedAt ?? 0,
				});
				let members = this.members.get(target.to);
				if (!members) {
					members = new Map();
					this.members.set(target.to, members);
				}
				members.set(target.id, target.key);
			}
			this.releaseAttempt(target.key);
		}
	}

	/** The mutation failed: only this attempt is released; visibility and newer fences are untouched. */
	failWrite(attempt: WriteAttempt): void {
		for (const target of attempt.targets) this.releaseAttempt(target.key);
	}

	// Removals

	/** Hides keys before their owning removal runs. They stay hidden if any physical step fails. */
	beginRemoval(keys: readonly string[]): RemovalClaim {
		const order = this.nextOrder++;
		for (const key of keys) {
			const record = this.records.get(key) ?? this.placeholder(key);
			this.hide(record, order);
		}
		return { order, keys: [...keys] };
	}

	/** The removal succeeded: forget every key this claim still hides. */
	commitRemoval(claim: RemovalClaim): void {
		for (const key of claim.keys) {
			const record = this.records.get(key);
			if (record?.state !== 'hidden-pending' || record.claim !== claim.order) continue;
			// A write issued before this removal may still land; its commit must find the removal.
			if (this.attempts.has(key)) {
				record.state = 'removed';
				record.claim = undefined;
				this.hidden--;
			} else this.forget(record);
		}
		this.resolveIdle();
	}

	/**
	 * The removal failed: the keys stay hidden, but the claim gives up ownership so a later authoritative
	 * reconciliation may claim them again.
	 */
	abandonRemoval(claim: RemovalClaim): void {
		for (const key of claim.keys) {
			const record = this.records.get(key);
			if (record?.state === 'hidden-pending' && record.claim === claim.order) record.claim = undefined;
		}
	}

	/** Drops all visibility: used by flush, where nothing written before may be read again. */
	forgetAll(): void {
		this.records.clear();
		this.members.clear();
		this.hidden = 0;
		this.resolveIdle();
	}

	/**
	 * Claims snapshot candidates for deletion and hides them immediately. Only replaceable keys of the
	 * snapshot's own guild qualify. A key is left alone while a write is in flight, while another removal owns
	 * it, or when a write later than the snapshot already confirmed it. This is the sequence fence: within the
	 * snapshot's generation only a position at or before its cut loses.
	 */
	claimSweep(targets: readonly KeyTarget[], cut: SnapshotCut): RemovalClaim {
		const order = this.nextOrder++;
		const keys: string[] = [];
		if (!this.cutHolds(cut)) return { order, keys };
		for (const target of targets) {
			if (target.guildId !== cut.guildId || !target.replaceable || this.attempts.has(target.key)) continue;
			const record = this.records.get(target.key);
			if (record?.state === 'hidden-pending' && record.claim !== undefined) continue;
			if (record?.state === 'visible' && record.generation === cut.generation && record.sequence > cut.sequence) {
				continue;
			}
			this.hide(record ?? this.placeholder(target.key, target), order);
			keys.push(target.key);
		}
		return { order, keys };
	}

	/** Rechecks the fence at the destructive boundary and returns the keys the claim may still delete. */
	confirmSweep(claim: RemovalClaim, cut: SnapshotCut): string[] {
		if (!this.cutHolds(cut)) return [];
		return claim.keys.filter(key => {
			const record = this.records.get(key);
			return record?.state === 'hidden-pending' && record.claim === claim.order && !this.attempts.has(key);
		});
	}

	/**
	 * Claims what is left of a guild the generation does not know: either the guild a registered delete removed,
	 * or one the committed startup snapshot never listed. Only a closed partition of this shard can be claimed.
	 */
	claimGuild(generation: number, guildId: string, work?: GuildWork): GuildClaim | undefined {
		const claim = { generation, guildId, work };
		return this.guildClaimHolds(claim) ? claim : undefined;
	}

	/** A guild claim dies when the instance stops admitting work, a newer READY arrives, or the guild is reobserved. */
	guildClaimHolds(claim: GuildClaim): boolean {
		const generation = this.findGeneration(claim.generation);
		if (!this.admits || !generation || generation.cuts.has(claim.guildId)) return false;
		if (shardOf(claim.guildId, generation.totalShards) !== generation.shardId) return false;
		if (claim.work) {
			return (
				claim.work.kind === 'delete' && claim.work.generation === generation.id && claim.work.guildId === claim.guildId
			);
		}
		return generation.committed && !generation.expected.has(claim.guildId);
	}

	// Pending work

	/** Tracks a background sweep until the returned function is called. */
	beginTask(): () => void {
		this.tasks++;
		let ended = false;
		return () => {
			if (ended) return;
			ended = true;
			this.tasks--;
			this.resolveIdle();
		};
	}

	recordFailure(failure: ReconcilerFailure): void {
		this.failureCount++;
		this.failures.push(failure);
		if (this.failures.length > MAX_FAILURES) this.failures.shift();
	}

	/** Running sweeps always count; registered work and open startup snapshots count only while admitted. */
	get idle(): boolean {
		if (this.tasks) return false;
		if (!this.admits) return true;
		if (this.work.size) return false;
		for (const generation of this.generations.values()) {
			if (!generation.committed) return false;
		}
		return true;
	}

	/** Resolves once nothing is pending. After the instance stops admitting work it only waits for running sweeps. */
	whenIdle(): Promise<void> {
		if (this.idle) return Promise.resolve();
		return new Promise(resolve => {
			this.idleWaiters.push(resolve);
		});
	}

	snapshot(): StateSnapshot {
		const shards = new Map<number, ShardSnapshot>();
		for (const shardId of this.awaitingReady) {
			shards.set(shardId, {
				shardId,
				generation: undefined,
				sessionId: undefined,
				startup: 'awaiting-ready',
				expectedGuilds: 0,
				settledGuilds: 0,
				outcomes: emptyOutcomes(),
			});
		}
		for (const generation of this.generations.values()) {
			const outcomes = emptyOutcomes();
			let settled = 0;
			for (const outcome of generation.expected.values()) {
				if (!outcome) continue;
				outcomes[outcome]++;
				settled++;
			}
			shards.set(generation.shardId, {
				shardId: generation.shardId,
				generation: generation.id,
				sessionId: generation.sessionId,
				startup: generation.committed ? 'committed' : 'awaiting-guilds',
				expectedGuilds: generation.expected.size,
				settledGuilds: settled,
				outcomes,
			});
		}
		return {
			lifecycle: this.currentLifecycle,
			idle: this.idle,
			pending: { guilds: this.work.size, deletions: this.hidden, tasks: this.tasks },
			shards: [...shards.values()].sort((left, right) => left.shardId - right.shardId),
			failures: [...this.failures],
			failureCount: this.failureCount,
			cause: this.failureCause,
		};
	}

	private register(
		generation: Generation,
		kind: GuildWorkKind,
		guildId: string,
		sequence: number,
		startup: boolean,
	): GuildWork {
		const work: MutableGuildWork = {
			kind,
			generation: generation.id,
			shardId: generation.shardId,
			guildId,
			sequence,
			startup,
			settled: undefined,
		};
		this.work.add(work);
		return work;
	}

	private cancelWork(shardId?: number): GuildWork[] {
		const cancelled: GuildWork[] = [];
		for (const work of this.work) {
			if (shardId !== undefined && work.shardId !== shardId) continue;
			work.settled = 'cancelled';
			this.work.delete(work);
			cancelled.push(work);
		}
		this.resolveIdle();
		return cancelled;
	}

	private commitIfComplete(generation: Generation): number | undefined {
		if (generation.committed || !generation.guildsReady) return;
		for (const outcome of generation.expected.values()) {
			if (!outcome) return;
		}
		generation.committed = true;
		this.resolveIdle();
		return generation.id;
	}

	private findGeneration(id: number): Generation | undefined {
		for (const generation of this.generations.values()) {
			if (generation.id === id) return generation;
		}
		return;
	}

	/** The newest generation whose shard Discord assigns the guild to. */
	private ownerOf(guildId: string): Generation | undefined {
		const cached = this.owners.get(guildId);
		if (cached !== undefined) return cached ?? undefined;
		let owner: Generation | undefined;
		for (const generation of this.generations.values()) {
			if (shardOf(guildId, generation.totalShards) !== generation.shardId) continue;
			if (!owner || generation.id > owner.id) owner = generation;
		}
		this.owners.set(guildId, owner ?? null);
		return owner;
	}

	private position(guildId: string | undefined): CausalPosition {
		const owner = guildId === undefined ? undefined : this.ownerOf(guildId);
		return owner ? { generation: owner.id, sequence: owner.sequence } : { generation: 0, sequence: 0 };
	}

	private isCurrent(record: KeyRecord): boolean {
		if (this.failed) return false;
		if (record.guildId === undefined) return true;
		const owner = this.ownerOf(record.guildId);
		if (!owner) return record.generation === 0 && this.awaitingReady.size === 0;
		const cut = owner.cuts.get(record.guildId);
		return cut !== undefined && record.generation === owner.id && record.sequence >= cut;
	}

	private cutHolds(cut: SnapshotCut): boolean {
		const generation = this.findGeneration(cut.generation);
		return this.admits && generation?.cuts.get(cut.guildId) === cut.sequence;
	}

	/** A hidden record for a key this instance never filed, so its pending removal is still accounted for. */
	private placeholder(key: string, target?: KeyTarget): KeyRecord {
		const record: KeyRecord = {
			key,
			to: target?.to ?? '',
			id: target?.id ?? '',
			guildId: target?.guildId,
			replaceable: target?.replaceable ?? false,
			state: 'removed',
			generation: 0,
			sequence: 0,
			claim: undefined,
			removedAt: 0,
		};
		this.records.set(key, record);
		return record;
	}

	private hide(record: KeyRecord, order: number): void {
		if (record.state !== 'hidden-pending') this.hidden++;
		record.state = 'hidden-pending';
		record.claim = order;
		record.removedAt = order;
	}

	private forget(record: KeyRecord): void {
		if (record.state === 'hidden-pending') this.hidden--;
		this.records.delete(record.key);
		const members = this.members.get(record.to);
		if (members?.get(record.id) !== record.key) return;
		members.delete(record.id);
		if (!members.size) this.members.delete(record.to);
	}

	private releaseAttempt(key: string): void {
		const remaining = (this.attempts.get(key) ?? 1) - 1;
		if (remaining > 0) {
			this.attempts.set(key, remaining);
			return;
		}
		this.attempts.delete(key);
		const record = this.records.get(key);
		if (record?.state === 'removed') this.forget(record);
	}

	private resolveIdle(): void {
		if (!this.idleWaiters.length || !this.idle) return;
		const waiters = this.idleWaiters;
		this.idleWaiters = [];
		for (const resolve of waiters) resolve();
	}
}

/** Discord's shard formula. Returns `undefined` for an id that is not a snowflake. */
export function shardOf(guildId: string, totalShards: number): number | undefined {
	if (!/^\d+$/.test(guildId)) return;
	return Number((BigInt(guildId) >> 22n) % BigInt(totalShards));
}

function advance(generation: Generation, sequence: number): void {
	if (sequence > generation.sequence) generation.sequence = sequence;
}

function emptyOutcomes(): Record<GuildOutcome, number> {
	return { reconciled: 0, 'unavailable-preserved': 0, deleted: 0, failed: 0 };
}
