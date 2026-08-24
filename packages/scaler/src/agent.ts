import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ClientOptions } from 'ws';
import { freezeObserved, isRecord, nonNegativeMs, positiveMs, toError } from './internal';
import {
	type ErrorMessage,
	type HelloAckMessage,
	type IdentifyGrantMessage,
	type LaunchMessage,
	type MasterToAgentMessage,
	SCALER_PROTOCOL_VERSION,
	type StopMessage,
	sameIdentity,
	type WorkerMessage,
} from './protocol';
import { ProcessWorkerRunner, type RunningWorker, type WorkerRunner } from './runner';
import { connectWebSocket, type ProtocolConnection } from './transport';
import type { AllocationIdentity, HostDescriptor, ObservedWorker, RemoteWorkerLaunch, ShardTopology } from './types';

export interface AgentCapacity {
	maxWorkers: number;
}

export interface AgentReconnectOptions {
	initialDelayMs?: number;
	maxDelayMs?: number;
	factor?: number;
	jitter?: number;
}

export interface ScalerAgentTransportPolicy {
	tls?: ClientOptions & { servername?: string };
	connectTimeoutMs?: number;
	handshakeTimeoutMs?: number;
	allowInsecureTransport?: boolean;
}

export interface ScalerAgentConnectionPolicy {
	heartbeatIntervalMs?: number;
	reconnect?: AgentReconnectOptions;
	respawn?: AgentReconnectOptions;
}

export interface ScalerAgentOptions {
	hostId: string;
	host: string;
	port: number;
	authToken: string;
	bootId?: string;
	capacity: AgentCapacity;
	transport?: ScalerAgentTransportPolicy;
	connection?: ScalerAgentConnectionPolicy;
	runner?: WorkerRunner;
	/** @internal */
	randomId?: () => string;
}

export type AgentConnectionState = 'authenticated' | 'connecting' | 'disconnected' | 'stopped';

interface Execution {
	workerId: number;
	identity: AllocationIdentity;
	topology: ShardTopology;
	launch: RemoteWorkerLaunch;
	running?: RunningWorker;
	ready: boolean;
	restarted: boolean;
	restartAttempt: number;
	heartbeatAcknowledged: boolean;
	intentionalStop: boolean;
	respawnAllowed: boolean;
	launchRequestId?: string;
}

interface PendingIdentify {
	execution: Execution;
	shardId: number;
	requestId?: string;
}

/** @internal */
export type AgentSpawnShardsPayload = {
	type: 'SPAWN_SHARDS';
	info: RemoteWorkerLaunch['workerData']['info'];
	compress: RemoteWorkerLaunch['workerData']['compress'];
};

/** @internal */
export type AgentAllowConnectPayload = {
	type: 'ALLOW_CONNECT';
	shardId: number;
};

/** @internal */
export type AgentHeartbeatPayload = { type: 'HEARTBEAT' };

interface ResolvedReconnectOptions {
	initialDelayMs: number;
	maxDelayMs: number;
	factor: number;
	jitter: number;
}

/** @internal */
export const CLASSIC_INTERNAL_MESSAGE_TYPES = [
	'ACK_HEARTBEAT',
	'CONNECT_QUEUE',
	'DISCONNECTED_ALL_SHARDS_RESHARDING',
	'WORKER_READY',
	'WORKER_SHARDS_CONNECTED',
	'WORKER_START',
] as const;

const CLASSIC_INTERNAL_MESSAGES = new Set<string>(CLASSIC_INTERNAL_MESSAGE_TYPES);

