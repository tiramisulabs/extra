import { type Span, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { type CoreMetrics, durationSecondsSince } from '../metrics';
import type { TraceSource } from '../options';
import { getTracer } from '../trace-api';

export interface CacheInstrumentDeps {
	checkIfShouldTrace: (source: TraceSource) => boolean;
	skipResources: ReadonlySet<string>;
	getMetrics: () => CoreMetrics | undefined;
}

/**
 * Minimal client surface used by cache instrumentation.
 * Structural so real Seyfert clients and test fakes both assign cleanly.
 */
export interface CacheClient {
	cache?: {
		adapter?: Record<string, unknown>;
	};
}

/** Adapter methods that read/write resource data (see seyfert `Adapter`). */
const ADAPTER_METHODS = [
	'get',
	'set',
	'remove',
	'patch',
	'bulkGet',
	'bulkSet',
	'bulkRemove',
	'bulkPatch',
	'getToRelationship',
] as const;

type AdapterMethod = (typeof ADAPTER_METHODS)[number];

type AnyFn = (...args: unknown[]) => unknown;

function shouldTrace(deps: CacheInstrumentDeps, source: TraceSource): boolean {
	try {
		return deps.checkIfShouldTrace(source);
	} catch {
		// Fail open: prefer a span over silently dropping telemetry.
		return true;
	}
}

function namespaceFromKey(key: string): string {
	const dot = key.indexOf('.');
	return dot === -1 ? key : key.slice(0, dot);
}

/**
 * Derive a stable resource label from adapter args.
 *
 * Seyfert resources hash ids as `{namespace}.{id}` or `{namespace}.{guild}.{id}`;
 * relationship methods pass the namespace (or derived key) as the first string arg.
 * Bulk ops take `string[]` or `[string, value][]`.
 */
export function extractCacheResource(args: unknown[]): string {
	const first = args[0];

	if (typeof first === 'string') {
		return namespaceFromKey(first);
	}

	if (Array.isArray(first) && first.length > 0) {
		const head = first[0];
		if (typeof head === 'string') {
			return namespaceFromKey(head);
		}
		if (Array.isArray(head) && typeof head[0] === 'string') {
			return namespaceFromKey(head[0]);
		}
	}

	if (first !== null && typeof first === 'object' && !Array.isArray(first)) {
		const keys = Object.keys(first as Record<string, unknown>);
		if (keys.length > 0) {
			return namespaceFromKey(keys[0]!);
		}
	}

	return 'unknown';
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return value !== null && typeof value === 'object' && typeof (value as PromiseLike<unknown>).then === 'function';
}

function safeEnd(span: Span): void {
	try {
		span.end();
	} catch {
		// never throw from instrumentation
	}
}

function markError(span: Span, error: unknown): void {
	try {
		const err = error instanceof Error ? error : new Error(String(error));
		span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
		span.recordException(err);
	} catch {
		// never throw from instrumentation
	}
}

function recordCacheMetrics(
	deps: CacheInstrumentDeps,
	start: number,
	attributes: {
		'seyfert.cache.op': string;
		'seyfert.cache.resource': string;
		'seyfert.error': boolean;
		'seyfert.cache.hit'?: boolean;
	},
): void {
	try {
		deps.getMetrics()?.recordCache(durationSecondsSince(start), attributes);
	} catch {
		// metrics must not break cache path
	}
}

/**
 * Wrap Seyfert cache adapter operations under INTERNAL spans.
 *
 * Mechanism: replace methods on `client.cache.adapter` at setup; disposer
 * restores the original function references.
 */
export function instrumentCache(client: CacheClient | unknown, deps: CacheInstrumentDeps): () => void {
	const adapter = (client as CacheClient | null | undefined)?.cache?.adapter;
	if (!adapter || typeof adapter !== 'object') {
		return () => {};
	}

	const originals = new Map<AdapterMethod, AnyFn>();

	for (const method of ADAPTER_METHODS) {
		const fn = adapter[method];
		if (typeof fn !== 'function') continue;

		const original = (fn as AnyFn).bind(adapter) as AnyFn;
		originals.set(method, fn as AnyFn);

		adapter[method] = (...args: unknown[]) => {
			let resource: string;
			try {
				resource = extractCacheResource(args);
				if (deps.skipResources.has(resource)) {
					return original(...args);
				}
				const source: TraceSource = { kind: 'cache', op: method, resource };
				if (!shouldTrace(deps, source)) {
					return original(...args);
				}
			} catch {
				return original(...args);
			}

			const start = performance.now();

			// User errors from `original` must propagate; only instrumentation
			// setup failures fall back to an untraced call.
			let invoked = false;
			try {
				return getTracer().startActiveSpan(
					`cache ${method} ${resource}`,
					{
						kind: SpanKind.INTERNAL,
						attributes: {
							'seyfert.cache.op': method,
							'seyfert.cache.resource': resource,
						},
					},
					span => {
						const finish = (value: unknown, error?: unknown) => {
							const isError = error !== undefined;
							try {
								if (method === 'get' && !isError) {
									span.setAttribute('seyfert.cache.hit', value !== undefined && value !== null);
								}
							} catch {
								// never throw from instrumentation
							}

							if (isError) {
								markError(span, error);
							}

							const metricAttrs: {
								'seyfert.cache.op': string;
								'seyfert.cache.resource': string;
								'seyfert.error': boolean;
								'seyfert.cache.hit'?: boolean;
							} = {
								'seyfert.cache.op': method,
								'seyfert.cache.resource': resource,
								'seyfert.error': isError,
							};
							if (method === 'get' && !isError) {
								metricAttrs['seyfert.cache.hit'] = value !== undefined && value !== null;
							}
							recordCacheMetrics(deps, start, metricAttrs);
							safeEnd(span);
						};

						try {
							invoked = true;
							const result = original(...args);
							if (isThenable(result)) {
								return Promise.resolve(result).then(
									value => {
										finish(value);
										return value;
									},
									error => {
										finish(undefined, error);
										throw error;
									},
								);
							}
							finish(result);
							return result;
						} catch (error) {
							finish(undefined, error);
							throw error;
						}
					},
				);
			} catch (error) {
				if (invoked) throw error;
				return original(...args);
			}
		};
	}

	return () => {
		for (const [method, original] of originals) {
			try {
				adapter[method] = original;
			} catch {
				// never throw from instrumentation cleanup
			}
		}
		originals.clear();
	};
}
