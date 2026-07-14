import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ApiHandler, SeyfertError } from 'seyfert';
import { createCredentialAuthenticator } from './credentials';
import { InvalidRequestBudget, isInteractionCallback, SlidingWindow } from './gates';
import {
	nonNegativeInteger,
	PayloadTooLargeError,
	positiveInteger,
	readRequestBody,
	toError,
	writeEmpty,
	writeJson,
} from './internal';
import {
	type DiscordErrorEnvelope,
	ProxyError,
	type ProxyErrorCode,
	type ProxyOutcome,
	proxyError,
	type SuccessEnvelope,
	toApiRequestOptions,
} from './protocol';
import { ClientDisconnectedError, RequestScheduler } from './scheduler';
import { type DecodedProxyRequest, decodeProxyRequest } from './transport';

const DEFAULT_MAX_PENDING_REQUESTS = 512;
const DEFAULT_QUEUE_TIMEOUT = 5_000;
const DEFAULT_MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const DEFAULT_INVALID_MAX = 10_000;
const DEFAULT_INVALID_WINDOW = 600_000;
const GLOBAL_GATE_LIMIT = 50;
const GLOBAL_GATE_WINDOW = 1_000;

export interface ProxyServerOptions {
	token: string;
	credentials: string[];
	port: number;
	maxPendingRequests?: number;
	queueTimeout?: number;
	maxRequestBytes?: number;
	invalidWindow?: { max: number; perMs: number };
}

export interface ProxyCloseOptions {
	drainTimeout: number;
}

export interface ProxyStats {
	instanceId: string;
	state: 'ready' | 'draining' | 'quarantined' | 'closed';
	pendingRequests: number;
	inFlightRequests: number;
	invalidBudgetRemaining: number;
	globalGateOccupancy: number;
	outcomes: Record<ProxyOutcome, number>;
}

export type ProxyObservation =
	| { type: 'state'; at: number; instanceId: string }
	| {
			type: 'request';
			at: number;
			instanceId: string;
			requestId: string;
			outcome: ProxyOutcome;
			serviceId?: string;
			code?: ProxyErrorCode;
	  };

type ProxyObservationInput<T = ProxyObservation> = T extends ProxyObservation ? Omit<T, 'at' | 'instanceId'> : never;

export type ProxyObserver = (observation: Readonly<ProxyObservation>) => void;

export interface ProxyServer {
	readonly instanceId: string;
	readonly port: number;
	readonly url: string;
	getStats(): ProxyStats;
	observe(observer: ProxyObserver): () => void;
	close(options: ProxyCloseOptions): Promise<void>;
}

function proxyStatus(code: ProxyErrorCode): number {
	switch (code) {
		case 'PROXY_UNAUTHENTICATED':
			return 401;
		case 'PROXY_TOKEN_OVERRIDE_UNSUPPORTED':
			return 400;
		case 'PROXY_PAYLOAD_TOO_LARGE':
			return 413;
		case 'PROXY_QUEUE_TIMEOUT':
			return 504;
		case 'PROXY_OVERLOADED':
		case 'PROXY_DRAINING':
		case 'PROXY_QUARANTINED':
			return 503;
		case 'PROXY_INTERNAL':
			return 500;
	}
}

function bearerCredential(req: IncomingMessage): string | undefined {
	const authorization = req.headers.authorization;
	if (!authorization?.startsWith('Bearer ')) return;
	const credential = authorization.slice(7);
	return credential || undefined;
}

function statusFromSeyfertError(error: SeyfertError): number {
	const status = error.metadata?.status;
	return typeof status === 'number' && Number.isInteger(status) ? status : 500;
}

function discordEnvelope(error: SeyfertError): DiscordErrorEnvelope {
	const status = statusFromSeyfertError(error);
	return {
		kind: 'discord_error',
		status,
		body: error.metadata?.response,
		error: { code: error.code, metadata: error.metadata },
	};
}

