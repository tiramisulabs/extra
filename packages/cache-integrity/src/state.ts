import type { Adapter, Cache, GatewayDispatchPayload, PluginGatewayDispatchNext } from 'seyfert';
import type { ReconciledAdapter } from './adapter';
import type { AdapterReconciliationController } from './adapter-controller';
import type { CacheOwnershipObserver } from './cache-ownership-observer';
import type { CoordinatorBinding } from './coordinator';
import type { DuplicateFilterObserver } from './duplicate-filter-observer';
import {
	type GatewayMutationContext,
	type GuildTerminalOutcome,
	type ReconciliationLifecycle,
	ReconciliationState,
	type ReconciliationWork,
	type ShardGeneration,
} from './reconciliation-state';
import type { PreparedReconciliation, SnapshotReconciler } from './snapshot-reconciler';

export type CacheIntegrityLifecycle = ReconciliationLifecycle;

export interface CacheIntegrityDiagnostic {
	code: string;
	message: string;
}

export interface CacheIntegrityStatus {
	adapter: 'detached' | 'owned' | 'replaced';
	correlation: {
		failed: number;
		matched: number;
		pending: number;
		settled: number;
	};
	diagnostics: readonly CacheIntegrityDiagnostic[];
	lifecycle: CacheIntegrityLifecycle;
}

export interface CacheIntegrity {
	status(): CacheIntegrityStatus;
	waitForIdle(): Promise<void>;
}

/** @internal */
export type PacketCorrelationOutcome =
	| 'post-cache'
	| 'vetoed'
	| 'downstream-error'
	| 'core-error'
	| 'observer-missing'
	| 'identity-failed'
	| 'adapter-replaced'
	| 'cache-handler-replaced'
	| 'duplicate-filtered'
	| 'duplicate-filter-handler-replaced'
	| 'closing';

/** @internal */
export interface PacketCorrelationRecord {
	readonly event: string;
	readonly generation?: ShardGeneration;
	readonly id: number;
	readonly sequence: number;
	readonly shardId: number;
	readonly outcome?: PacketCorrelationOutcome;
}

interface MutablePacketCorrelationRecord extends PacketCorrelationRecord {
	causalIdentity: string;
	identity?: object;
	outcome?: PacketCorrelationOutcome;
	phase: 'registered' | 'ready' | 'settled';
}

interface CorrelationPacket {
	readonly d?: unknown;
	readonly s: number;
	readonly t: string;
}

type CachePacketHandler = (event: GatewayDispatchPayload) => Promise<void>;

interface Installation {
	cache: Cache;
	cacheOwnership?: CacheOwnershipObserver;
	coordinator?: CoordinatorBinding;
	controller: AdapterReconciliationController;
	duplicateFilters: DuplicateFilterObserver;
	engine: SnapshotReconciler;
	installCacheOwnership: () => CacheOwnershipObserver;
	originalAdapter: Adapter;
	originalOnPacket?: CachePacketHandler;
	wrappedAdapter: ReconciledAdapter;
	wrappedOnPacket?: CachePacketHandler;
}

interface PacketObservation {
	readonly context: GatewayMutationContext;
	prepared?: PreparedReconciliation;
	readonly record: PacketCorrelationRecord;
	work?: ReconciliationWork;
}

const TRACKED_EVENTS = new Set([
	'READY',
	'RAW_GUILD_CREATE',
	'RAW_GUILD_DELETE',
	'GUILD_CREATE',
	'GUILD_UPDATE',
	'GUILD_DELETE',
	'CHANNEL_CREATE',
	'CHANNEL_UPDATE',
	'CHANNEL_DELETE',
	'GUILD_ROLE_CREATE',
	'GUILD_ROLE_UPDATE',
	'GUILD_ROLE_DELETE',
	'GUILD_BAN_ADD',
	'GUILD_BAN_REMOVE',
	'GUILD_EMOJIS_UPDATE',
	'GUILD_STICKERS_UPDATE',
	'GUILD_MEMBERS_CHUNK',
	'GUILD_MEMBER_ADD',
	'GUILD_MEMBER_UPDATE',
	'GUILD_MEMBER_REMOVE',
	'MESSAGE_CREATE',
	'MESSAGE_UPDATE',
	'MESSAGE_DELETE',
	'MESSAGE_DELETE_BULK',
	'PRESENCE_UPDATE',
	'THREAD_CREATE',
	'THREAD_UPDATE',
	'THREAD_DELETE',
	'USER_UPDATE',
	'VOICE_CHANNEL_STATUS_UPDATE',
	'VOICE_STATE_UPDATE',
	'STAGE_INSTANCE_CREATE',
	'STAGE_INSTANCE_UPDATE',
	'STAGE_INSTANCE_DELETE',
]);

