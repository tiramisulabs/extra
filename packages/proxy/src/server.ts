import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ApiHandler, SeyfertError } from 'seyfert';
import {
	type CreateRestForToken,
	type GateOptions,
	isCompatibleApiHandler,
	RestContextManager,
	TokenContextUnavailableError,
} from './contexts';
import { createCredentialAuthenticator, isServiceId } from './credentials';
import { RequestDeduplicator, requestFingerprint } from './deduplication';
import { SlidingWindow } from './gates';
import {
	BufferedBytesBudget,
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
	isRequestId,
	ProxyError,
	type ProxyErrorCode,
	type ProxyErrorEnvelope,
	type ProxyOutcome,
	type ProxyPhase,
	type ProxyResponseEnvelope,
	proxyError,
	type SuccessEnvelope,
	toApiRequestOptions,
} from './protocol';
import {
	type AdmissionReservation,
	ClientDisconnectedError,
	type InFlightRequest,
	RequestScheduler,
} from './scheduler';
import { decodeProxyRequest } from './transport';

export type { CreateRestForToken, GateOptions } from './contexts';

interface ProxyServerBaseOptions {
	rest: ApiHandler;
	createRestForToken?: CreateRestForToken;
	port: number;
	host?: string;
	maxTokenContexts?: number;
	maxAdmittedRequests?: number;
	queueTimeout?: number;
	maxRequestBytes?: number;
	maxBufferedBytes?: number;
	maxFiles?: number;
	maxMetadataBytes?: number;
	deduplication?: { ttl?: number; maxEntries?: number };
	globalLimit?: Partial<GateOptions>;
	unauthenticatedLimit?: Partial<GateOptions>;
	invalidWindow?: { max: number; perMs: number };
}

export interface ProxyAuthenticationContext {
	readonly method: string;
	readonly path: string;
	readonly remoteAddress?: string;
}

export interface ProxyAuthenticationResult {
	readonly serviceId: string;
}

export type ProxyAuthenticator = (
	credential: string,
	context: ProxyAuthenticationContext,
) => ProxyAuthenticationResult | null | undefined | Promise<ProxyAuthenticationResult | null | undefined>;

export type ProxyServerOptions = ProxyServerBaseOptions &
	(
		| { credentials: readonly string[]; authenticate?: never }
		| { authenticate: ProxyAuthenticator; credentials?: never }
	);

export interface ProxyCloseOptions {
	drainTimeout: number;
}

export interface ProxyStats {
	instanceId: string;
	state: 'ready' | 'draining' | 'quarantined' | 'unavailable' | 'closed';
	pendingRequests: number;
	inFlightRequests: number;
	admittedRequests: number;
	bufferedBytes: number;
	tokenContexts: number;
	deduplicationEntries: number;
	invalidBudgetRemaining: number;
	authenticatedGateOccupancy: number;
	unauthenticatedGateOccupancy: number;
	outcomes: Record<ProxyOutcome, number>;
}

export type ProxyObservation =
	| { type: 'state'; at: number; instanceId: string; state: ProxyStats['state'] }
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

interface RpcResponse {
	status: number;
	envelope: ProxyResponseEnvelope;
	outcome: ProxyOutcome;
	code?: ProxyErrorCode;
}

interface ValidatedOptions {
	rest: ApiHandler;
	createRestForToken?: CreateRestForToken;
	authenticate: ProxyAuthenticator;
	port: number;
	host: string;
	maxTokenContexts: number;
	maxAdmittedRequests: number;
	queueTimeout: number;
	maxRequestBytes?: number;
	maxBufferedBytes?: number;
	maxFiles?: number;
	maxMetadataBytes?: number;
	deduplication: { ttl: number; maxEntries: number };
	globalLimit: GateOptions;
	unauthenticatedLimit: GateOptions;
	invalidWindow: GateOptions;
}

const defaultOptions = {
	host: '127.0.0.1',
	maxTokenContexts: 128,
	maxAdmittedRequests: 512,
	queueTimeout: 5_000,
	deduplication: {
		ttl: 5 * 60_000,
		maxEntries: 10_000,
	},
	globalLimit: {
		max: 50,
		perMs: 1_000,
	},
	unauthenticatedLimit: {
		max: 50,
		perMs: 1_000,
	},
	invalidWindow: {
		max: 10_000,
		perMs: 600_000,
	},
} as const satisfies Pick<
	ValidatedOptions,
	| 'host'
	| 'maxTokenContexts'
	| 'maxAdmittedRequests'
	| 'queueTimeout'
	| 'deduplication'
	| 'globalLimit'
	| 'unauthenticatedLimit'
	| 'invalidWindow'
