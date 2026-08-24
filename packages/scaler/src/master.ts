import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { TlsOptions } from 'node:tls';
import { freezeObserved, positiveMs, toError } from './internal';
import {
	authenticationTokensEqual,
	type ErrorMessage,
	type HelloMessage,
	type IdentifyRequestMessage,
	type LaunchMessage,
	type MasterToAgentMessage,
	SCALER_PROTOCOL_VERSION,
	type ScalerProtocolMessage,
	sameIdentity,
	type WorkerMessage,
	type WorkerStatusMessage,
} from './protocol';
import { bearerToken, isLoopbackHost, type ProtocolConnection, WebSocketTransportServer } from './transport';
import type {
	AllocationIdentity,
	ConnectedScalerHost,
	HostDescriptor,
	ObservedWorker,
	PlacementLocation,
	RemoteWorkerLaunch,
	ShardTopology,
} from './types';

export interface ScalerMasterTransportPolicy {
	tls?: TlsOptions;
	allowInsecureTransport?: boolean;
	handshakeTimeoutMs?: number;
}

export interface ScalerMasterLivenessPolicy {
	pingIntervalMs?: number;
	hostTimeoutMs?: number;
	requestTimeoutMs?: number;
}

export interface ScalerMasterOptions {
	authToken: string | Readonly<Record<string, string>>;
	host?: string;
	port?: number;
	masterId?: string;
	transport?: ScalerMasterTransportPolicy;
	liveness?: ScalerMasterLivenessPolicy;
	/** @internal */
	randomId?: () => string;
	/** @internal */
	now?: () => number;
}

interface HostConnection {
	connection: ProtocolConnection;
	headerHostId?: string;
	descriptor?: HostDescriptor;
	connectedAt: number;
	lastSeenAt: number;
	observed: Map<number, ObservedWorker>;
	respawns: Map<number, { slot: string; previousToken: string; topology: ShardTopology }>;
	handshakeTimer: NodeJS.Timeout;
	inbound: Promise<void>;
}

interface Route {
	host: HostConnection;
	workerId: number;
	identity: AllocationIdentity;
}

interface PendingRequest extends Route {
	requestId: string;
	kind: 'launch' | 'stop';
	timer: NodeJS.Timeout;
	resolve(): void;
	reject(error: Error): void;
}

interface PendingIdentifyGrant {
	host: HostConnection;
	message: IdentifyRequestMessage;
}

interface IdentifyBucket {
	availableAt: number;
	queue: PendingIdentifyGrant[];
	timer?: NodeJS.Timeout;
	sending: boolean;
}

const IDENTIFY_GATE_MS = 5_500;