const GUILD_ROOT_MUTATION_EVENTS = new Set([
	'RAW_GUILD_CREATE',
	'RAW_GUILD_DELETE',
	'GUILD_CREATE',
	'GUILD_UPDATE',
	'GUILD_DELETE',
]);

function packetIdentity(data: unknown): object | undefined {
	return typeof data === 'object' && data !== null ? data : undefined;
}

function packetGuildId(packet: CorrelationPacket): string | undefined {
	const data = packetIdentity(packet.d);
	if (!data) return;
	const guildId = Reflect.get(data, 'guild_id');
	if (typeof guildId === 'string') return guildId;
	if (
		packet.t === 'RAW_GUILD_CREATE' ||
		packet.t === 'RAW_GUILD_DELETE' ||
		packet.t === 'GUILD_CREATE' ||
		packet.t === 'GUILD_UPDATE' ||
		packet.t === 'GUILD_DELETE'
	) {
		const id = Reflect.get(data, 'id');
		return typeof id === 'string' ? id : undefined;
	}
	return;
}

function readyDetails(packet: CorrelationPacket): { expectedGuildIds: string[]; sessionId: string } {
	const data = packetIdentity(packet.d);
	if (!data) throw new TypeError('READY must contain an object payload.');
	const sessionId = Reflect.get(data, 'session_id');
	const guilds = Reflect.get(data, 'guilds');
	if (typeof sessionId !== 'string' || !Array.isArray(guilds)) {
		throw new TypeError('READY must contain session_id and guilds.');
	}
	return {
		expectedGuildIds: guilds.flatMap(guild => {
			if (!packetIdentity(guild)) return [];
			const id = Reflect.get(guild, 'id');
			return typeof id === 'string' ? [id] : [];
		}),
		sessionId,
	};
}

function packetCausalIdentity(packet: CorrelationPacket): string {
	if (packet.t === 'READY') {
		const details = readyDetails(packet);
		return JSON.stringify(['READY', details.sessionId, [...new Set(details.expectedGuildIds)].sort()]);
	}
	const data = packetIdentity(packet.d);
	if (!data) return JSON.stringify([packet.t]);
	const user = packetIdentity(Reflect.get(data, 'user'));
	const role = packetIdentity(Reflect.get(data, 'role'));
	const messageIds = Reflect.get(data, 'ids');
	return JSON.stringify([
		packet.t,
		packetGuildId(packet),
		Reflect.get(data, 'id'),
		Reflect.get(data, 'channel_id'),
		Reflect.get(data, 'role_id'),
		Reflect.get(data, 'user_id'),
		user ? Reflect.get(user, 'id') : undefined,
		role ? Reflect.get(role, 'id') : undefined,
		Array.isArray(messageIds) ? [...messageIds] : undefined,
	]);
}

/** @internal */
export function isTrackedReconciliationEvent(event: string): boolean {
	return TRACKED_EVENTS.has(event);
}

/** @internal */
export class PacketCorrelation {
	#byIdentity = new WeakMap<object, MutablePacketCorrelationRecord>();
	#failed = 0;
	#matched = 0;
	#nextId = 0;
	#pending = new Set<MutablePacketCorrelationRecord>();
	#settled = 0;
	#waiters = new Set<() => void>();

	preregister(packet: CorrelationPacket, shardId: number, generation?: ShardGeneration): PacketCorrelationRecord {
		const record: MutablePacketCorrelationRecord = {
			causalIdentity: packetCausalIdentity(packet),
			event: packet.t,
			generation,
			id: ++this.#nextId,
			phase: 'registered',
			sequence: packet.s,
			shardId,
		};
		this.#pending.add(record);
		return record;
	}