>;

function proxyStatus(code: ProxyErrorCode): number {
	switch (code) {
		case 'PROXY_UNAUTHENTICATED':
			return 401;
		case 'PROXY_AUTHENTICATION_UNAVAILABLE':
			return 503;
		case 'PROXY_BAD_REQUEST':
			return 400;
		case 'PROXY_NOT_FOUND':
			return 404;
		case 'PROXY_REQUEST_ID_CONFLICT':
			return 409;
		case 'PROXY_PAYLOAD_TOO_LARGE':
			return 413;
		case 'PROXY_QUEUE_TIMEOUT':
			return 504;
		case 'PROXY_OVERLOADED':
		case 'PROXY_DRAINING':
		case 'PROXY_TOKEN_CONTEXT_UNAVAILABLE':
		case 'PROXY_TOKEN_REJECTED':
		case 'PROXY_INVALID_REQUEST_BUDGET_EXHAUSTED':
			return 503;
		case 'PROXY_UNSUPPORTED_SEYFERT':
		case 'PROXY_INTERNAL':
			return 500;
	}
}

function optionalPositiveInteger(value: number | undefined, name: string): number | undefined {
	return value === undefined ? undefined : positiveInteger(value, name);
}

function gateOptions(value: Partial<GateOptions> | undefined, defaults: GateOptions, name: string): GateOptions {
	return {
		max: positiveInteger(value?.max ?? defaults.max, `${name}.max`),
		perMs: positiveInteger(value?.perMs ?? defaults.perMs, `${name}.perMs`),
	};
}

