import { type Span, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import {
	ATTR_ERROR_TYPE,
	ATTR_HTTP_REQUEST_METHOD,
	ATTR_HTTP_REQUEST_METHOD_ORIGINAL,
	ATTR_HTTP_REQUEST_RESEND_COUNT,
	ATTR_HTTP_RESPONSE_HEADER,
	ATTR_HTTP_RESPONSE_STATUS_CODE,
	ATTR_SERVER_ADDRESS,
	ATTR_SERVER_PORT,
	ATTR_URL_FULL,
	ATTR_URL_PATH,
} from '@opentelemetry/semantic-conventions';
import { type RESTError, SeyfertError } from 'seyfert';
import { durationSecondsSince } from '../metrics';
import type { TraceSource } from '../options';
import { getTracer } from '../trace-api';
import type { InstrumentDeps, InstrumentTarget } from './deps';

/**
 * Minimal plugin API surface used by REST instrumentation.
 * Structural so real Seyfert plugin APIs and test fakes both assign cleanly.
 */
export interface RestApi {
	rest?: {
		observe?: (observer: RestObserver, opts?: object) => () => void;
	};
}

/** The Seyfert client owns the real `ApiHandler`; the plugin api only exposes `observe`. */
export interface RestOptionsSource {
	rest?: {
		options?: { domain?: string; baseUrl?: string };
	};
}

/** Subset of Seyfert `RestObserver` callbacks we consume. */
export interface RestObserver {
	onRequest?(payload: RestObserverRequestPayload): unknown;
	onSuccess?(payload: RestObserverSuccessPayload): unknown;
	onFail?(payload: RestObserverFailPayload): unknown;
	onRatelimit?(payload: RestObserverRatelimitPayload): unknown;
}

export interface RestObserverRequestPayload {
	readonly method: string;
	readonly url: string;
	readonly request?: Readonly<Record<string, unknown>>;
	readonly client?: unknown;
}

export interface RestObserverResponse {
	readonly status: number;
	readonly headers?: { get(name: string): string | null };
}

export interface RestObserverSuccessPayload extends RestObserverRequestPayload {
	readonly response: RestObserverResponse;
}

export interface RestObserverFailPayload extends RestObserverRequestPayload {
	readonly error: unknown;
	readonly statusCode?: number;
}

export interface RestObserverRatelimitPayload extends RestObserverRequestPayload {
	readonly response: RestObserverResponse;
}

interface PendingRest {
	span?: Span;
	start: number;
	method: string;
	methodAttribute: string;
	rawPath: string;
	template: string;
}

const DEFAULT_DISCORD_DOMAIN = 'https://discord.com';
const DEFAULT_DISCORD_BASE_PATH = 'api/v10';
const KNOWN_HTTP_METHODS = new Set(['CONNECT', 'DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT', 'TRACE']);

/** Discord route parameters, named after the segment that introduces them. */
const ROUTE_PARAM_NAMES: Record<string, string> = {
	applications: 'application_id',
	bans: 'user_id',
	channels: 'channel_id',
	emojis: 'emoji_id',
	guilds: 'guild_id',
	integrations: 'integration_id',
	interactions: 'interaction_id',
	members: 'user_id',
	messages: 'message_id',
	permissions: 'overwrite_id',
	pins: 'message_id',
	recipients: 'user_id',
	roles: 'role_id',
	'scheduled-events': 'scheduled_event_id',
	stickers: 'sticker_id',
	threads: 'thread_id',
	users: 'user_id',
	webhooks: 'webhook_id',
};

function flightKey(method: string, path: string): string {
	return `${method}\0${path}`;
}

export interface SanitizedRestTarget {
	/** URI path with Discord webhook/interaction tokens removed. */
	path: string;
	/** Low-cardinality Discord route template for metrics. */
	template: string;
}

/**
 * Keep useful Discord route structure without exporting secrets or snowflake IDs.
 * Query strings are intentionally omitted because `url.path` is only the URI path.
 */
export function sanitizeRestTarget(value: string): SanitizedRestTarget {
	let path = value.split(/[?#]/, 1)[0] || '/';
	try {
		if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) path = new URL(value).pathname;
	} catch {
		// Keep the best-effort relative path above.
	}

	path = path.replace(/(\/(?:interactions|webhooks)\/[^/]+)\/[^/]+/g, '$1/REDACTED');

	const segments = path.split('/');
	const template = segments
		.map((segment, index) => {
			if (segment === 'REDACTED') return '{token}';
			const parent = segments[index - 1];
			if (parent === 'invites' || parent === 'templates') return '{code}';
			if (parent === 'reactions') return '{emoji}';
			if (!/^\d+$/.test(segment)) return segment;
			if (segments[index - 2] === 'reactions') return '{user_id}';
			return `{${ROUTE_PARAM_NAMES[parent] ?? 'id'}}`;
		})
		.join('/');

	return { path, template };
}

function normalizeHttpMethod(method: string): { method: string; original?: string } {
	const normalized = method.toUpperCase();
	if (KNOWN_HTTP_METHODS.has(normalized)) {
		return normalized === method ? { method: normalized } : { method: normalized, original: method };
	}
	return { method: '_OTHER', original: method };
}

/**
 * Seyfert hands observers a relative route (`api.js` builds the absolute URL separately),
 * so the real peer only exists in the api handler options.
 */
function resolveApiBase(client: RestOptionsSource | undefined): string {
	const options = client?.rest?.options;
	const domain = typeof options?.domain === 'string' && options.domain ? options.domain : DEFAULT_DISCORD_DOMAIN;
	const basePath = typeof options?.baseUrl === 'string' ? options.baseUrl : DEFAULT_DISCORD_BASE_PATH;
	return `${domain.replace(/\/+$/, '')}/${basePath.replace(/^\/+|\/+$/g, '')}`;
}

function createSanitizedUrl(base: string, path: string): URL | undefined {
	try {
		const url = new URL(`${base}${path}`);
		url.username = '';
		url.password = '';
		url.search = '';
		url.hash = '';
		return url;
	} catch {
		// Omitting the peer beats asserting one we never observed.
		return undefined;
	}
}

function shouldTrace(deps: InstrumentDeps, source: TraceSource): boolean {
	try {
		return deps.checkIfShouldTrace(source);
	} catch {
		// Fail open: prefer a span over silently dropping telemetry.
		return true;
	}
}

function safeEnd(span: Span | undefined): void {
	if (!span) return;
	try {
		span.end();
	} catch {
		// never throw from instrumentation
	}
}

function recordRestMetrics(
	deps: InstrumentDeps,
	start: number,
	attributes: {
		'http.request.method': string;
		'url.template': string;
		'http.response.status_code'?: number;
		'seyfert.error': boolean;
	},
): void {
	try {
		deps.getMetrics()?.recordRest(durationSecondsSince(start), attributes);
	} catch {
		// metrics must not break request path
	}
}

function markError(span: Span, error: unknown, errorType?: string): void {
	try {
		const err = error instanceof Error ? error : new Error(String(error));
		const response = SeyfertError.is(err) ? (err.metadata?.response as RESTError | undefined) : undefined;
		span.setStatus({ code: SpanStatusCode.ERROR, message: response?.message ?? err.message });
		span.setAttribute(ATTR_ERROR_TYPE, errorType ?? (err.name || 'Error'));
		if (response?.code !== undefined) span.setAttribute('discord.error.code', response.code);
		span.recordException(err);
	} catch {
		// never throw from instrumentation
	}
}

function setRatelimitAttributes(span: Span, response: RestObserverResponse | undefined, ratelimited: boolean): void {
	try {
		const headers = response?.headers;
		if (typeof headers?.get !== 'function') return;

		const bucket = headers.get('x-ratelimit-bucket');
		if (bucket) span.setAttribute('discord.ratelimit.bucket', bucket);
		if (!ratelimited) return;

		const scope = headers.get('x-ratelimit-scope');
		if (scope) span.setAttribute('discord.ratelimit.scope', scope);
		const retryAfter = headers.get('retry-after');
		if (retryAfter) span.setAttribute(ATTR_HTTP_RESPONSE_HEADER('retry-after'), [retryAfter]);
	} catch {
		// never throw from instrumentation
	}
}

function markHttpError(span: Span, status: number): void {
	try {
		span.setStatus({ code: SpanStatusCode.ERROR });
		span.setAttribute(ATTR_ERROR_TYPE, String(status));
	} catch {
		// never throw from instrumentation
	}
}

function setStatusAttribute(span: Span, status: number | undefined): void {
	try {
		if (status !== undefined) {
			span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, status);
		}
	} catch {
		// never throw from instrumentation
	}
}

/**
 * Instrument Discord REST via Seyfert first-class `api.rest.observe`.
 *
 * Correlation: observer payloads are frozen and `request` is deep-cloned per
 * notification, so WeakMap/Symbol on the payload cannot link onRequest →
 * onSuccess/onFail. In-flight spans are correlated with a FIFO queue keyed by
 * `method + url` (stable across the callbacks). Seyfert marks 502/503 retries
 * with `_50xRetries`; those callbacks update the original logical span instead
 * of opening an orphan attempt.
 */
export function instrumentRest(target: InstrumentTarget, deps: InstrumentDeps): () => void {
	const observe = (target.api as RestApi | undefined)?.rest?.observe;
	if (typeof observe !== 'function') {
		return () => {};
	}

	const apiBase = resolveApiBase(target.client as RestOptionsSource | undefined);

	/** In-flight requests awaiting success/fail, FIFO per method+raw path. */
	const pending = new Map<string, PendingRest[]>();

	const pushPending = (item: PendingRest): void => {
		const key = flightKey(item.method, item.rawPath);
		const queue = pending.get(key);
		if (queue) {
			queue.push(item);
		} else {
			pending.set(key, [item]);
		}
	};

	const takePending = (method: string, path: string): PendingRest | undefined => {
		const key = flightKey(method, path);
		const queue = pending.get(key);
		if (!queue?.length) return undefined;
		const item = queue.shift();
		if (queue.length === 0) pending.delete(key);
		return item;
	};

	const peekPending = (method: string, path: string): PendingRest | undefined =>
		pending.get(flightKey(method, path))?.[0];

	const disposer = observe({
		onRequest(payload) {
			try {
				const method = String(payload.method);
				const rawPath = String(payload.url);
				const { path, template } = sanitizeRestTarget(rawPath);
				const url = createSanitizedUrl(apiBase, path);
				const normalizedMethod = normalizeHttpMethod(method);
				const source: TraceSource = { kind: 'rest', method, path };
				const createSpan = deps.traceEnabled && shouldTrace(deps, source);

				const retryValue = payload.request?._50xRetries;
				const resendCount =
					typeof retryValue === 'number' && Number.isInteger(retryValue) && retryValue > 0 ? retryValue : 0;
				if (resendCount > 0) {
					const active = peekPending(method, rawPath);
					if (active) {
						try {
							active.span?.setAttribute(ATTR_HTTP_REQUEST_RESEND_COUNT, resendCount);
						} catch {
							// never throw from instrumentation
						}
						return;
					}
				}

				const start = performance.now();
				const spanMethod = normalizedMethod.method === '_OTHER' ? 'HTTP' : normalizedMethod.method;
				const span = createSpan
					? getTracer().startSpan(`${spanMethod} ${template}`, {
							kind: SpanKind.CLIENT,
							attributes: {
								[ATTR_HTTP_REQUEST_METHOD]: normalizedMethod.method,
								...(normalizedMethod.original
									? { [ATTR_HTTP_REQUEST_METHOD_ORIGINAL]: normalizedMethod.original }
									: {}),
								...(url
									? {
											[ATTR_SERVER_ADDRESS]: url.hostname,
											[ATTR_SERVER_PORT]: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80,
											[ATTR_URL_FULL]: url.href,
										}
									: {}),
								[ATTR_URL_PATH]: path,
								'url.template': template,
								...(resendCount > 0 ? { [ATTR_HTTP_REQUEST_RESEND_COUNT]: resendCount } : {}),
							},
						})
					: undefined;
				pushPending({ span, start, method, methodAttribute: normalizedMethod.method, rawPath, template });
			} catch {
				// never throw from instrumentation into the request path
			}
		},

		onSuccess(payload) {
			try {
				const method = String(payload.method);
				const rawPath = String(payload.url);
				const item = takePending(method, rawPath);
				if (!item) return;

				const { span, start } = item;
				const status =
					payload.response && typeof payload.response.status === 'number' ? payload.response.status : undefined;

				try {
					if (span) {
						setStatusAttribute(span, status);
						setRatelimitAttributes(span, payload.response, false);
						if (status !== undefined && status >= 400) markHttpError(span, status);
					}
				} catch {
					// never throw from instrumentation
				}

				const isError = status !== undefined && status >= 400;
				recordRestMetrics(deps, start, {
					'http.request.method': item.methodAttribute,
					'url.template': item.template,
					...(status !== undefined ? { 'http.response.status_code': status } : {}),
					'seyfert.error': isError,
				});
				safeEnd(span);
			} catch {
				// never throw from instrumentation
			}
		},

		onFail(payload) {
			try {
				const method = String(payload.method);
				const rawPath = String(payload.url);
				const item = takePending(method, rawPath);
				if (!item) return;

				const { span, start } = item;
				const status = typeof payload.statusCode === 'number' ? payload.statusCode : undefined;

				try {
					if (span) {
						setStatusAttribute(span, status);
						if (status === undefined) markError(span, payload.error);
						else if (status >= 400 && payload.error instanceof Error) markError(span, payload.error, String(status));
						else if (status >= 400) markHttpError(span, status);
					}
				} catch {
					// never throw from instrumentation
				}

				const isError = status === undefined || status >= 400;
				recordRestMetrics(deps, start, {
					'http.request.method': item.methodAttribute,
					'url.template': item.template,
					...(status !== undefined ? { 'http.response.status_code': status } : {}),
					'seyfert.error': isError,
				});
				safeEnd(span);
			} catch {
				// never throw from instrumentation
			}
		},

		onRatelimit(payload) {
			try {
				const method = String(payload.method);
				const rawPath = String(payload.url);
				const item = takePending(method, rawPath);
				if (!item) return;

				const { span, start } = item;
				const status =
					payload.response && typeof payload.response.status === 'number' ? payload.response.status : undefined;

				if (span) setStatusAttribute(span, status);
				try {
					span?.setAttribute('seyfert.rest.ratelimited', true);
					if (span) setRatelimitAttributes(span, payload.response, true);
					if (span && status !== undefined && status >= 400) markHttpError(span, status);
				} catch {
					// never throw from instrumentation
				}

				const isError = status !== undefined && status >= 400;
				recordRestMetrics(deps, start, {
					'http.request.method': item.methodAttribute,
					'url.template': item.template,
					...(status !== undefined ? { 'http.response.status_code': status } : {}),
					'seyfert.error': isError,
				});
				safeEnd(span);
			} catch {
				// never throw from instrumentation
			}
		},
	});

	return () => {
		try {
			disposer();
		} catch {
			// never throw from instrumentation cleanup
		}
		for (const queue of pending.values()) {
			for (const item of queue) {
				safeEnd(item.span);
			}
		}
		pending.clear();
	};
}