	bindFinal(record: PacketCorrelationRecord, packet: CorrelationPacket): 'bound' | 'failed' | 'settled' {
		const mutable = record as MutablePacketCorrelationRecord;
		if (mutable.phase === 'settled') return 'settled';
		if (
			packet.t !== mutable.event ||
			packet.s !== mutable.sequence ||
			packetCausalIdentity(packet) !== mutable.causalIdentity
		) {
			this.settle(mutable, 'identity-failed');
			return 'failed';
		}
		const identity = packetIdentity(packet.d);
		const existing = identity ? this.#byIdentity.get(identity) : undefined;
		if (!identity || (existing && existing.phase !== 'settled')) {
			if (existing) this.settle(existing, 'identity-failed');
			this.settle(mutable, 'identity-failed');
			return 'failed';
		}
		mutable.identity = identity;
		mutable.phase = 'ready';
		this.#byIdentity.set(identity, mutable);
		return 'bound';
	}

	lookup(event: Pick<CorrelationPacket, 'd' | 't'>): PacketCorrelationRecord | undefined {
		const identity = packetIdentity(event.d);
		const record = identity ? this.#byIdentity.get(identity) : undefined;
		return record?.phase === 'ready' && record.event === event.t ? record : undefined;
	}

	consume(event: Pick<CorrelationPacket, 'd' | 't'>): PacketCorrelationRecord | undefined {
		const record = this.lookup(event);
		if (!record) return;
		this.#matched++;
		this.settle(record, 'post-cache');
		return record;
	}

	isPending(record: PacketCorrelationRecord): boolean {
		return (record as MutablePacketCorrelationRecord).phase !== 'settled';
	}