function validateOptions(options: ProxyServerOptions): ValidatedOptions {
	if (!isCompatibleApiHandler(options.rest)) {
		throw new ProxyError(
			proxyError(
				'PROXY_UNSUPPORTED_SEYFERT',
				'not_dispatched',
				randomUUID(),
				'rest must be a compatible direct Discord ApiHandler with workerProxy disabled.',
				'startup',
			),
		);
	}
	if (!options.host && options.host !== undefined) throw new TypeError('host must not be empty.');
	if (Boolean(options.authenticate) === Boolean(options.credentials)) {
		throw new TypeError('Configure exactly one of authenticate or credentials.');
	}
	let authenticate: ProxyAuthenticator;
	if (options.authenticate) authenticate = options.authenticate;
	else {
		const authenticateCredential = createCredentialAuthenticator(options.credentials);
		authenticate = credential => {
			const serviceId = authenticateCredential(credential);
			return serviceId ? { serviceId } : null;
		};
	}
	return {
		rest: options.rest,
		...(options.createRestForToken ? { createRestForToken: options.createRestForToken } : {}),
		authenticate,
		port: nonNegativeInteger(options.port, 'port'),
		host: options.host ?? defaultOptions.host,
		maxTokenContexts: positiveInteger(options.maxTokenContexts ?? defaultOptions.maxTokenContexts, 'maxTokenContexts'),
		maxAdmittedRequests: positiveInteger(
			options.maxAdmittedRequests ?? defaultOptions.maxAdmittedRequests,
			'maxAdmittedRequests',
		),
		queueTimeout: positiveInteger(options.queueTimeout ?? defaultOptions.queueTimeout, 'queueTimeout'),
		maxRequestBytes: optionalPositiveInteger(options.maxRequestBytes, 'maxRequestBytes'),
		maxBufferedBytes: optionalPositiveInteger(options.maxBufferedBytes, 'maxBufferedBytes'),
		maxFiles: optionalPositiveInteger(options.maxFiles, 'maxFiles'),
		maxMetadataBytes: optionalPositiveInteger(options.maxMetadataBytes, 'maxMetadataBytes'),
		deduplication: {
			ttl: positiveInteger(options.deduplication?.ttl ?? defaultOptions.deduplication.ttl, 'deduplication.ttl'),
			maxEntries: positiveInteger(
				options.deduplication?.maxEntries ?? defaultOptions.deduplication.maxEntries,
				'deduplication.maxEntries',
			),
		},
		globalLimit: gateOptions(options.globalLimit, defaultOptions.globalLimit, 'globalLimit'),
		unauthenticatedLimit: gateOptions(
			options.unauthenticatedLimit,
			defaultOptions.unauthenticatedLimit,
			'unauthenticatedLimit',
		),
		invalidWindow: {
			max: positiveInteger(options.invalidWindow?.max ?? defaultOptions.invalidWindow.max, 'invalidWindow.max'),
			perMs: positiveInteger(options.invalidWindow?.perMs ?? defaultOptions.invalidWindow.perMs, 'invalidWindow.perMs'),
		},
	};
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

function closeAfterResponse(req: IncomingMessage, res: ServerResponse): void {
	res.shouldKeepAlive = false;
	res.setHeader('connection', 'close');
	res.once('finish', () => req.socket.end());
}

function formatHost(host: string): string {
	return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

class ProxyServerImpl implements ProxyServer {
	readonly instanceId = randomUUID();
	readonly port: number;
	readonly url: string;
	private readonly observers = new Set<ProxyObserver>();
	private readonly outcomes: Record<ProxyOutcome, number> = { not_dispatched: 0, completed: 0, unknown: 0 };
	private readonly ambiguous = new Set<symbol>();
	private closed = false;
	private closePromise?: Promise<void>;
	private emittedState?: ProxyStats['state'];

	constructor(
		private readonly server: Server,
		private readonly scheduler: RequestScheduler,
		private readonly contexts: RestContextManager,
		private readonly deduplicator: RequestDeduplicator<RpcResponse>,
		private readonly bufferedBytes: BufferedBytesBudget,
		host: string,
		port: number,
	) {
		this.port = port;
		this.url = `http://${formatHost(host)}:${port}`;
	}

	get currentState(): ProxyStats['state'] {
		if (this.closed) return 'closed';
		if (this.scheduler.draining) return 'draining';
		if (this.scheduler.invalidBudgetExhausted) return 'quarantined';
		if (this.contexts.defaultContextIssue) return 'unavailable';
		return 'ready';
	}

	getStats(): ProxyStats {
		const now = Date.now();
		return {
			instanceId: this.instanceId,
			state: this.currentState,
			pendingRequests: this.scheduler.pendingCount,
			inFlightRequests: this.scheduler.inFlightCount,
			admittedRequests: this.scheduler.admittedCount,
			bufferedBytes: this.bufferedBytes.size,
			tokenContexts: this.contexts.tokenContextCount,
			deduplicationEntries: this.deduplicator.size,
			invalidBudgetRemaining: this.scheduler.invalidBudget.remaining(now),
			authenticatedGateOccupancy: this.contexts.authenticatedGateOccupancy(now),
			unauthenticatedGateOccupancy: this.contexts.unauthenticatedGateOccupancy(now),
			outcomes: { ...this.outcomes },
		};
	}

	observe(observer: ProxyObserver): () => void {
		this.observers.add(observer);
		return () => this.observers.delete(observer);
	}

	private emit(observation: ProxyObservationInput): void {
		if (this.observers.size === 0) return;
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
		const state = this.currentState;
		if (state === this.emittedState) return;
		this.emittedState = state;
		this.emit({ type: 'state', state });
	}

	error(
		code: ProxyErrorCode,
		outcome: ProxyOutcome,
		requestId: string,
		message: string,
		phase: ProxyPhase,
	): ProxyErrorEnvelope {
		return proxyError(code, outcome, requestId, message, phase, this.instanceId);
	}

	record(
		outcome: ProxyOutcome,
		requestId: string,
		serviceId: string,
		code?: ProxyErrorCode,
		operationId?: symbol,
	): void {
		if (operationId && this.ambiguous.delete(operationId)) return;
		this.outcomes[outcome]++;
		this.emit({ type: 'request', requestId, serviceId, outcome, code });
	}

	markAmbiguous(requests: readonly InFlightRequest[]): void {
		for (const { operationId, requestId } of requests) {
			if (this.ambiguous.has(operationId)) continue;
			this.ambiguous.add(operationId);
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
		const serverClosed = new Promise<void>(resolve => this.server.close(() => resolve()));
		while (this.scheduler.admittedCount > 0 && Date.now() < deadline) {
			await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
		}
		if (this.scheduler.pendingCount > 0) this.scheduler.rejectPendingForDrain();
		if (this.scheduler.inFlightCount > 0) {
			const ambiguous = this.scheduler.inFlight;
			this.markAmbiguous(ambiguous);
			console.warn(
				`[slipher-proxy ${this.instanceId}] drain timeout left ${ambiguous.length} request(s) with unknown outcome.`,
			);
		}
		this.closed = true;
		this.server.closeAllConnections();
		await serverClosed;
		this.notifyStateChange();
	}
}

function proxyRpc(
	proxy: ProxyServerImpl,
	code: ProxyErrorCode,
	outcome: ProxyOutcome,
	requestId: string,
	message: string,
	phase: ProxyPhase,
): RpcResponse {
	return {
		status: proxyStatus(code),
		envelope: proxy.error(code, outcome, requestId, message, phase),
		outcome,
		code,
	};
}

function proxyErrorRpc(proxy: ProxyServerImpl, error: ProxyError): RpcResponse {
	return proxyRpc(proxy, error.code, error.outcome, error.requestId, error.message, error.phase);
}

function writeRpc(res: ServerResponse, rpc: RpcResponse): void {
	writeJson(res, rpc.status, rpc.envelope);
}

function createRequestHandler(
	options: ValidatedOptions,
	scheduler: RequestScheduler,
	contexts: RestContextManager,
	deduplicator: RequestDeduplicator<RpcResponse>,
	bufferedBytes: BufferedBytesBudget,
	getProxy: () => ProxyServerImpl,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
	return async (req, res) => {
		const proxy = getProxy();
		const path = new URL(req.url ?? '/', 'http://proxy.local').pathname;
		const credential = bearerCredential(req);
		let serviceId: string | undefined;
		if (credential) {
			try {
				const result = await options.authenticate(credential, {
					method: req.method ?? 'UNKNOWN',
					path,
					...(req.socket.remoteAddress ? { remoteAddress: req.socket.remoteAddress } : {}),
				});
				if (result && isServiceId(result.serviceId)) serviceId = result.serviceId;
			} catch {
				const rpc = proxyRpc(
					proxy,
					'PROXY_AUTHENTICATION_UNAVAILABLE',
					'not_dispatched',
					randomUUID(),
					'Authentication service is unavailable.',
					'authentication',
				);
				writeRpc(res, rpc);
				return;
			}
		}
		if (!serviceId) {
			const rpc = proxyRpc(
				proxy,
				'PROXY_UNAUTHENTICATED',
				'not_dispatched',
				randomUUID(),
				'Authentication failed.',
				'authentication',
			);
			writeRpc(res, rpc);
			return;
		}
		const authenticatedServiceId = serviceId;

		if (req.method === 'GET' && path === '/health/live') {
			writeEmpty(res, 200);
			return;
		}
		if (req.method === 'GET' && path === '/health/ready') {
			proxy.notifyStateChange();
			const state = proxy.currentState;
			if (state === 'ready') writeEmpty(res, 200);
			else {
				const code =
					state === 'quarantined'
						? 'PROXY_INVALID_REQUEST_BUDGET_EXHAUSTED'
						: state === 'unavailable'
							? (contexts.defaultContextIssue ?? 'PROXY_TOKEN_CONTEXT_UNAVAILABLE')
							: 'PROXY_DRAINING';
				writeRpc(res, proxyRpc(proxy, code, 'not_dispatched', randomUUID(), `Proxy is ${state}.`, 'admission'));
			}
			return;
		}
		if (req.method === 'GET' && path === '/stats') {
			writeJson(res, 200, proxy.getStats());
			return;
		}
		if (req.method !== 'POST' || path !== '/v1/requests') {
			writeRpc(
				res,
				proxyRpc(proxy, 'PROXY_NOT_FOUND', 'not_dispatched', randomUUID(), 'Proxy route was not found.', 'routing'),
			);
			return;
		}

		const headerRequestId = req.headers['x-proxy-request-id'];
		const admissionRequestId = isRequestId(headerRequestId) ? headerRequestId : randomUUID();
		let reservation: AdmissionReservation;
		try {
			reservation = scheduler.reserve(admissionRequestId);
		} catch (error) {
			if (!(error instanceof ProxyError)) throw error;
			const rpc = proxyErrorRpc(proxy, error);
			// Admission failed before reserve() could assign an operationId.
			proxy.record(rpc.outcome, error.requestId, authenticatedServiceId, rpc.code);
			closeAfterResponse(req, res);
			writeRpc(res, rpc);
			return;
		}
		const recordAndWriteRpc = (
			rpc: RpcResponse,
			requestId: string,
			{ closeConnection = false }: { closeConnection?: boolean } = {},
		): void => {
			proxy.record(rpc.outcome, requestId, authenticatedServiceId, rpc.code, reservation.operationId);
			if (closeConnection) closeAfterResponse(req, res);
			writeRpc(res, rpc);
		};

		let admittedBytes = 0;
		try {
			let body: Buffer;
			try {
				body = await readRequestBody(req, options.maxRequestBytes, bytes => {
					bufferedBytes.reserve(bytes);
					admittedBytes += bytes;
				});
			} catch (error) {
				const payload = error instanceof PayloadTooLargeError;
				const rpc = proxyRpc(
					proxy,
					payload ? 'PROXY_PAYLOAD_TOO_LARGE' : 'PROXY_INTERNAL',
					'not_dispatched',
					admissionRequestId,
					payload ? error.message : 'Request body failed.',
					'decoding',
				);
				recordAndWriteRpc(rpc, admissionRequestId, { closeConnection: payload });
				return;
			}

			let request;
			try {
				request = await decodeProxyRequest(body, req.headers, {
					maxFiles: options.maxFiles,
					maxMetadataBytes: options.maxMetadataBytes,
				});
			} catch (error) {
				const payload = error instanceof PayloadTooLargeError;
				const rpc = proxyRpc(
					proxy,
					payload ? 'PROXY_PAYLOAD_TOO_LARGE' : 'PROXY_BAD_REQUEST',
					'not_dispatched',
					admissionRequestId,
					toError(error).message || 'Invalid proxy request payload.',
					'decoding',
				);
				recordAndWriteRpc(rpc, admissionRequestId);
				return;
			}
			if (!request) {
				const rpc = proxyRpc(
					proxy,
					'PROXY_BAD_REQUEST',
					'not_dispatched',
					admissionRequestId,
					'Invalid proxy request payload.',
					'decoding',
				);
				recordAndWriteRpc(rpc, admissionRequestId);
				return;
			}

			const requestId = request.requestId;
			if (isRequestId(headerRequestId) && headerRequestId !== requestId) {
				const rpc = proxyRpc(
					proxy,
					'PROXY_BAD_REQUEST',
					'not_dispatched',
					admissionRequestId,
					'Request ID header does not match the payload.',
					'decoding',
				);
				recordAndWriteRpc(rpc, admissionRequestId);
				return;
			}
			let fingerprint;
			try {
				const identity = contexts.identity(request.auth, request.token);
				fingerprint = requestFingerprint(request, request.files, identity);
			} catch {
				const rpc = proxyRpc(
					proxy,
					'PROXY_OVERLOADED',
					'not_dispatched',
					requestId,
					'Deduplication failed.',
					'deduplication',
				);
				recordAndWriteRpc(rpc, requestId);
				return;
			}
			const claim = deduplicator.claim(authenticatedServiceId, requestId, fingerprint);
			if (claim.kind === 'conflict' || claim.kind === 'capacity') {
				const rpc = proxyRpc(
					proxy,
					claim.kind === 'conflict' ? 'PROXY_REQUEST_ID_CONFLICT' : 'PROXY_OVERLOADED',
					'not_dispatched',
					requestId,
					claim.message,
					'deduplication',
				);
				recordAndWriteRpc(rpc, requestId);
				return;
			}
			if (claim.kind === 'duplicate') {
				bufferedBytes.release(admittedBytes);
				admittedBytes = 0;
				const rpc = await claim.result;
				recordAndWriteRpc(rpc, requestId);
				return;
			}

			let context;
			try {
				context = await contexts.resolve(request.auth, request.token);
			} catch (error) {
				const unavailable = error instanceof TokenContextUnavailableError;
				proxy.notifyStateChange();
				const rpc = proxyRpc(
					proxy,
					unavailable ? 'PROXY_TOKEN_CONTEXT_UNAVAILABLE' : 'PROXY_INTERNAL',
					'not_dispatched',
					requestId,
					unavailable ? error.message : 'Token context creation failed.',
					'admission',
				);
				claim.abort(rpc);
				recordAndWriteRpc(rpc, requestId);
				return;
			}
			if (contexts.isQuarantined(context.key)) {
				proxy.notifyStateChange();
				const rpc = proxyRpc(
					proxy,
					'PROXY_TOKEN_REJECTED',
					'not_dispatched',
					requestId,
					'The selected token version is quarantined.',
					'admission',
				);
				claim.abort(rpc);
				recordAndWriteRpc(rpc, requestId);
				return;
			}

			const disconnected = new AbortController();
			let dispatched = false;
			res.once('close', () => {
				if (!res.writableEnded && !dispatched) disconnected.abort();
			});
			contexts.retain(context);
			let rpc: RpcResponse;
			try {
				const envelope = await scheduler.submitReserved<SuccessEnvelope | DiscordErrorEnvelope>(reservation, {
					requestId,
					context,
					signal: disconnected.signal,
					run: async () => {
						dispatched = true;
						try {
							const apiRequest = toApiRequestOptions(request, request.files);
							if (request.auth !== false) apiRequest.token = context.token;
							const result = await context.rest.request(request.method, request.url, apiRequest);
							return { kind: 'success', status: 200, body: result };
						} catch (error) {
							if (SeyfertError.is(error)) return discordEnvelope(error);
							throw error;
						}
					},
				});
				rpc = { status: 200, envelope, outcome: 'completed' };
			} catch (error) {
				if (error instanceof ClientDisconnectedError) {
					rpc = proxyRpc(
						proxy,
						'PROXY_INTERNAL',
						'not_dispatched',
						requestId,
						'Client disconnected before proxy dispatch.',
						'admission',
					);
				} else if (error instanceof ProxyError) {
					rpc = proxyErrorRpc(proxy, error);
				} else {
					rpc = proxyRpc(
						proxy,
						'PROXY_INTERNAL',
						dispatched ? 'unknown' : 'not_dispatched',
						requestId,
						'Proxy request failed.',
						dispatched ? 'dispatch' : 'internal',
					);
				}
			} finally {
				contexts.release(context);
			}
			if (rpc.outcome === 'not_dispatched' && rpc.code !== 'PROXY_QUEUE_TIMEOUT') claim.abort(rpc);
			else claim.complete(rpc);
			recordAndWriteRpc(rpc, requestId);
		} finally {
			scheduler.releaseReservation(reservation);
			bufferedBytes.release(admittedBytes);
		}
	};
}

export async function createProxy(rawOptions: ProxyServerOptions): Promise<ProxyServer> {
	const options = validateOptions(rawOptions);
	const bufferedBytes = new BufferedBytesBudget(options.maxBufferedBytes);
	const deduplicator = new RequestDeduplicator<RpcResponse>(
		options.deduplication.ttl,
		options.deduplication.maxEntries,
	);
	let proxy: ProxyServerImpl | undefined;
	const scheduler = new RequestScheduler(
		options.maxAdmittedRequests,
		options.queueTimeout,
		new SlidingWindow(options.invalidWindow.max, options.invalidWindow.perMs),
		() => proxy?.notifyStateChange(),
	);
	let contexts!: RestContextManager;
	contexts = new RestContextManager(
		options.rest,
		options.createRestForToken,
		options.maxTokenContexts,
		options.globalLimit,
		options.unauthenticatedLimit,
		rest => {
			rest.observe({
				onFail({ request, statusCode }) {
					if (statusCode !== 401 && statusCode !== 403) return;
					scheduler.recordInvalid();
					if (statusCode !== 401 || request.auth === false) return;
					const contextKey = contexts.requestIdentity(rest, request);
					contexts.quarantine(contextKey);
					scheduler.quarantineContext(contextKey);
				},
				async onRatelimit({ request, response }) {
					if (response.headers.get('x-ratelimit-scope') !== 'shared') scheduler.recordInvalid();
					if (
						response.headers.get('x-ratelimit-global') !== 'true' &&
						response.headers.get('x-ratelimit-scope') !== 'global'
					) {
						return;
					}
					let retryAfter =
						Number(response.headers.get('retry-after') ?? response.headers.get('x-ratelimit-reset-after')) * 1_000;
					try {
						const body = (await response.clone().json()) as { retry_after?: unknown };
						if (typeof body.retry_after === 'number') retryAfter = body.retry_after * 1_000;
					} catch {}
					contexts.blockGlobal(contexts.requestIdentity(rest, request), retryAfter);
				},
			});
		},
	);

	const handleRequest = createRequestHandler(options, scheduler, contexts, deduplicator, bufferedBytes, () => proxy!);
	const server = createServer((req, res) => {
		void handleRequest(req, res).catch(() => {
			const requestId = randomUUID();
			const envelope = proxy
				? proxy.error('PROXY_INTERNAL', 'not_dispatched', requestId, 'Proxy request failed.', 'internal')
				: proxyError('PROXY_INTERNAL', 'not_dispatched', requestId, 'Proxy request failed.', 'internal');
			writeJson(res, 500, envelope);
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(options.port, options.host, () => {
			server.off('error', reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === 'string') {
		server.close();
		throw new Error('Proxy failed to resolve its listening port.');
	}
	proxy = new ProxyServerImpl(server, scheduler, contexts, deduplicator, bufferedBytes, options.host, address.port);
	proxy.notifyStateChange();
	return proxy;
}