function validateOptions(options: ProxyServerOptions): Required<Omit<ProxyServerOptions, 'invalidWindow'>> & {
	invalidWindow: { max: number; perMs: number };
} {
	if (!options.token) throw new TypeError('token must not be empty.');
	return {
		...options,
		port: nonNegativeInteger(options.port, 'port'),
		maxPendingRequests: positiveInteger(
			options.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS,
			'maxPendingRequests',
		),
		queueTimeout: positiveInteger(options.queueTimeout ?? DEFAULT_QUEUE_TIMEOUT, 'queueTimeout'),
		maxRequestBytes: positiveInteger(options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES, 'maxRequestBytes'),
		invalidWindow: {
			max: positiveInteger(options.invalidWindow?.max ?? DEFAULT_INVALID_MAX, 'invalidWindow.max'),
			perMs: positiveInteger(options.invalidWindow?.perMs ?? DEFAULT_INVALID_WINDOW, 'invalidWindow.perMs'),
		},
	};
}

class ProxyServerImpl implements ProxyServer {
	readonly instanceId = randomUUID();
	readonly port: number;
	readonly url: string;
	private readonly observers = new Set<ProxyObserver>();
	private readonly outcomes: Record<ProxyOutcome, number> = { not_dispatched: 0, completed: 0, unknown: 0 };
	private readonly ambiguous = new Set<string>();
	private closed = false;
	private closePromise?: Promise<void>;
	private stateSignature = '';
	private invalidTimer?: NodeJS.Timeout;

	constructor(
		private readonly server: Server,
		private readonly scheduler: RequestScheduler,
		port: number,
	) {
		this.port = port;
		this.url = `http://127.0.0.1:${port}`;
	}

	getStats(): ProxyStats {
		const now = Date.now();
		return {
			instanceId: this.instanceId,
			state: this.closed
				? 'closed'
				: this.scheduler.draining
					? 'draining'
					: this.scheduler.quarantined
						? 'quarantined'
						: 'ready',
			pendingRequests: this.scheduler.pendingCount,
			inFlightRequests: this.scheduler.inFlightCount,
			invalidBudgetRemaining: this.scheduler.invalidBudget.remaining(now),
			globalGateOccupancy: this.scheduler.globalGate.occupancy(now),
			outcomes: { ...this.outcomes },
		};
	}

	observe(observer: ProxyObserver): () => void {
		this.observers.add(observer);
		return () => this.observers.delete(observer);
	}

	emit(observation: ProxyObservationInput): void {
		const payload = Object.freeze({ ...observation, at: Date.now(), instanceId: this.instanceId });
		for (const observer of this.observers) {
			try {
				observer(payload);
			} catch {
				console.warn(`[slipher-proxy ${this.instanceId}] observer failed.`);
			}
		}
	}

	notifyStateChange(): void {
		const stats = this.getStats();
		const signature = `${stats.state}:${stats.pendingRequests}:${stats.inFlightRequests}:${stats.invalidBudgetRemaining}:${stats.globalGateOccupancy}`;
		if (signature === this.stateSignature) return;
		this.stateSignature = signature;
		this.emit({ type: 'state' });
		if (stats.state === 'quarantined' && !this.scheduler.draining) this.scheduleInvalidRecovery();
	}

	private scheduleInvalidRecovery(): void {
		if (this.invalidTimer || this.scheduler.invalidBudget.remaining(Date.now()) > 0) return;
		const delay = this.scheduler.invalidBudget.blockedFor(Date.now());
		if (!delay) return;
		this.invalidTimer = setTimeout(() => {
			this.invalidTimer = undefined;
			this.notifyStateChange();
		}, delay);
		this.invalidTimer.unref?.();
	}

	record(outcome: ProxyOutcome, requestId: string, serviceId: string, code?: ProxyErrorCode): void {
		if (this.ambiguous.delete(requestId)) return;
		this.outcomes[outcome]++;
		this.emit({ type: 'request', requestId, serviceId, outcome, code });
	}

