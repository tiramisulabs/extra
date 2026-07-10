import { type Span, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { type CoreMetrics, durationSecondsSince } from '../metrics';
import type { TraceSource } from '../options';
import { getTracer } from '../trace-api';

export interface RestInstrumentDeps {
	checkIfShouldTrace: (source: TraceSource) => boolean;
	getMetrics: () => CoreMetrics | undefined;
}

/**
 * Minimal plugin API surface used by REST instrumentation.
 * Structural so real Seyfert plugin APIs and test fakes both assign cleanly.
 */
export interface RestApi {
	rest?: {
		observe?: (observer: RestObserver, opts?: object) => () => void;
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

export interface RestObserverSuccessPayload extends RestObserverRequestPayload {
	readonly response: { readonly status: number };
}

export interface RestObserverFailPayload extends RestObserverRequestPayload {
	readonly error: unknown;
	readonly statusCode?: number;
}

export interface RestObserverRatelimitPayload extends RestObserverRequestPayload {
	readonly response: { readonly status: number };
}

interface PendingRest {
	span: Span;
	start: number;
	method: string;
	rawPath: string;
	template: string;
}

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
	const template = path
		.split('/')
		.map(segment => (segment === 'REDACTED' ? ':token' : /^\d+$/.test(segment) ? ':id' : segment))
		.join('/')
		.replace(/\/(invites|templates)\/[^/]+/g, '/$1/:code')
		.replace(/\/reactions\/[^/]+/g, '/reactions/:emoji');

	return { path, template };
}

function shouldTrace(deps: RestInstrumentDeps, source: TraceSource): boolean {
	try {
		return deps.checkIfShouldTrace(source);
	} catch {
		// Fail open: prefer a span over silently dropping telemetry.
		return true;
	}
}

function safeEnd(span: Span): void {
	try {
		span.end();
	} catch {
		// never throw from instrumentation
	}
}

function recordRestMetrics(
	deps: RestInstrumentDeps,
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

function markError(span: Span, error: unknown): void {
	try {
		const err = error instanceof Error ? error : new Error(String(error));
		span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
		span.setAttribute('error.type', err.name || 'Error');
		span.recordException(err);
	} catch {
		// never throw from instrumentation
	}
}

function markHttpError(span: Span, status: number): void {
	try {
		span.setStatus({ code: SpanStatusCode.ERROR });
		span.setAttribute('error.type', String(status));
	} catch {
		// never throw from instrumentation
	}
}

function setStatusAttribute(span: Span, status: number | undefined): void {
	try {
		if (status !== undefined) {
			span.setAttribute('http.response.status_code', status);
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
export function instrumentRest(api: RestApi | undefined, deps: RestInstrumentDeps): () => void {
	const observe = api?.rest?.observe;
	if (typeof observe !== 'function') {
		return () => {};
	}

	/** In-flight CLIENT spans awaiting success/fail, FIFO per method+raw path. */
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
				const source: TraceSource = { kind: 'rest', method, path };
				if (!shouldTrace(deps, source)) return;

				const retryValue = payload.request?._50xRetries;
				const resendCount =
					typeof retryValue === 'number' && Number.isInteger(retryValue) && retryValue > 0 ? retryValue : 0;
				if (resendCount > 0) {
					const active = peekPending(method, rawPath);
					if (active) {
						try {
							active.span.setAttribute('http.request.resend_count', resendCount);
						} catch {
							// never throw from instrumentation
						}
						return;
					}
				}

				const start = performance.now();
				const span = getTracer().startSpan(`HTTP ${method}`, {
					kind: SpanKind.CLIENT,
					attributes: {
						'http.request.method': method,
						'url.path': path,
						'url.template': template,
						...(resendCount > 0 ? { 'http.request.resend_count': resendCount } : {}),
					},
				});
				pushPending({ span, start, method, rawPath, template });
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
					setStatusAttribute(span, status);
					if (status !== undefined && status >= 400) markHttpError(span, status);
				} catch {
					// never throw from instrumentation
				}

				const isError = status !== undefined && status >= 400;
				recordRestMetrics(deps, start, {
					'http.request.method': method,
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
					setStatusAttribute(span, status);
					if (status === undefined) markError(span, payload.error);
					else if (status >= 400) markHttpError(span, status);
				} catch {
					// never throw from instrumentation
				}

				const isError = status === undefined || status >= 400;
				recordRestMetrics(deps, start, {
					'http.request.method': method,
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

				setStatusAttribute(span, status);
				try {
					span.setAttribute('seyfert.rest.ratelimited', true);
					if (status !== undefined && status >= 400) markHttpError(span, status);
				} catch {
					// never throw from instrumentation
				}

				const isError = status !== undefined && status >= 400;
				recordRestMetrics(deps, start, {
					'http.request.method': method,
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
