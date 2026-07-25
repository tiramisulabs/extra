import { randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { ApiHandler, type ApiRequestOptions, type HttpMethods, SeyfertError } from 'seyfert';
import { positiveInteger, proxyApiHandlerMarker, toError } from './internal';
import {
	type DiscordErrorEnvelope,
	ProxyError,
	type ProxyResponseEnvelope,
	parseResponseEnvelope,
	proxyError,
	type WireApiRequest,
} from './protocol';
import { type EncodedRequest, encodeProxyRequest } from './transport';

export interface ProxyApiHandlerOptions {
	url: string | URL;
	credential: string;
	requestTimeout?: number;
}

interface TransportResult {
	status: number;
	body: Buffer;
}

class ProxyRequestTimeoutError extends Error {
	constructor() {
		super('Proxy request timed out.');
	}
}

function resolveEndpoint(value: string | URL): URL {
	const url = new URL(value);
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new TypeError('ProxyApiHandler url must use http: or https:.');
	}
	if (url.username || url.password) throw new TypeError('ProxyApiHandler url must not include credentials.');
	if (url.pathname !== '/' || url.search || url.hash) {
		throw new TypeError('ProxyApiHandler url must not include a pathname, query, or hash.');
	}
	url.pathname = '/v1/requests';
	return url;
}

function localProxyError(requestId: string, outcome: 'not_dispatched' | 'unknown', cause: unknown): ProxyError {
	return new ProxyError(
		proxyError('PROXY_INTERNAL', outcome, requestId, `Proxy transport failed: ${toError(cause).message}`, 'transport'),
		{ cause },
	);
}

function requestProxy(
	endpoint: URL,
	credential: string,
	encoded: EncodedRequest,
	requestId: string,
	requestTimeout: number | undefined,
): Promise<TransportResult> {
	return new Promise((resolve, reject) => {
		let socketConnected = false;
		let requestFinished = false;
		let dispatched = false;
		let timer: NodeJS.Timeout | undefined;
		const succeed = (result: TransportResult) => {
			if (timer) clearTimeout(timer);
			resolve(result);
		};
		const fail = (error: ProxyError) => {
			if (timer) clearTimeout(timer);
			reject(error);
		};
		// Once the socket is connected and the request stream finished, delivery can no longer be proven absent.
		const markDispatched = () => {
			if (socketConnected && requestFinished) dispatched = true;
		};
		const transport = endpoint.protocol === 'https:' ? https : http;
		const request = transport.request(
			endpoint,
			{
				method: 'POST',
				headers: {
					authorization: `Bearer ${credential}`,
					'content-length': encoded.body.byteLength,
					'content-type': encoded.contentType,
					'x-proxy-request-id': requestId,
				},
			},
			response => {
				const chunks: Buffer[] = [];
				response.on('data', chunk => chunks.push(Buffer.from(chunk)));
				response.on('end', () => succeed({ status: response.statusCode ?? 500, body: Buffer.concat(chunks) }));
				response.once('aborted', () =>
					fail(localProxyError(requestId, 'unknown', new Error('Proxy response was aborted.'))),
				);
				response.once('error', error => fail(localProxyError(requestId, 'unknown', error)));
			},
		);
		request.once('socket', socket => {
			if (!socket.connecting) {
				socketConnected = true;
				markDispatched();
			} else if (endpoint.protocol === 'https:') {
				socket.once('secureConnect', () => {
					socketConnected = true;
					markDispatched();
				});
			} else {
				socket.once('connect', () => {
					socketConnected = true;
					markDispatched();
				});
			}
		});
		request.once('finish', () => {
			requestFinished = true;
			markDispatched();
		});
		if (requestTimeout !== undefined) {
			timer = setTimeout(() => request.destroy(new ProxyRequestTimeoutError()), requestTimeout);
			timer.unref();
		}
		request.once('error', error => {
			const outcome = error instanceof ProxyRequestTimeoutError || dispatched ? 'unknown' : 'not_dispatched';
			fail(localProxyError(requestId, outcome, error));
		});
		request.end(encoded.body);
	});
}

function reconstructSeyfertError(envelope: DiscordErrorEnvelope, originStack: string | undefined): SeyfertError {
	const error = new SeyfertError(envelope.error.code, {
		metadata: envelope.error.metadata ?? { status: envelope.status, response: envelope.body },
	});
	if (originStack) {
		const lines = originStack.split('\n').slice(1);
		error.stack = `${error.name}: ${error.message}\n${lines.join('\n')}`;
	}
	return error;
}

function decodeEnvelope(result: TransportResult, requestId: string): ProxyResponseEnvelope {
	let value: unknown;
	try {
		value = JSON.parse(result.body.toString());
	} catch (cause) {
		throw localProxyError(requestId, 'unknown', cause);
	}
	const envelope = parseResponseEnvelope(value);
	if (!envelope) throw localProxyError(requestId, 'unknown', new Error(`Invalid proxy response (${result.status}).`));
	return envelope;
}

export class ProxyApiHandler extends ApiHandler {
	readonly endpoint: URL;
	private readonly credential: string;
	private readonly requestTimeout: number | undefined;

	constructor(options: ProxyApiHandlerOptions) {
		if (!options.credential) throw new TypeError('ProxyApiHandler credential must not be empty.');
		super({ token: 'INVALID', workerProxy: false });
		Object.defineProperty(this, proxyApiHandlerMarker, { value: true });
		this.endpoint = resolveEndpoint(options.url);
		this.credential = options.credential;
		this.requestTimeout =
			options.requestTimeout === undefined ? undefined : positiveInteger(options.requestTimeout, 'requestTimeout');
	}

	override async request<T = unknown>(
		method: HttpMethods,
		url: `/${string}`,
		request: ApiRequestOptions = {},
	): Promise<T> {
		const requestId = randomUUID();
		const wire: WireApiRequest = {
			method,
			url,
			requestId,
			...(request.query === undefined ? {} : { query: request.query }),
			...(request.body === undefined ? {} : { body: request.body }),
			...(request.auth === undefined ? {} : { auth: request.auth }),
			...(request.reason === undefined ? {} : { reason: request.reason }),
			...(request.appendToFormData === undefined ? {} : { appendToFormData: request.appendToFormData }),
			...(request.token === undefined ? {} : { token: request.token }),
		};

		const origin = new Error();
		Error.captureStackTrace?.(origin, this.request);
		let encoded: EncodedRequest;
		try {
			encoded = await encodeProxyRequest(wire, request.files);
		} catch (cause) {
			throw localProxyError(requestId, 'not_dispatched', cause);
		}
		const result = await requestProxy(this.endpoint, this.credential, encoded, requestId, this.requestTimeout);
		const envelope = decodeEnvelope(result, requestId);
		if (envelope.kind === 'proxy_error') throw new ProxyError(envelope);
		if (envelope.kind === 'discord_error') throw reconstructSeyfertError(envelope, origin.stack);
		return envelope.body as T;
	}
}