	settle(record: PacketCorrelationRecord, outcome: PacketCorrelationOutcome): void {
		const mutable = record as MutablePacketCorrelationRecord;
		if (mutable.phase === 'settled') return;
		mutable.phase = 'settled';
		mutable.outcome = outcome;
		this.#pending.delete(mutable);
		if (mutable.identity) this.#byIdentity.delete(mutable.identity);
		if (!['post-cache', 'vetoed', 'duplicate-filtered', 'closing'].includes(outcome)) this.#failed++;
		this.#settled++;
		if (this.#pending.size === 0) {
			for (const resolve of this.#waiters) resolve();
			this.#waiters.clear();
		}
	}

	cancelAll(outcome: PacketCorrelationOutcome): void {
		for (const record of [...this.#pending]) this.settle(record, outcome);
	}

	status() {
		return { failed: this.#failed, matched: this.#matched, pending: this.#pending.size, settled: this.#settled };
	}

	waitForIdle(): Promise<void> {
		if (this.#pending.size === 0) return Promise.resolve();
		return new Promise(resolve => this.#waiters.add(resolve));
	}
}

/** @internal */
export class CacheIntegrityManager {
	readonly facade: CacheIntegrity;
	readonly state = new ReconciliationState();
	#cacheExecutions = 0;
	#cacheWaiters = new Set<() => void>();
	#closePromise?: Promise<void>;
	#committingGenerations = new Set<number>();
	#coordinatorDeactivated = false;
	#correlation = new PacketCorrelation();
	#diagnosticCodes = new Set<string>();
	#diagnostics: CacheIntegrityDiagnostic[] = [];
	#guildsReadyContexts = new Map<number, GatewayMutationContext>();
	#installation?: Installation;
	#observations = new Map<number, PacketObservation>();
	#releaseRestoration?: () => void;
	#restoration?: Promise<void>;
	#sweptGenerations = new Set<number>();

	constructor() {
		this.facade = Object.freeze({
			status: () => this.status(),
			waitForIdle: () => this.waitForIdle(),
		});
	}

	createCachePacketWrapper(cache: Cache, original: CachePacketHandler): CachePacketHandler {
		return async event => {
			if (this.state.lifecycle === 'closing') {
				await this.#restoration;
				return original.call(cache, event);
			}
			if (this.state.lifecycle === 'closed') return original.call(cache, event);
			this.#cacheExecutions++;
			const record = this.#correlation.lookup(event);
			const observation = record ? this.#observations.get(record.id) : undefined;
			try {
				if (observation && this.#installation) {
					await this.#installation.controller.runWithContext(observation.context, () => original.call(cache, event));
				} else {
					await original.call(cache, event);
				}
			} catch (error) {
				if (record) {
					this.settleObservation(record, 'core-error', 'failure');
					this.failTerminal(
						'core-cache-failed',
						`Seyfert core cache processing failed: ${String(error)}`,
						'core-error',
					);
				}
				throw error;
			} finally {
				this.#cacheExecutions--;
				if (this.#cacheExecutions === 0) {
					for (const resolve of this.#cacheWaiters) resolve();
					this.#cacheWaiters.clear();
				}
			}
			if (record && this.#correlation.isPending(record)) {
				this.settleObservation(record, 'observer-missing', 'failure');
				this.failTerminal(
					'post-cache-observer-missing',
					'Core cache processing completed without the cache integrity post-cache resource.',
					'observer-missing',
				);
			}
		};
	}

	prepare(installation: Installation): void {
		if (this.#installation || this.state.lifecycle !== 'installing') {
			throw new Error('A cache integrity plugin instance can only be installed once.');
		}
		this.#installation = installation;
	}

	beforeStart(): void {
		const installation = this.#installation;
		if (!installation || this.state.lifecycle !== 'installing') {
			throw new Error('The cache integrity is not available to start. Create a new plugin instance.');
		}
		if (!this.ensureOwnership()) throw new Error('The cache integrity lost ownership before adapter start.');
		const originalOnPacket = installation.cache.onPacket;
		const wrappedOnPacket = this.createCachePacketWrapper(installation.cache, originalOnPacket);
		installation.cacheOwnership = installation.installCacheOwnership();
		installation.originalOnPacket = originalOnPacket;
		installation.wrappedOnPacket = wrappedOnPacket;
		installation.cache.onPacket = wrappedOnPacket;
	}

	abortSetup(error: unknown): void {
		this.#installation = undefined;
		this.state.fail();
		this.recordDiagnostic('setup-failed', `Cache integrity setup failed: ${String(error)}`);
	}

	onStarted(): void {
		if (this.state.lifecycle === 'installing' && this.ensureOwnership()) this.state.activate();
	}

	onStartFailed(error: unknown): void {
		this.recordDiagnostic('start-failed', `Cache integrity start failed: ${String(error)}`);
		if (this.state.lifecycle === 'closing' || this.state.lifecycle === 'closed') return;
		this.state.fail();
		this.cancelObservations('core-error');
		this.#correlation.cancelAll('core-error');
	}

	async intercept(
		packet: GatewayDispatchPayload,
		next: PluginGatewayDispatchNext,
		shardId: number,
	): Promise<GatewayDispatchPayload | null> {
		if (this.state.lifecycle !== 'active' || !this.ensureOwnership()) return next();
		if (packet.t === 'RESUMED') return this.interceptResumed(packet, next, shardId);
		if (packet.t === 'GUILDS_READY') return this.interceptGuildsReady(packet, next, shardId);
		if (!isTrackedReconciliationEvent(packet.t)) return next();
		if (packet.t !== 'READY' && !this.state.activeGeneration(shardId)) {
			this.recordDiagnostic(
				'packet-awaiting-ready',
				`Shard ${shardId} dispatched ${packet.t} before this cache integrity instance observed READY.`,
			);
			return next();
		}

		let observation: PacketObservation;
		try {
			observation = this.preregisterPacket(packet, shardId);
		} catch (error) {
			this.failTerminal(
				'packet-bookkeeping-failed',
				`Cache integrity packet bookkeeping failed: ${String(error)}`,
				'identity-failed',
			);
			return next();
		}

		let result: GatewayDispatchPayload | null;
		try {
			result = await next();
		} catch (error) {
			this.settleObservation(observation.record, 'downstream-error', 'failure');
			if (
				observation.record.event === 'READY' &&
				this.state.isCurrentGeneration(observation.context.position.generation)
			) {
				this.failTerminal(
					'ready-downstream-failed',
					`A downstream interceptor rejected READY: ${String(error)}`,
					'downstream-error',
				);
			}
			throw error;
		}
		if (!this.ensureOwnership()) return result;
		const currentGeneration = this.state.isCurrentGeneration(observation.context.position.generation);
		if (result === null) {
			this.settleObservation(observation.record, 'vetoed', 'failure');
			if (observation.record.event === 'READY' && currentGeneration) {
				this.failTerminal('ready-vetoed', 'A downstream interceptor vetoed READY.', 'vetoed');
			}
			return null;
		}
		try {
			const binding = this.#correlation.bindFinal(observation.record, result);
			if (binding === 'failed') {
				this.settleObservation(observation.record, 'identity-failed', 'failure');
				if (observation.record.event === 'READY' && !currentGeneration) return null;
				this.failTerminal(
					'packet-identity-failed',
					'A downstream interceptor changed causal packet metadata or reused a payload identity.',
					'identity-failed',
				);
			} else if (binding === 'bound') {
				this.prepareFinalObservation(observation, result.d);
			}
		} catch (error) {
			this.settleObservation(observation.record, 'identity-failed', 'failure');
			if (observation.record.event === 'READY' && !currentGeneration) return null;
			this.failTerminal(
				'packet-bookkeeping-failed',
				`Cache integrity final packet bookkeeping failed: ${String(error)}`,
				'identity-failed',
			);
		}
		return result;
	}

	async observePostCache(event: Pick<GatewayDispatchPayload, 'd' | 't'>): Promise<void> {
		if (this.state.lifecycle !== 'active' || !this.ensureOwnership()) return;
		const record = this.#correlation.consume(event);
		if (!record) return;
		const observation = this.#observations.get(record.id);
		const installation = this.#installation;
		if (!observation || !installation) return;
		if (!observation.prepared) {
			this.settleObservation(record, 'identity-failed', 'failure');
			this.failTerminal(
				'packet-bookkeeping-missing',
				'Post-cache reconciliation was reached without final packet bookkeeping.',
				'identity-failed',
			);
			return;
		}
		if (!this.state.isCurrentGeneration(observation.context.position.generation)) {
			this.settleObservation(record, 'post-cache');
			return;
		}
		const prepared = observation.prepared;
		try {
			await installation.controller.runWithContext(observation.context, () =>
				installation.engine.reconcilePostCache(observation.context, event.d, prepared),
			);
			this.settleObservation(record, 'post-cache', this.successOutcome(observation, event.d));
		} catch (error) {
			this.recordDiagnostic(
				'post-cache-reconciliation-failed',
				`Post-cache reconciliation failed for ${record.event}: ${String(error)}`,
			);
			this.settleObservation(record, 'post-cache', 'failure');
			throw error;
		}
	}

	observeDuplicateFilter(event: Pick<CorrelationPacket, 'd' | 't'>): void {
		if (this.state.lifecycle !== 'active' || !this.ensureOwnership()) return;
		const record = this.#correlation.lookup(event);
		if (record) this.settleObservation(record, 'duplicate-filtered');
	}

	status(): CacheIntegrityStatus {
		if (this.#installation && this.state.lifecycle !== 'closed') this.ensureOwnership();
		return {
			adapter: this.adapterStatus(),
			correlation: this.#correlation.status(),
			diagnostics: [...this.#diagnostics],
			lifecycle: this.state.lifecycle,
		};
	}

	async waitForIdle(): Promise<void> {
		if (this.#installation && this.state.lifecycle !== 'closed') this.ensureOwnership();
		for (;;) {
			await Promise.all([
				this.#correlation.waitForIdle(),
				this.state.waitForIdle(),
				this.#installation?.wrappedAdapter.waitForIdle(),
				this.waitForCacheExecutions(),
			]);
			await Promise.resolve();
			if (this.#correlation.status().pending === 0 && this.state.pendingWork === 0 && this.#cacheExecutions === 0) {
				await this.#installation?.wrappedAdapter.waitForIdle();
				if (this.#correlation.status().pending === 0 && this.state.pendingWork === 0 && this.#cacheExecutions === 0) {
					return;
				}
			}
		}
	}

	close(): Promise<void> {
		this.#closePromise ??= this.closeOnce();
		return this.#closePromise;
	}

	recordFailure(code: string, error: unknown): void {
		this.recordDiagnostic(code, `${code}: ${String(error)}`);
	}

	onCoordinatorFailure(code: string, error: unknown): void {
		this.failTerminal(code, `Distributed coordinator failed: ${String(error)}`, 'core-error');
	}

	private preregisterPacket(packet: GatewayDispatchPayload, shardId: number): PacketObservation {
		const generation =
			packet.t === 'READY' ? this.openReadyGeneration(packet, shardId) : this.state.activeGeneration(shardId);
		if (!generation) throw new Error(`Shard ${shardId} has no active READY generation.`);
		const position = this.state.observePacket(generation, packet.s);
		const guildId = packetGuildId(packet);
		const context: GatewayMutationContext = {
			event: packet.t,
			guildId,
			mode: 'packet',
			position,
			shardId,
		};
		if (guildId && GUILD_ROOT_MUTATION_EVENTS.has(packet.t)) {
			this.#installation?.controller.supersedeValueDelete(`guild.${guildId}`, position);
		}
		const record = this.#correlation.preregister(packet, shardId, generation);
		const needsWork = packet.t === 'RAW_GUILD_CREATE' || packet.t === 'RAW_GUILD_DELETE';
		const work = needsWork
			? this.state.registerWork({ generation, label: `${packet.t} ${guildId ?? shardId}` })
			: undefined;
		if (work && !this.state.beginWork(work)) throw new Error(`Could not admit ${packet.t} reconciliation work.`);
		const observation = { context, record, work };
		this.#observations.set(record.id, observation);
		return observation;
	}

	private prepareFinalObservation(observation: PacketObservation, data: unknown): void {
		const installation = this.#installation;
		if (!installation) throw new Error('The cache integrity installation is no longer available.');
		if (!this.state.isCurrentGeneration(observation.context.position.generation)) {
			observation.prepared = { cuts: new Map() };
			return;
		}
		const prepared = installation.engine.prepare(observation.context, data);
		observation.prepared = prepared;
		if (observation.work || prepared.cuts.size === 0) return;
		const generation = observation.context.position.generation;
		const work = this.state.registerWork({
			generation,
			label: `${observation.record.event} ${observation.context.guildId ?? observation.context.shardId}`,
		});
		observation.work = work;
		if (!this.state.beginWork(work)) {
			throw new Error(`Could not admit ${observation.record.event} reconciliation work.`);
		}
	}

	private openReadyGeneration(packet: GatewayDispatchPayload, shardId: number): ShardGeneration {
		const details = readyDetails(packet);
		const generation = this.state.openGeneration({
			expectedGuildIds: details.expectedGuildIds,
			sequence: packet.s,
			sessionId: details.sessionId,
			shardId,
		});
		this.#installation?.coordinator?.stageReady?.(generation);
		return generation;
	}

	private async interceptResumed(
		packet: GatewayDispatchPayload,
		next: PluginGatewayDispatchNext,
		shardId: number,
	): Promise<GatewayDispatchPayload | null> {
		try {
			const generation = this.state.resume(shardId, packet.s);
			this.#installation?.coordinator?.stageResumed?.(generation);
			if (!generation) {
				this.recordDiagnostic(
					'resumed-awaiting-ready',
					`Shard ${shardId} resumed without a generation owned by this cache integrity instance.`,
				);
			}
		} catch (error) {
			this.failTerminal(
				'resumed-bookkeeping-failed',
				`RESUMED bookkeeping failed: ${String(error)}`,
				'identity-failed',
			);
		}
		const result = await next();
		if (result && (result.t !== packet.t || result.s !== packet.s)) {
			this.failTerminal(
				'resumed-identity-failed',
				'A downstream interceptor changed RESUMED causal packet metadata.',
				'identity-failed',
			);
		}
		return result;
	}

	private async interceptGuildsReady(
		packet: GatewayDispatchPayload,
		next: PluginGatewayDispatchNext,
		shardId: number,
	): Promise<GatewayDispatchPayload | null> {
		const generation = this.state.activeGeneration(shardId);
		let context: GatewayMutationContext | undefined;
		try {
			if (generation) {
				context = {
					event: packet.t,
					mode: 'snapshot',
					position: this.state.observePacket(generation, packet.s),
					shardId,
				};
			}
		} catch (error) {
			this.failTerminal(
				'guilds-ready-bookkeeping-failed',
				`GUILDS_READY bookkeeping failed: ${String(error)}`,
				'identity-failed',
			);
		}
		let result: GatewayDispatchPayload | null;
		try {
			result = await next();
		} catch (error) {
			if (generation && this.state.isCurrentGeneration(generation)) {
				this.failTerminal(
					'guilds-ready-downstream-failed',
					`A downstream interceptor rejected GUILDS_READY: ${String(error)}`,
					'downstream-error',
				);
			}
			throw error;
		}
		if (!generation || !context || this.state.lifecycle !== 'active' || !this.state.isCurrentGeneration(generation)) {
			return result;
		}
		if (result === null) {
			this.failTerminal('guilds-ready-vetoed', 'A downstream interceptor vetoed GUILDS_READY.', 'vetoed');
			return null;
		}
		if (result.t !== packet.t || result.s !== packet.s) {
			this.failTerminal(
				'guilds-ready-identity-failed',
				'A downstream interceptor changed GUILDS_READY causal packet metadata.',
				'identity-failed',
			);
			return result;
		}
		try {
			this.#guildsReadyContexts.set(generation.id, context);
			this.state.markGuildsReady(generation);
			this.maybeStartStaleSweep(generation);
		} catch (error) {
			this.failTerminal(
				'guilds-ready-bookkeeping-failed',
				`GUILDS_READY bookkeeping failed: ${String(error)}`,
				'identity-failed',
			);
		}
		return result;
	}

	private successOutcome(observation: PacketObservation, data: unknown): GuildTerminalOutcome | undefined {
		if (observation.record.event !== 'RAW_GUILD_CREATE' && observation.record.event !== 'RAW_GUILD_DELETE') return;
		if (!this.#installation?.cache.guilds) return 'disabled-preserved';
		const identity = packetIdentity(data);
		const unavailable = identity ? Reflect.get(identity, 'unavailable') === true : false;
		if (unavailable) return 'unavailable-preserved';
		return observation.record.event === 'RAW_GUILD_DELETE' ? 'deleted' : 'reconciled';
	}

	private settleObservation(
		record: PacketCorrelationRecord,
		outcome: PacketCorrelationOutcome,
		guildOutcome?: GuildTerminalOutcome,
	): void {
		if (this.#correlation.isPending(record)) this.#correlation.settle(record, outcome);
		const observation = this.#observations.get(record.id);
		if (!observation) return;
		this.#observations.delete(record.id);
		if (observation.work) this.state.settleWork(observation.work);
		const guildId = observation.context.guildId;
		const generation = observation.context.position.generation;
		if (
			guildOutcome &&
			guildId &&
			this.state.lifecycle === 'active' &&
			this.state.isCurrentGeneration(generation) &&
			this.state.hasExpectedGuild(generation, guildId)
		) {
			this.state.markGuildOutcome(generation, guildId, guildOutcome);
			this.maybeStartStaleSweep(generation);
		}
	}

	private maybeStartStaleSweep(generation: ShardGeneration): void {
		if (
			this.state.lifecycle !== 'active' ||
			this.#committingGenerations.has(generation.id) ||
			!this.state.generationStatus(generation).committed
		) {
			return;
		}
		const context = this.#guildsReadyContexts.get(generation.id);
		const installation = this.#installation;
		if (!context || !installation) return;
		this.#committingGenerations.add(generation.id);
		const expected = new Set(this.state.generationStatus(generation).expectedGuildIds);
		const work = this.state.registerWork({ generation, label: `commit generation ${generation.shardId}` });
		if (!this.state.beginWork(work)) {
			this.#committingGenerations.delete(generation.id);
			return;
		}
		void Promise.resolve()
			.then(() => installation.coordinator?.commitGeneration?.(generation))
			.then(async () => {
				if (this.state.lifecycle !== 'active' || !this.state.isCurrentGeneration(generation)) return;
				if (!installation.cache.guilds || this.#sweptGenerations.has(generation.id)) return;
				this.#sweptGenerations.add(generation.id);
				try {
					await installation.controller.runWithContext(context, () =>
						installation.engine.reconcileStaleGuilds(context, expected),
					);
				} catch (error) {
					this.recordFailure('stale-guild-sweep-failed', error);
				}
			})
			.catch(error => {
				if (this.state.lifecycle !== 'active' || !this.state.isCurrentGeneration(generation)) return;
				this.failTerminal(
					'distributed-generation-commit-failed',
					`Distributed generation commit failed: ${String(error)}`,
					'core-error',
				);
			})
			.finally(() => {
				this.#committingGenerations.delete(generation.id);
				this.state.settleWork(work);
			});
	}

	private async closeOnce(): Promise<void> {
		if (this.state.lifecycle === 'closed') return;
		this.#restoration = new Promise(resolve => {
			this.#releaseRestoration = resolve;
		});
		if (this.state.lifecycle === 'installing') this.state.fail();
		this.state.beginClosing();
		this.cancelObservations('closing');
		this.#correlation.cancelAll('closing');
		const installation = this.#installation;
		let closeError: unknown;
		try {
			await this.waitForCacheExecutions();
			await this.state.waitForIdle();
			await installation?.wrappedAdapter.close();
		} catch (error) {
			closeError = error;
			this.recordDiagnostic('coordinator-close-failed', `Coordinator close failed: ${String(error)}`);
		} finally {
			if (installation) {
				if (installation.cacheOwnership && !installation.cacheOwnership.restore()) {
					this.recordDiagnostic(
						'cache-ownership-handler-replaced',
						'Teardown left a later cache ownership handler replacement intact.',
					);
				}
				if (!installation.duplicateFilters.restore()) {
					this.recordDiagnostic(
						'duplicate-filter-handler-replaced',
						'Teardown left a later member or presence duplicate-filter replacement intact.',
					);
				}
				if (installation.cache.adapter === installation.wrappedAdapter) {
					installation.cache.adapter = installation.originalAdapter;
				} else {
					this.recordDiagnostic('adapter-replaced', 'Teardown left a later cache adapter replacement intact.');
				}
				if (installation.wrappedOnPacket && installation.cache.onPacket === installation.wrappedOnPacket) {
					installation.cache.onPacket = installation.originalOnPacket!;
				} else if (installation.wrappedOnPacket) {
					this.recordDiagnostic('cache-handler-replaced', 'Teardown left a later cache onPacket replacement intact.');
				}
			}
			this.#installation = undefined;
			try {
				this.state.finishClosing();
			} finally {
				this.#releaseRestoration?.();
			}
		}
		if (closeError !== undefined) throw closeError;
	}

	private ensureOwnership(): boolean {
		const installation = this.#installation;
		if (!installation) return false;
		if (installation.cache.adapter !== installation.wrappedAdapter) {
			this.failTerminal(
				'adapter-replaced',
				'client.cache.adapter was replaced; reconciliation is terminally disabled for this plugin instance.',
				'adapter-replaced',
			);
			return false;
		}
		if (installation.wrappedOnPacket && installation.cache.onPacket !== installation.wrappedOnPacket) {
			this.failTerminal(
				'cache-handler-replaced',
				'client.cache.onPacket was replaced; reconciliation is terminally disabled for this plugin instance.',
				'cache-handler-replaced',
			);
			return false;
		}
		if (!installation.duplicateFilters.owned()) {
			this.failTerminal(
				'duplicate-filter-handler-replaced',
				'A member or presence duplicate-filter handler was replaced; reconciliation is terminally disabled for this plugin instance.',
				'duplicate-filter-handler-replaced',
			);
			return false;
		}
		if (installation.cacheOwnership && !installation.cacheOwnership.owned()) {
			this.failTerminal(
				'cache-ownership-handler-replaced',
				'A cache ownership handler was replaced; reconciliation is terminally disabled for this plugin instance.',
				'cache-handler-replaced',
			);
			return false;
		}
		return true;
	}

	private adapterStatus(): CacheIntegrityStatus['adapter'] {
		const installation = this.#installation;
		if (!installation) return 'detached';
		return installation.cache.adapter === installation.wrappedAdapter ? 'owned' : 'replaced';
	}

	private failTerminal(code: string, message: string, outcome: PacketCorrelationOutcome): void {
		this.recordDiagnostic(code, message);
		if (this.state.lifecycle !== 'closing' && this.state.lifecycle !== 'closed') this.state.fail();
		this.deactivateCoordinator();
		this.cancelObservations(outcome);
		this.#correlation.cancelAll(outcome);
	}

	private deactivateCoordinator(): void {
		if (this.#coordinatorDeactivated) return;
		const coordinator = this.#installation?.coordinator;
		if (!coordinator?.deactivate) return;
		this.#coordinatorDeactivated = true;
		try {
			void Promise.resolve(coordinator.deactivate()).catch(error => {
				this.recordDiagnostic('coordinator-deactivate-failed', `Coordinator deactivation failed: ${String(error)}`);
			});
		} catch (error) {
			this.recordDiagnostic('coordinator-deactivate-failed', `Coordinator deactivation failed: ${String(error)}`);
		}
	}

	private cancelObservations(outcome: PacketCorrelationOutcome): void {
		for (const observation of [...this.#observations.values()]) {
			this.settleObservation(observation.record, outcome);
		}
	}

	private waitForCacheExecutions(): Promise<void> {
		if (this.#cacheExecutions === 0) return Promise.resolve();
		return new Promise(resolve => this.#cacheWaiters.add(resolve));
	}

	private recordDiagnostic(code: string, message: string): void {
		if (this.#diagnosticCodes.has(code)) return;
		this.#diagnosticCodes.add(code);
		this.#diagnostics.push({ code, message });
	}
}
