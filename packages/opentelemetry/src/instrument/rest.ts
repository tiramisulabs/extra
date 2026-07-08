import { SpanKind, SpanStatusCode, type Span } from '@opentelemetry/api';
import { durationSecondsSince, type CoreMetrics } from '../metrics';
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

interface PendingRest {
	span: Span;
	start: number;
	method: string;
	path: string;
}

function flightKey(method: string, path: string): string {
	return `${method}\0${path}`;
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
		'url.path': string;
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

function markError(span: Span, error: unknown, message?: string): void {
	try {
		const err = error instanceof Error ? error : new Error(message ?? String(error));
		span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
		span.recordException(err);
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
 * `method + url` (stable across the three callbacks for a given request).
 */
export function instrumentRest(
	api: RestApi | undefined,
	deps: RestInstrumentDeps,
): () => void {
	const observe = api?.rest?.observe;
	if (typeof observe !== 'function') {
		return () => {};
	}

	/** In-flight CLIENT spans awaiting success/fail, FIFO per method+path. */
	const pending = new Map<string, PendingRest[]>();

	const pushPending = (item: PendingRest): void => {
		const key = flightKey(item.method, item.path);
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

	const disposer = observe({
		onRequest(payload) {
			try {
				const method = String(payload.method);
				const path = String(payload.url);
				const source: TraceSource = { kind: 'rest', method, path };
				if (!shouldTrace(deps, source)) return;

				const start = performance.now();
				const span = getTracer().startSpan(`HTTP ${method}`, {
					kind: SpanKind.CLIENT,
					attributes: {
						'http.request.method': method,
						'url.path': path,
					},
				});
				pushPending({ span, start, method, path });
			} catch {
				// never throw from instrumentation into the request path
			}
		},

		onSuccess(payload) {
			try {
				const method = String(payload.method);
				const path = String(payload.url);
				const item = takePending(method, path);
				if (!item) return;

				const { span, start } = item;
				const status =
					payload.response && typeof payload.response.status === 'number'
						? payload.response.status
						: undefined;

				try {
					if (status !== undefined) {
						span.setAttribute('http.response.status_code', status);
					}
					if (status !== undefined && status >= 500) {
						span.setStatus({
							code: SpanStatusCode.ERROR,
							message: `HTTP ${status}`,
						});
					}
				} catch {
					// never throw from instrumentation
				}

				const isError = status !== undefined && status >= 500;
				recordRestMetrics(deps, start, {
					'http.request.method': method,
					'url.path': path,
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
				const path = String(payload.url);
				const item = takePending(method, path);
				if (!item) return;

				const { span, start } = item;
				const status =
					typeof payload.statusCode === 'number' ? payload.statusCode : undefined;

				try {
					if (status !== undefined) {
						span.setAttribute('http.response.status_code', status);
					}
					// ERROR on throw/network (no status) or HTTP >= 500; 4xx stays unset.
					if (status === undefined || status >= 500) {
						markError(
							span,
							payload.error,
							status !== undefined ? `HTTP ${status}` : undefined,
						);
					}
				} catch {
					// never throw from instrumentation
				}

				const isError = status === undefined || status >= 500;
				recordRestMetrics(deps, start, {
					'http.request.method': method,
					'url.path': path,
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