export class ScalerAgent extends EventEmitter<{
	error: [error: Error];
	state: [state: AgentConnectionState];
	workerExit: [worker: ObservedWorker, code: number | null, signal: NodeJS.Signals | null];
	workerReady: [worker: ObservedWorker];
}> {
	readonly descriptor: HostDescriptor;
	private readonly runner: WorkerRunner;
	private readonly randomId: () => string;
	private readonly reconnect: ResolvedReconnectOptions;
	private readonly respawn: ResolvedReconnectOptions;
	private readonly heartbeatIntervalMs: number;
	private readonly executions = new Map<number, Execution>();
	private readonly pendingIdentifies = new Map<string, PendingIdentify>();
	private connection?: ProtocolConnection;
	private connectionState: AgentConnectionState = 'stopped';
	private connectAbort?: AbortController;
	private reconnectTimer?: NodeJS.Timeout;
	private readonly respawnTimers = new Set<NodeJS.Timeout>();
	private heartbeatTimer?: NodeJS.Timeout;
	private handshakeTimer?: NodeJS.Timeout;
	private reconnectAttempt = 0;
	private started = false;
	private session = 0;
	private inbound = Promise.resolve();
	private spawnAbort = new AbortController();
	private stopPromise?: Promise<void>;

	constructor(readonly options: ScalerAgentOptions) {
		super();
		this.on('error', () => undefined);
		assertOptions(options);
		this.randomId = options.randomId ?? randomUUID;
		this.descriptor = Object.freeze({
			hostId: options.hostId,
			bootId: options.bootId ?? this.randomId(),
			maxWorkers: options.capacity.maxWorkers,
		});
		this.runner = options.runner ?? new ProcessWorkerRunner();
		this.reconnect = resolveBackoff(options.connection?.reconnect, 500, 30_000);
		this.respawn = resolveBackoff(options.connection?.respawn, 1_000, 30_000);
		this.heartbeatIntervalMs = nonNegativeMs(options.connection?.heartbeatIntervalMs ?? 15_000, 'heartbeatIntervalMs');
	}

	get state() {
		return this.connectionState;
	}

	get workers(): readonly ObservedWorker[] {
		return [...this.executions.values()].filter(execution => !execution.running?.exited).map(observe);
	}

	async start() {
		if (this.stopPromise) await this.stopPromise;
		if (this.started) return;
		if (this.spawnAbort.signal.aborted) this.spawnAbort = new AbortController();
		this.session++;
		this.started = true;
		this.startHeartbeat();
		try {
			await this.connect();
		} catch (error) {
			if (this.state === 'connecting') this.setState('disconnected');
			this.scheduleReconnect();
			throw error;
		}
	}

	async stop() {
		if (this.stopPromise) return this.stopPromise;
		if (!this.started && this.connectionState === 'stopped' && this.executions.size === 0) return;
		const stopPromise = this.stopInternal();
		this.stopPromise = stopPromise;
		try {
			await stopPromise;
		} finally {
			if (this.stopPromise === stopPromise) this.stopPromise = undefined;
		}
	}

	private async stopInternal() {
		this.started = false;
		this.spawnAbort.abort(new Error('Agent stopped'));
		for (const respawnTimer of this.respawnTimers) clearTimeout(respawnTimer);
		this.respawnTimers.clear();
		this.clearConnectionTimers();
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = undefined;
		this.connectAbort?.abort();
		this.connection?.close();
		this.connection = undefined;
		await this.inbound.catch(() => undefined);
		const executions = [...this.executions.values()];
		for (const execution of executions) {
			execution.intentionalStop = true;
			execution.respawnAllowed = false;
		}
		const results = await Promise.allSettled(executions.map(execution => execution.running?.stop(true)));
		this.executions.clear();
		this.pendingIdentifies.clear();
		this.setState('stopped');
		const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
		if (failures.length)
			throw new AggregateError(
				failures.map(result => result.reason),
				'Failed to stop scaler workers',
			);
	}

	private async connect() {
		if (!this.started || this.state === 'connecting' || this.state === 'authenticated') return;
		this.setState('connecting');
		const controller = new AbortController();
		this.connectAbort = controller;
		const connection = await connectWebSocket(
			{
				host: this.options.host,
				port: this.options.port,
				hostId: this.descriptor.hostId,
				authToken: this.options.authToken,
				tls: this.options.transport?.tls,
				allowInsecureTransport: this.options.transport?.allowInsecureTransport,
				connectTimeoutMs: this.options.transport?.connectTimeoutMs,
			},
			controller.signal,
		);
		if (!this.started) {
			connection.close();
			return;
		}
		this.connectAbort = undefined;
		this.connection = connection;
		connection.on('message', message => this.receive(message as MasterToAgentMessage));
		connection.on('error', error => {
			this.emit('error', error);
			connection.close(1002, 'protocol error');
		});
		connection.once('close', () => this.disconnected(connection));
		let authenticated: ((state: AgentConnectionState) => void) | undefined;
		let closed: (() => void) | undefined;
		const handshake = new Promise<void>((resolve, reject) => {
			const timeoutMs = positiveMs(this.options.transport?.handshakeTimeoutMs ?? 10_000, 'handshakeTimeoutMs');
			this.handshakeTimer = setTimeout(() => reject(new Error('Scaler master handshake timed out')), timeoutMs);
			authenticated = (state: AgentConnectionState) => {
				if (state !== 'authenticated') return;
				resolve();
			};
			closed = () => reject(new Error('Scaler connection closed before HELLO_ACK'));
			this.on('state', authenticated);
			connection.once('close', closed);
		});
		await connection.send({
			type: 'HELLO',
			version: SCALER_PROTOCOL_VERSION,
			host: { ...this.descriptor },
			workers: [...this.workers],
		});
		try {
			await handshake;
		} catch (error) {
			connection.terminate();
			throw error;
		} finally {
			if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
			this.handshakeTimer = undefined;
			if (authenticated) this.off('state', authenticated);
			if (closed) connection.off('close', closed);
		}
	}

	private receive(message: MasterToAgentMessage) {
		if (message.type === 'HELLO_ACK') {
			this.authenticated(message);
			return;
		}
		if (message.type === 'ERROR') {
			this.emit('error', new Error(`Scaler master ${message.code}: ${message.message}`));
			return;
		}
		if (!this.started) return;
		if (this.state !== 'authenticated') {
			this.emit('error', new Error(`Received ${message.type} before HELLO_ACK`));
			return;
		}
		this.inbound = this.inbound
			.then(async () => {
				switch (message.type) {
					case 'LAUNCH':
						await this.launch(message);
						break;
					case 'STOP':
						await this.stopWorker(message);
						break;
					case 'IDENTIFY_GRANT':
						await this.grantIdentify(message);
						break;
					case 'WORKER_MSG':
						await this.deliverWorkerMessage(message);
						break;
					default:
						throw new Error(`Master sent agent-only message ${(message as { type: string }).type}`);
				}
			})
			.catch(error => {
				this.emit('error', toError(error));
			});
	}

	private authenticated(_message: HelloAckMessage) {
		if (!this.connection) return;
		this.reconnectAttempt = 0;
		this.setState('authenticated');
		for (const pending of this.pendingIdentifies.values()) this.requestIdentify(pending);
		for (const execution of this.executions.values()) {
			if (execution.ready) void this.sendReady(execution);
		}
	}

	private async launch(message: LaunchMessage) {
		if (message.launch.workerData.resharding === true) {
			await this.sendError(
				'UNSUPPORTED_WORKER_MODE',
				'@slipher/scaler does not support workerData.resharding=true',
				message.requestId,
			);
			return;
		}
		const existing = this.executions.get(message.workerId);
		if (existing) {
			if (!sameIdentity(existing.identity, message.identity)) {
				await this.sendError(
					'STALE_WORKER',
					`Worker ${message.workerId} already has a live allocation`,
					message.requestId,
				);
				return;
			}
			if (existing.ready) await this.sendReady(existing);
			return;
		}
		if (this.executions.size >= this.descriptor.maxWorkers) {
			await this.sendError('CAPACITY_EXCEEDED', `Host ${this.descriptor.hostId} is at capacity`, message.requestId);
			return;
		}
		if (message.launch.workerData.mode !== 'clusters' || message.launch.workerData.workerProxy) {
			await this.sendError(
				'UNSUPPORTED_WORKER_MODE',
				'@slipher/scaler requires mode "clusters" with workerProxy disabled; use normal REST clients inside the worker',
				message.requestId,
			);
			return;
		}
		try {
			await this.spawnExecution({
				workerId: message.workerId,
				identity: { ...message.identity },
				topology: { ...message.topology },
				launch: cloneLaunch(message.launch),
				ready: false,
				restarted: false,
				restartAttempt: 0,
				heartbeatAcknowledged: true,
				intentionalStop: false,
				respawnAllowed: true,
				launchRequestId: message.requestId,
			});
		} catch (error) {
			await this.sendError('WORKER_FAILED', toError(error).message, message.requestId);
		}
	}

	private async spawnExecution(execution: Execution) {
		this.executions.set(execution.workerId, execution);
		try {
			execution.running = await this.runner.spawn(
				{
					workerId: execution.workerId,
					identity: execution.identity,
					topology: execution.topology,
					launch: execution.launch,
				},
				{
					onMessage: message => void this.handleWorkerMessage(execution, message),
					onError: error => this.emit('error', error),
					onExit: (code, signal) => this.workerExited(execution, code, signal),
				},
				this.spawnAbort.signal,
			);
		} catch (error) {
			if (this.executions.get(execution.workerId) === execution) this.executions.delete(execution.workerId);
			throw error;
		}
	}

	private async stopWorker(message: StopMessage) {
		const execution = this.executions.get(message.workerId);
		if (!execution || !sameIdentity(execution.identity, message.identity)) {
			await this.sendError('STALE_WORKER', `Worker ${message.workerId} token is not current`, message.requestId);
			return;
		}
		execution.intentionalStop = true;
		execution.respawnAllowed = false;
		await execution.running?.stop(true);
	}

	private async deliverWorkerMessage(message: WorkerMessage) {
		const execution = this.executions.get(message.workerId);
		if (!execution || !sameIdentity(execution.identity, message.identity)) {
			await this.sendError('STALE_WORKER', `Worker ${message.workerId} token is not current`);
			return;
		}
		await execution.running?.postMessage(message.body);
	}

	private async handleWorkerMessage(execution: Execution, raw: unknown) {
		if (this.executions.get(execution.workerId) !== execution) return;
		if (!isRecord(raw) || typeof raw.type !== 'string') {
			await this.sendWorkerMessage(execution, raw);
			return;
		}
		if (typeof raw.workerId === 'number' && raw.workerId !== execution.workerId) {
			this.emit('error', new Error(`Worker ${execution.workerId} sent mismatched workerId ${raw.workerId}`));
			return;
		}
		switch (raw.type) {
			case 'WORKER_START': {
				const spawnShards: AgentSpawnShardsPayload = {
					type: 'SPAWN_SHARDS',
					compress: execution.launch.workerData.compress,
					info: {
						...execution.launch.workerData.info,
						// WorkerClient copies info.shards into IDENTIFY; it must match the assigned topology, not Discord's recommendation.
						shards: execution.topology.totalShards,
					},
				};
				await execution.running?.postMessage(spawnShards);
				break;
			}
			case 'CONNECT_QUEUE':
				if (!Number.isSafeInteger(raw.shardId) || !containsShard(execution.topology, raw.shardId as number)) {
					await this.failUnsupported(execution, `Worker requested invalid shard ${String(raw.shardId)}`);
					return;
				}
				this.queueIdentify(execution, raw.shardId as number);
				break;
			case 'WORKER_READY':
				execution.ready = true;
				execution.restartAttempt = 0;
				await this.sendReady(execution);
				execution.launchRequestId = undefined;
				this.emit('workerReady', observe(execution));
				break;
			case 'ACK_HEARTBEAT':
				execution.heartbeatAcknowledged = true;
				break;
			case 'WORKER_SHARDS_CONNECTED':
			case 'DISCONNECTED_ALL_SHARDS_RESHARDING':
				break;
			case 'CACHE_REQUEST':
				await this.failUnsupported(
					execution,
					'WorkerAdapter is not supported by @slipher/scaler; use a local cache or @slipher/redis-adapter',
				);
				break;
			case 'WORKER_API_REQUEST':
				await this.failUnsupported(execution, 'workerProxy is not supported by @slipher/scaler');
				break;
			default:
				if (!CLASSIC_INTERNAL_MESSAGES.has(raw.type)) await this.sendWorkerMessage(execution, raw);
		}
	}

	private queueIdentify(execution: Execution, shardId: number) {
		const key = identifyKey(execution.identity, shardId);
		if (this.pendingIdentifies.has(key)) return;
		const pending = { execution, shardId };
		this.pendingIdentifies.set(key, pending);
		this.requestIdentify(pending);
	}

	private requestIdentify(pending: PendingIdentify) {
		if (this.state !== 'authenticated' || !this.connection?.open) return;
		pending.requestId = this.randomId();
		void this.connection
			.send({
				type: 'IDENTIFY_REQUEST',
				version: SCALER_PROTOCOL_VERSION,
				requestId: pending.requestId,
				workerId: pending.execution.workerId,
				identity: { ...pending.execution.identity },
				shardId: pending.shardId,
				maxConcurrency: pending.execution.launch.workerData.info.session_start_limit.max_concurrency,
			})
			.catch(error => {
				this.emit('error', error);
			});
	}

	private async grantIdentify(message: IdentifyGrantMessage) {
		const pending = this.pendingIdentifies.get(identifyKey(message.identity, message.shardId));
		if (
			!pending ||
			pending.requestId !== message.requestId ||
			pending.execution.workerId !== message.workerId ||
			!sameIdentity(pending.execution.identity, message.identity)
		) {
			return;
		}
		this.pendingIdentifies.delete(identifyKey(message.identity, message.shardId));
		const allowConnect: AgentAllowConnectPayload = { type: 'ALLOW_CONNECT', shardId: message.shardId };
		await pending.execution.running?.postMessage(allowConnect);
	}

	private workerExited(execution: Execution, code: number | null, signal: NodeJS.Signals | null) {
		if (this.executions.get(execution.workerId) !== execution) return;
		this.executions.delete(execution.workerId);
		this.deletePendingIdentifies(execution);
		const observed = observe(execution);
		this.emit('workerExit', observed, code, signal);
		void this.send({
			type: 'WORKER_STATUS',
			version: SCALER_PROTOCOL_VERSION,
			workerId: execution.workerId,
			identity: { ...execution.identity },
			topology: { ...execution.topology },
			status: 'exited',
			code,
			signal,
		}).catch(error => this.emit('error', error));
		if (!this.started || execution.intentionalStop || !execution.respawnAllowed) return;
		this.scheduleRespawn(execution);
	}

	private scheduleRespawn(execution: Execution) {
		const delay = backoff(execution.restartAttempt, this.respawn);
		const session = this.session;
		const respawnTimer = setTimeout(() => {
			this.respawnTimers.delete(respawnTimer);
			if (!this.started || this.session !== session || this.executions.has(execution.workerId)) return;
			const replacement: Execution = {
				...execution,
				identity: { slot: execution.identity.slot, token: this.randomId() },
				running: undefined,
				ready: false,
				restarted: true,
				restartAttempt: execution.restartAttempt + 1,
				heartbeatAcknowledged: true,
				intentionalStop: false,
				launchRequestId: undefined,
			};
			void this.spawnExecution(replacement).catch(error => {
				this.emit('error', toError(error));
				if (this.started && this.session === session && replacement.respawnAllowed) {
					this.scheduleRespawn(replacement);
				}
			});
		}, delay);
		this.respawnTimers.add(respawnTimer);
	}

	private async failUnsupported(execution: Execution, message: string) {
		execution.respawnAllowed = false;
		await this.sendError('UNSUPPORTED_WORKER_MODE', message, execution.launchRequestId);
		this.emit('error', new Error(message));
		await execution.running?.stop(false);
	}

	private startHeartbeat() {
		if (this.heartbeatIntervalMs === 0) return;
		this.heartbeatTimer = setInterval(() => {
			for (const execution of this.executions.values()) {
				if (!execution.running || execution.running.exited) continue;
				if (!execution.heartbeatAcknowledged) {
					this.emit('error', new Error(`Worker ${execution.workerId} missed a heartbeat`));
					void execution.running.stop(false).catch(error => this.emit('error', toError(error)));
					continue;
				}
				execution.heartbeatAcknowledged = false;
				const heartbeat: AgentHeartbeatPayload = { type: 'HEARTBEAT' };
				void execution.running.postMessage(heartbeat).catch(error => this.emit('error', toError(error)));
			}
		}, this.heartbeatIntervalMs);
	}

	private async sendReady(execution: Execution) {
		await this.send({
			type: 'WORKER_STATUS',
			version: SCALER_PROTOCOL_VERSION,
			workerId: execution.workerId,
			identity: { ...execution.identity },
			topology: { ...execution.topology },
			status: 'ready',
			...(execution.restarted ? { restarted: true as const } : {}),
		});
	}

	private async sendWorkerMessage(execution: Execution, body: unknown) {
		await this.send({
			type: 'WORKER_MSG',
			version: SCALER_PROTOCOL_VERSION,
			workerId: execution.workerId,
			identity: { ...execution.identity },
			body,
		});
	}

	private async sendError(code: ErrorMessage['code'], message: string, requestId?: string) {
		await this.send({
			type: 'ERROR',
			version: SCALER_PROTOCOL_VERSION,
			code,
			message,
			...(requestId ? { requestId } : {}),
		});
	}

	private async send(message: Parameters<ProtocolConnection['send']>[0]) {
		if (this.state !== 'authenticated' || !this.connection?.open) return;
		await this.connection.send(message);
	}

	private disconnected(connection: ProtocolConnection) {
		if (this.connection !== connection) return;
		this.connection = undefined;
		for (const pending of this.pendingIdentifies.values()) pending.requestId = undefined;
		if (!this.started) {
			this.setState('stopped');
			return;
		}
		this.setState('disconnected');
		this.scheduleReconnect();
	}

	private scheduleReconnect() {
		if (!this.started || this.reconnectTimer) return;
		const delay = backoff(this.reconnectAttempt++, this.reconnect);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			void this.connect().catch(error => {
				this.emit('error', toError(error));
				this.setState('disconnected');
				this.scheduleReconnect();
			});
		}, delay);
	}

	private clearConnectionTimers() {
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
		this.reconnectTimer = undefined;
		this.handshakeTimer = undefined;
	}

	private deletePendingIdentifies(execution: Execution) {
		for (const [key, pending] of this.pendingIdentifies) {
			if (pending.execution === execution) this.pendingIdentifies.delete(key);
		}
	}

	private setState(state: AgentConnectionState) {
		if (this.connectionState === state) return;
		this.connectionState = state;
		this.emit('state', state);
	}
}