	markAmbiguous(requestIds: readonly string[]): void {
		for (const requestId of requestIds) {
			if (this.ambiguous.has(requestId)) continue;
			this.ambiguous.add(requestId);
			this.outcomes.unknown++;
			this.emit({ type: 'request', requestId, outcome: 'unknown' });
		}
	}

	close(options: ProxyCloseOptions): Promise<void> {
		if (this.closePromise) return this.closePromise;
		const drainTimeout = nonNegativeInteger(options.drainTimeout, 'drainTimeout');
		this.closePromise = this.performClose(drainTimeout);
		return this.closePromise;
	}

	private async performClose(drainTimeout: number): Promise<void> {
		this.scheduler.startDraining();
		const deadline = Date.now() + drainTimeout;
		while (this.scheduler.inFlightCount > 0 && Date.now() < deadline) {
			await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
		}
		if (this.scheduler.inFlightCount > 0) {
			const ambiguous = this.scheduler.inFlight;
			this.markAmbiguous(ambiguous);
			console.warn(
				`[slipher-proxy ${this.instanceId}] drain timeout left ${ambiguous.length} request(s) with unknown outcome.`,
			);
		}
		this.closed = true;
		if (this.invalidTimer) clearTimeout(this.invalidTimer);
		await new Promise<void>(resolve => {
			this.server.close(() => resolve());
			if (this.scheduler.inFlightCount > 0) this.server.closeAllConnections();
		});
		this.notifyStateChange();
	}
}

function createRequestHandler(
	options: ReturnType<typeof validateOptions>,
	authenticate: ReturnType<typeof createCredentialAuthenticator>,
	rest: ApiHandler,
	scheduler: RequestScheduler,
	getProxy: () => ProxyServerImpl,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
	return async (req, res) => {
		const proxy = getProxy();
		const path = new URL(req.url ?? '/', 'http://proxy.local').pathname;
		if (req.method === 'GET' && path === '/health/live') {
			writeEmpty(res, 200);
			return;
		}

		const credential = bearerCredential(req);
		const serviceId = credential ? authenticate(credential) : undefined;
		if (!serviceId) {
			const requestId = randomUUID();
			const envelope = proxyError('PROXY_UNAUTHENTICATED', 'not_dispatched', requestId, 'Authentication failed.');
			writeJson(res, 401, envelope);
			return;
		}

		if (req.method === 'GET' && path === '/health/ready') {
			const stats = proxy.getStats();
			if (stats.state === 'ready') writeEmpty(res, 200);
			else {
				const code = stats.state === 'quarantined' ? 'PROXY_QUARANTINED' : 'PROXY_DRAINING';
				writeJson(res, proxyStatus(code), proxyError(code, 'not_dispatched', randomUUID(), `Proxy is ${stats.state}.`));
			}
			return;
		}
		if (req.method === 'GET' && path === '/stats') {
			writeJson(res, 200, proxy.getStats());
			return;
		}
		if (req.method !== 'POST' || path !== '/api') {
			writeEmpty(res, 404);
			return;
		}

		let body: Buffer;
		try {
			body = await readRequestBody(req, options.maxRequestBytes);
		} catch (error) {
			const requestId = randomUUID();
			const code = error instanceof PayloadTooLargeError ? 'PROXY_PAYLOAD_TOO_LARGE' : 'PROXY_INTERNAL';
			const envelope = proxyError(code, 'not_dispatched', requestId, toError(error).message || 'Request body failed.');
			proxy.record('not_dispatched', requestId, serviceId, code);
			writeJson(res, proxyStatus(code), envelope);
			return;
		}

		let decoded: DecodedProxyRequest | undefined;
		try {
			decoded = await decodeProxyRequest(body, req.headers);
		} catch {
			decoded = undefined;
		}
		const requestId = decoded?.requestId ?? randomUUID();
		if (decoded && 'tokenOverride' in decoded) {
			const envelope = proxyError(
				'PROXY_TOKEN_OVERRIDE_UNSUPPORTED',
				'not_dispatched',
				requestId,
				'ApiRequestOptions.token is not supported by the proxy.',
			);
			proxy.record('not_dispatched', requestId, serviceId, envelope.code);
			writeJson(res, 400, envelope);
			return;
		}
		if (!decoded) {
			const envelope = proxyError('PROXY_INTERNAL', 'not_dispatched', requestId, 'Invalid proxy request payload.');
			proxy.record('not_dispatched', requestId, serviceId, envelope.code);
			writeJson(res, 400, envelope);
			return;
		}
		const request = decoded;

		const disconnected = new AbortController();
		let dispatched = false;
		res.once('close', () => {
			// Once ApiHandler owns the request, its retry and bucket state must finish without downstream cancellation.
			if (!res.writableEnded && !dispatched) disconnected.abort();
		});

		try {
			const envelope = await scheduler.submit<SuccessEnvelope | DiscordErrorEnvelope>({
				requestId,
				exempt: isInteractionCallback(request.url),
				signal: disconnected.signal,
				run: async () => {
					dispatched = true;
					try {
						const result = await rest.request(request.method, request.url, toApiRequestOptions(request, request.files));
						return { kind: 'success', status: 200, body: result };
					} catch (error) {
						if (SeyfertError.is(error)) return discordEnvelope(error);
						throw error;
					}
				},
			});
			if (res.destroyed || (!res.writableEnded && res.closed)) {
				proxy.record('unknown', requestId, serviceId);
				return;
			}
			proxy.record('completed', requestId, serviceId);
			writeJson(res, 200, envelope);
		} catch (error) {
			if (error instanceof ClientDisconnectedError) {
				proxy.record('not_dispatched', requestId, serviceId);
				return;
			}
			if (error instanceof ProxyError) {
				const envelope = proxyError(error.code, error.outcome, error.requestId, error.message);
				proxy.record(error.outcome, requestId, serviceId, error.code);
				writeJson(res, proxyStatus(error.code), envelope);
				return;
			}
			const envelope = proxyError(
				'PROXY_INTERNAL',
				dispatched ? 'unknown' : 'not_dispatched',
				requestId,
				'Proxy request failed.',
			);
			proxy.record(envelope.outcome, requestId, serviceId, envelope.code);
			writeJson(res, 500, envelope);
		}
	};
}