export class ScalerMaster extends EventEmitter<{
	error: [error: Error];
	hostConnected: [host: HostDescriptor];
	hostDisconnected: [host: HostDescriptor];
	hostSnapshot: [host: HostDescriptor, workers: readonly ObservedWorker[]];
	workerReady: [
		workerId: number,
		identity: AllocationIdentity,
		topology: ShardTopology,
		target: PlacementLocation,
		restarted: boolean,
	];
	workerExit: [
		workerId: number,
		identity: AllocationIdentity,
		code: number | null,
		signal: NodeJS.Signals | null,
		target: PlacementLocation,
	];
	workerMessage: [workerId: number, identity: AllocationIdentity, body: unknown, target: PlacementLocation];
}> {
	readonly masterId: string;
	private readonly server: WebSocketTransportServer;
	private readonly randomId: () => string;
	private readonly now: () => number;
	private readonly pingIntervalMs: number;
	private readonly hostTimeoutMs: number;
	private readonly requestTimeoutMs: number;
	private readonly connections = new Set<HostConnection>();
	private readonly hostsById = new Map<string, HostConnection>();
	private readonly routes = new Map<number, Route>();
	private readonly pending = new Map<string, PendingRequest>();
	private readonly identifyBuckets = new Map<number, IdentifyBucket>();
	private pingTimer?: NodeJS.Timeout;
	private listening = false;

	constructor(readonly options: ScalerMasterOptions) {
		super();
		this.on('error', () => undefined);
		assertOptions(options);
		this.randomId = options.randomId ?? randomUUID;
		this.now = options.now ?? Date.now;
		this.masterId = options.masterId ?? this.randomId();
		if (!this.masterId) throw new TypeError('Scaler masterId cannot be empty');
		this.pingIntervalMs = positiveMs(options.liveness?.pingIntervalMs ?? 5_000, 'pingIntervalMs');
		this.hostTimeoutMs = positiveMs(options.liveness?.hostTimeoutMs ?? 20_000, 'hostTimeoutMs');
		this.requestTimeoutMs = positiveMs(options.liveness?.requestTimeoutMs ?? 300_000, 'requestTimeoutMs');
		if (this.hostTimeoutMs <= this.pingIntervalMs) throw new RangeError('hostTimeoutMs must exceed pingIntervalMs');
		const host = options.host ?? '127.0.0.1';
		if (!options.transport?.tls && !options.transport?.allowInsecureTransport && !isLoopbackHost(host)) {
			throw new Error('Remote scaler listeners require TLS unless allowInsecureTransport is true');
		}
		this.server = new WebSocketTransportServer({
			host,
			port: options.port,
			tls: options.transport?.tls,
			authenticate: request => this.authenticate(request),
		});
		this.server.on('connection', (connection, request) => this.accept(connection, request));
		this.server.on('error', error => this.emit('error', error));
	}

	get hosts(): ReadonlyMap<string, ConnectedScalerHost> {
		return new Map(
			[...this.hostsById].flatMap(([hostId, host]) =>
				host.descriptor
					? [
							[
								hostId,
								{
									descriptor: { ...host.descriptor },
									connectedAt: host.connectedAt,
									lastSeenAt: host.lastSeenAt,
									observed: [...host.observed.values()],
								},
							] as const,
						]
					: [],
			),
		);
	}

	async listen() {
		if (this.listening) return;
		const address = await this.server.listen();
		this.listening = true;
		this.pingTimer = setInterval(() => this.checkHosts(), this.pingIntervalMs);
		return address;
	}

	async close() {
		if (this.pingTimer) clearInterval(this.pingTimer);
		this.pingTimer = undefined;
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error('Scaler master closed'));
		}
		this.pending.clear();
		for (const bucket of this.identifyBuckets.values()) {
			if (bucket.timer) clearTimeout(bucket.timer);
		}
		this.identifyBuckets.clear();
		for (const host of this.connections) host.connection.terminate();
		this.connections.clear();
		this.hostsById.clear();
		this.routes.clear();
		await this.server.close();
		this.listening = false;
	}

	async launch(
		target: PlacementLocation,
		workerId: number,
		identity: AllocationIdentity,
		topology: ShardTopology,
		launch: RemoteWorkerLaunch,
	) {
		const host = this.requireHost(target);
		host.respawns.delete(workerId);
		const current = host.observed.get(workerId);
		if (current && !sameIdentity(current.identity, identity)) {
			throw new Error(`Host ${target.hostId} already runs worker ${workerId}`);
		}
		if (!current && host.observed.size >= host.descriptor!.maxWorkers) {
			throw new Error(`Host ${target.hostId} is at capacity`);
		}
		const requestId = this.randomId();
		const message: LaunchMessage = {
			type: 'LAUNCH',
			version: SCALER_PROTOCOL_VERSION,
			requestId,
			workerId,
			identity: { ...identity },
			topology: { ...topology },
			launch: structuredClone(launch),
		};
		host.observed.set(workerId, freezeObserved({ workerId, identity, topology, ready: false }));
		try {
			await this.request(host, workerId, identity, requestId, 'launch', message);
		} catch (error) {
			if (sameIdentity(host.observed.get(workerId)?.identity ?? emptyIdentity, identity))
				host.observed.delete(workerId);
			throw error;
		}
	}

	async stop(target: PlacementLocation, workerId: number, identity: AllocationIdentity) {
		const host = this.requireHost(target);
		const observed = host.observed.get(workerId);
		if (!observed || !sameIdentity(observed.identity, identity)) {
			throw new Error(`Worker ${workerId} token is not current on host ${target.hostId}`);
		}
		const route = this.routes.get(workerId);
		if (route && route.host === host && sameIdentity(route.identity, identity)) this.routes.delete(workerId);
		const requestId = this.randomId();
		await this.request(host, workerId, identity, requestId, 'stop', {
			type: 'STOP',
			version: SCALER_PROTOCOL_VERSION,
			requestId,
			workerId,
			identity: { ...identity },
		});
	}

	async postMessage(target: PlacementLocation, workerId: number, identity: AllocationIdentity, body: unknown) {
		const host = this.requireHost(target);
		const route = this.routes.get(workerId);
		if (!route || route.host !== host || !sameIdentity(route.identity, identity)) {
			throw new Error(`Worker ${workerId} is not routed to ${target.hostId}`);
		}
		const message: WorkerMessage = {
			type: 'WORKER_MSG',
			version: SCALER_PROTOCOL_VERSION,
			workerId,
			identity: { ...identity },
			body,
		};
		await host.connection.send(message);
	}

	private authenticate(request: IncomingMessage) {
		const hostId = singleHeader(request.headers['x-scaler-host-id']);
		const actual = bearerToken(request);
		if (!hostId || !actual) return false;
		const expected =
			typeof this.options.authToken === 'string' ? this.options.authToken : this.options.authToken[hostId];
		return Boolean(expected && authenticationTokensEqual(actual, expected));
	}

	private accept(connection: ProtocolConnection, request: IncomingMessage) {
		const connectedAt = this.now();
		const host: HostConnection = {
			connection,
			headerHostId: singleHeader(request.headers['x-scaler-host-id']),
			connectedAt,
			lastSeenAt: connectedAt,
			observed: new Map(),
			respawns: new Map(),
			handshakeTimer: setTimeout(
				() => connection.close(1008, 'HELLO timeout'),
				positiveMs(this.options.transport?.handshakeTimeoutMs ?? 10_000, 'handshakeTimeoutMs'),
			),
			inbound: Promise.resolve(),
		};
		this.connections.add(host);
		connection.on('pong', () => (host.lastSeenAt = this.now()));
		connection.on('message', message => {
			host.lastSeenAt = this.now();
			host.inbound = host.inbound
				.then(() => this.receive(host, message))
				.catch(error => {
					this.emit('error', toError(error));
					connection.close(1002, 'invalid protocol state');
				});
		});
		connection.on('error', error => {
			this.emit('error', error);
			connection.close(1002, 'protocol error');
		});
		connection.once('close', () => this.disconnected(host));
	}

	private async receive(host: HostConnection, message: ScalerProtocolMessage) {
		if (host.descriptor && this.hostsById.get(host.descriptor.hostId) !== host) return;
		if (!host.descriptor) {
			if (message.type !== 'HELLO') throw new Error(`Expected HELLO, received ${message.type}`);
			await this.hello(host, message);
			return;
		}
		if (message.type === 'HELLO') throw new Error('Duplicate HELLO');
		switch (message.type) {
			case 'WORKER_STATUS':
				this.workerStatus(host, message);
				break;
			case 'IDENTIFY_REQUEST':
				this.identify(host, message);
				break;
			case 'WORKER_MSG':
				this.workerMessage(host, message);
				break;
			case 'ERROR':
				this.agentError(message);
				break;
			default:
				throw new Error(`Agent sent master-only message ${message.type}`);
		}
	}

	private async hello(host: HostConnection, message: HelloMessage) {
		if (message.host.hostId !== host.headerHostId) throw new Error('HELLO hostId does not match authenticated host');
		if (message.workers.length > message.host.maxWorkers) throw new Error('HELLO exceeds declared host capacity');
		if (new Set(message.workers.map(worker => worker.workerId)).size !== message.workers.length) {
			throw new Error('HELLO contains duplicate logical workers');
		}
		clearTimeout(host.handshakeTimer);
		host.descriptor = { ...message.host };
		for (const worker of message.workers) host.observed.set(worker.workerId, freezeObserved(worker));
		const previous = this.hostsById.get(message.host.hostId);
		if (previous && previous !== host) previous.connection.close(1012, 'host reconnected');
		this.hostsById.set(message.host.hostId, host);
		for (const worker of host.observed.values()) {
			if (worker.ready) this.routeWorker(host, worker.workerId, worker.identity);
		}
		await host.connection.send({ type: 'HELLO_ACK', version: SCALER_PROTOCOL_VERSION, masterId: this.masterId });
		this.emit('hostConnected', { ...message.host });
		this.emitSnapshot(host);
	}

	private workerStatus(host: HostConnection, message: WorkerStatusMessage) {
		const target = placement(host);
		if (message.status === 'ready') {
			const previous = host.observed.get(message.workerId);
			if (previous && previous.identity.slot !== message.identity.slot) {
				throw new Error(`Worker ${message.workerId} changed allocation slot without STOP`);
			}
			host.observed.set(
				message.workerId,
				freezeObserved({
					workerId: message.workerId,
					identity: message.identity,
					topology: message.topology,
					ready: true,
				}),
			);
			host.respawns.delete(message.workerId);
			this.routeWorker(host, message.workerId, message.identity);
			this.settle('launch', host, message.workerId, message.identity);
			this.emit(
				'workerReady',
				message.workerId,
				{ ...message.identity },
				{ ...message.topology },
				target,
				message.restarted === true,
			);
		} else {
			const observed = host.observed.get(message.workerId);
			const stopping = [...this.pending.values()].some(
				pending =>
					pending.kind === 'stop' &&
					pending.host === host &&
					pending.workerId === message.workerId &&
					sameIdentity(pending.identity, message.identity),
			);
			if (observed && sameIdentity(observed.identity, message.identity)) {
				const activeRespawn = host.respawns.get(message.workerId);
				if (!stopping && (observed.ready || activeRespawn?.slot === message.identity.slot)) {
					host.respawns.set(message.workerId, {
						slot: message.identity.slot,
						previousToken: message.identity.token,
						topology: { ...observed.topology },
					});
				} else {
					host.respawns.delete(message.workerId);
				}
				host.observed.delete(message.workerId);
			}
			const currentRoute = this.routes.get(message.workerId);
			if (currentRoute?.host === host && sameIdentity(currentRoute.identity, message.identity)) {
				this.routes.delete(message.workerId);
			}
			this.settle('stop', host, message.workerId, message.identity);
			this.rejectLaunch(
				host,
				message.workerId,
				message.identity,
				message.reason ?? `Worker ${message.workerId} exited before ready`,
			);
			this.emit('workerExit', message.workerId, { ...message.identity }, message.code, message.signal, target);
		}
		this.emitSnapshot(host);
	}

	private identify(host: HostConnection, message: IdentifyRequestMessage) {
		let worker = host.observed.get(message.workerId);
		if (!worker) {
			const respawn = host.respawns.get(message.workerId);
			if (
				respawn &&
				respawn.slot === message.identity.slot &&
				respawn.previousToken !== message.identity.token &&
				message.shardId >= respawn.topology.shardStart &&
				message.shardId < respawn.topology.shardEnd
			) {
				worker = freezeObserved({
					workerId: message.workerId,
					identity: message.identity,
					topology: respawn.topology,
					ready: false,
				});
				respawn.previousToken = message.identity.token;
				host.observed.set(message.workerId, worker);
				this.emitSnapshot(host);
			}
		}
		if (
			!worker ||
			!sameIdentity(worker.identity, message.identity) ||
			message.shardId < worker.topology.shardStart ||
			message.shardId >= worker.topology.shardEnd
		) {
			void this.sendError(
				host,
				'STALE_WORKER',
				`Rejected IDENTIFY for stale worker ${message.workerId}`,
				message.requestId,
			);
			return;
		}
		const bucketId = message.shardId % message.maxConcurrency;
		const bucket = this.identifyBuckets.get(bucketId) ?? {
			availableAt: this.now(),
			queue: [],
			sending: false,
		};
		this.identifyBuckets.set(bucketId, bucket);
		bucket.queue.push({
			host,
			message: { ...message, identity: { ...message.identity } },
		});
		this.scheduleIdentify(bucketId, bucket);
	}

	private scheduleIdentify(bucketId: number, bucket: IdentifyBucket) {
		if (this.identifyBuckets.get(bucketId) !== bucket || bucket.timer || bucket.sending || !bucket.queue.length) {
			return;
		}
		bucket.timer = setTimeout(
			() => {
				bucket.timer = undefined;
				void this.sendNextIdentify(bucketId, bucket);
			},
			Math.max(0, bucket.availableAt - this.now()),
		);
	}

	private async sendNextIdentify(bucketId: number, bucket: IdentifyBucket) {
		if (this.identifyBuckets.get(bucketId) !== bucket || bucket.sending) return;
		bucket.sending = true;
		try {
			let pending = bucket.queue.shift();
			while (pending && !this.canGrantIdentify(pending)) pending = bucket.queue.shift();
			if (!pending) return;

			try {
				await pending.host.connection.send({
					type: 'IDENTIFY_GRANT',
					version: SCALER_PROTOCOL_VERSION,
					requestId: pending.message.requestId,
					workerId: pending.message.workerId,
					identity: { ...pending.message.identity },
					shardId: pending.message.shardId,
				});
				bucket.availableAt = this.now() + IDENTIFY_GATE_MS;
			} catch (error) {
				bucket.availableAt = this.now() + IDENTIFY_GATE_MS;
				if (this.identifyBuckets.get(bucketId) === bucket) this.emit('error', toError(error));
			}
		} finally {
			bucket.sending = false;
			this.scheduleIdentify(bucketId, bucket);
		}
	}

	private canGrantIdentify({ host, message }: PendingIdentifyGrant) {
		const current = host.observed.get(message.workerId);
		return host.connection.open && Boolean(current && sameIdentity(current.identity, message.identity));
	}

	private workerMessage(host: HostConnection, message: WorkerMessage) {
		const current = this.routes.get(message.workerId);
		if (!current || current.host !== host || !sameIdentity(current.identity, message.identity)) return;
		this.emit('workerMessage', message.workerId, { ...message.identity }, message.body, placement(host));
	}

	private routeWorker(host: HostConnection, workerId: number, identity: AllocationIdentity) {
		const current = this.routes.get(workerId);
		if (current && current.host !== host && current.host.descriptor?.hostId !== host.descriptor?.hostId) {
			return;
		}
		this.routes.set(workerId, route(host, workerId, identity));
	}

	private agentError(message: ErrorMessage) {
		if (message.requestId) {
			const pending = this.pending.get(message.requestId);
			if (pending) {
				this.pending.delete(message.requestId);
				clearTimeout(pending.timer);
				pending.reject(new Error(`${message.code}: ${message.message}`));
				return;
			}
		}
		this.emit('error', new Error(`Scaler agent ${message.code}: ${message.message}`));
	}

	private request(
		host: HostConnection,
		workerId: number,
		identity: AllocationIdentity,
		requestId: string,
		kind: PendingRequest['kind'],
		message: MasterToAgentMessage,
	) {
		return new Promise<void>((resolve, reject) => {
			const pending: PendingRequest = {
				host,
				workerId,
				identity: { ...identity },
				requestId,
				kind,
				timer: setTimeout(() => {
					this.pending.delete(requestId);
					reject(new Error(`${kind} timed out for worker ${workerId}`));
				}, this.requestTimeoutMs),
				resolve,
				reject,
			};
			this.pending.set(requestId, pending);
			host.connection.send(message).catch(error => {
				if (this.pending.delete(requestId)) clearTimeout(pending.timer);
				reject(error);
			});
		});
	}

	private settle(kind: PendingRequest['kind'], host: HostConnection, workerId: number, identity: AllocationIdentity) {
		for (const [requestId, pending] of this.pending) {
			if (
				pending.kind === kind &&
				pending.host === host &&
				pending.workerId === workerId &&
				sameIdentity(pending.identity, identity)
			) {
				this.pending.delete(requestId);
				clearTimeout(pending.timer);
				pending.resolve();
				return;
			}
		}
	}

	private rejectLaunch(host: HostConnection, workerId: number, identity: AllocationIdentity, reason: string) {
		for (const [requestId, pending] of this.pending) {
			if (
				pending.kind === 'launch' &&
				pending.host === host &&
				pending.workerId === workerId &&
				sameIdentity(pending.identity, identity)
			) {
				this.pending.delete(requestId);
				clearTimeout(pending.timer);
				pending.reject(new Error(reason));
				return;
			}
		}
	}

	private async sendError(host: HostConnection, code: ErrorMessage['code'], message: string, requestId?: string) {
		await host.connection.send({
			type: 'ERROR',
			version: SCALER_PROTOCOL_VERSION,
			code,
			message,
			...(requestId ? { requestId } : {}),
		});
	}

	private checkHosts() {
		const now = this.now();
		for (const host of this.connections) {
			if (now - host.lastSeenAt > this.hostTimeoutMs) host.connection.terminate();
			else host.connection.ping();
		}
	}

	private disconnected(host: HostConnection) {
		clearTimeout(host.handshakeTimer);
		this.connections.delete(host);
		if (!host.descriptor || this.hostsById.get(host.descriptor.hostId) !== host) return;
		this.hostsById.delete(host.descriptor.hostId);
		for (const [workerId, current] of this.routes) {
			if (current.host === host) this.routes.delete(workerId);
		}
		for (const [requestId, pending] of this.pending) {
			if (pending.host !== host) continue;
			this.pending.delete(requestId);
			clearTimeout(pending.timer);
			pending.reject(new Error(`Host ${host.descriptor.hostId} disconnected`));
		}
		this.emit('hostDisconnected', { ...host.descriptor });
	}

	private requireHost(target: PlacementLocation) {
		const host = this.hostsById.get(target.hostId);
		if (!host?.descriptor || host.descriptor.bootId !== target.bootId || !host.connection.open) {
			throw new Error(`Host ${target.hostId}/${target.bootId} is not connected`);
		}
		return host;
	}

	private emitSnapshot(host: HostConnection) {
		if (!host.descriptor) return;
		this.emit('hostSnapshot', { ...host.descriptor }, [...host.observed.values()]);
	}
}

const emptyIdentity: AllocationIdentity = { slot: '', token: '' };

function assertOptions(options: ScalerMasterOptions) {
	if (typeof options.authToken === 'string') {
		if (!options.authToken) throw new TypeError('Master authToken cannot be empty');
	} else if (!Object.keys(options.authToken).length || Object.values(options.authToken).some(token => !token)) {
		throw new TypeError('Master authToken map cannot be empty or contain empty tokens');
	}
	if (
		options.port !== undefined &&
		(!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535)
	) {
		throw new RangeError('Master port must be between 0 and 65535');
	}
}

function route(host: HostConnection, workerId: number, identity: AllocationIdentity): Route {
	return { host, workerId, identity: { ...identity } };
}

function placement(host: HostConnection): PlacementLocation {
	return { hostId: host.descriptor!.hostId, bootId: host.descriptor!.bootId };
}

function singleHeader(value: string | string[] | undefined) {
	return Array.isArray(value) ? value[0] : value;
}