function assertOptions(options: ScalerAgentOptions) {
	if (!options.hostId || !options.host || !options.authToken)
		throw new TypeError('Agent hostId, host, and authToken are required');
	if (!Number.isSafeInteger(options.port) || options.port <= 0 || options.port > 65_535) {
		throw new RangeError('Agent port must be between 1 and 65535');
	}
	if (!Number.isSafeInteger(options.capacity.maxWorkers) || options.capacity.maxWorkers <= 0) {
		throw new RangeError('Agent maxWorkers must be a positive integer');
	}
}

function resolveBackoff(options: AgentReconnectOptions | undefined, initial: number, maximum: number) {
	const resolved = {
		initialDelayMs: options?.initialDelayMs ?? initial,
		maxDelayMs: options?.maxDelayMs ?? maximum,
		factor: options?.factor ?? 2,
		jitter: options?.jitter ?? 0.2,
	};
	if (
		!Number.isFinite(resolved.initialDelayMs) ||
		resolved.initialDelayMs < 0 ||
		!Number.isFinite(resolved.maxDelayMs) ||
		resolved.maxDelayMs < resolved.initialDelayMs ||
		!Number.isFinite(resolved.factor) ||
		resolved.factor < 1 ||
		!Number.isFinite(resolved.jitter) ||
		resolved.jitter < 0 ||
		resolved.jitter > 1
	) {
		throw new RangeError('Invalid reconnect backoff configuration');
	}
	return resolved;
}

function backoff(attempt: number, options: ResolvedReconnectOptions) {
	const base = Math.min(options.maxDelayMs, options.initialDelayMs * options.factor ** attempt);
	const spread = base * options.jitter;
	return Math.max(0, Math.round(base - spread + Math.random() * spread * 2));
}

function observe(execution: Execution): ObservedWorker {
	return freezeObserved({
		workerId: execution.workerId,
		identity: execution.identity,
		topology: execution.topology,
		ready: execution.ready,
	});
}

function cloneLaunch(launch: RemoteWorkerLaunch): RemoteWorkerLaunch {
	return {
		workerData: structuredClone(launch.workerData),
		...(launch.env ? { env: structuredClone(launch.env) } : {}),
	};
}

function identifyKey(identity: AllocationIdentity, shardId: number) {
	return `${identity.slot.length}:${identity.slot}:${identity.token.length}:${identity.token}:${shardId}`;
}

function containsShard(topology: ShardTopology, shardId: number) {
	return shardId >= topology.shardStart && shardId < topology.shardEnd;
}