export async function createProxy(rawOptions: ProxyServerOptions): Promise<ProxyServer> {
	const options = validateOptions(rawOptions);
	const authenticate = createCredentialAuthenticator(options.credentials);
	const rest = new ApiHandler({ token: options.token, workerProxy: false });
	let proxy!: ProxyServerImpl;
	const scheduler = new RequestScheduler(
		options.maxPendingRequests,
		options.queueTimeout,
		new SlidingWindow(GLOBAL_GATE_LIMIT, GLOBAL_GATE_WINDOW),
		new InvalidRequestBudget(options.invalidWindow.max, options.invalidWindow.perMs),
		() => proxy?.notifyStateChange(),
	);

	rest.observe({
		onFail({ request, statusCode }) {
			if (statusCode !== 401 && statusCode !== 403) return;
			scheduler.recordInvalid();
			if (statusCode === 401 && request.auth !== false) scheduler.quarantineToken();
		},
		onRatelimit({ response }) {
			if (response.headers.get('x-ratelimit-scope') !== 'shared') scheduler.recordInvalid();
		},
	});

	const handleRequest = createRequestHandler(options, authenticate, rest, scheduler, () => proxy);
	const server = createServer((req, res) => {
		void handleRequest(req, res).catch(() => {
			const requestId = randomUUID();
			writeJson(res, 500, proxyError('PROXY_INTERNAL', 'not_dispatched', requestId, 'Proxy request failed.'));
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(options.port, () => {
			server.off('error', reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === 'string') {
		server.close();
		throw new Error('Proxy failed to resolve its listening port.');
	}
	proxy = new ProxyServerImpl(server, scheduler, address.port);
	proxy.notifyStateChange();
	return proxy;
}
