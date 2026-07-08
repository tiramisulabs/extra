import { type Attributes, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { type CoreMetrics, durationSecondsSince } from '../metrics';
import type { TraceSource } from '../options';
import { getTracer } from '../trace-api';

export interface EventsInstrumentDeps {
	checkIfShouldTrace: (source: TraceSource) => boolean;
	getMetrics: () => CoreMetrics | undefined;
}

/**
 * Minimal client surface used by gateway event instrumentation.
 * Structural so real Seyfert clients and test fakes both assign cleanly.
 */
export interface EventsClient {
	events?: {
		/**
		 * Seyfert `EventHandler.runEvent` — single path for gateway dispatches
		 * (`MESSAGE_CREATE`, `BOT_READY`, …) including plugin listeners.
		 */
		runEvent?: (name: string, ...args: unknown[]) => unknown;
	};
}

type RunEvent = (name: string, ...args: unknown[]) => unknown;

function shouldTrace(deps: EventsInstrumentDeps, source: TraceSource): boolean {
	try {
		return deps.checkIfShouldTrace(source);
	} catch {
		// Fail open: prefer a span over silently dropping telemetry.
		return true;
	}
}

function eventAttributes(name: string, args: readonly unknown[]): Attributes {
	const attributes: Attributes = {
		'seyfert.event.name': name,
	};
	// runEvent(name, client, packet, shardId, runCache?)
	const shardId = args[2];
	if (typeof shardId === 'number' && Number.isFinite(shardId)) {
		attributes['seyfert.shard_id'] = shardId;
	}
	return attributes;
}

/**
 * Wrap gateway event dispatch (`client.events.runEvent`) under root spans.
 *
 * Why `runEvent` and not first-class plugin hooks:
 * - `api.events.onAny` / `on` add parallel listeners; they do not wrap user handlers.
 * - `gateway.onDispatch` filters/transforms packets before execution; it is not a handler scope.
 * - `handlers.transform` only mutates file-loaded event instances, not plugin listeners.
 *
 * `runEvent` is the single path Seyfert uses for gateway event invocation
 * (user files + plugin listeners + BOT_READY / RAW / …). Cleanup restores the original.
 */
export function instrumentEvents(client: EventsClient | unknown, deps: EventsInstrumentDeps): () => void {
	const events = (client as EventsClient | null | undefined)?.events;
	if (!events || typeof events.runEvent !== 'function') {
		return () => {};
	}

	const original: RunEvent = events.runEvent.bind(events);

	events.runEvent = function instrumentedRunEvent(name: string, ...args: unknown[]): unknown {
		const source: TraceSource = { kind: 'event', name, args };
		if (!shouldTrace(deps, source)) {
			return original(name, ...args);
		}

		const attributes = eventAttributes(name, args);
		const start = performance.now();

		return getTracer().startActiveSpan(`event ${name}`, { kind: SpanKind.INTERNAL, attributes }, span => {
			const finish = (error?: unknown) => {
				if (error !== undefined) {
					const err = error instanceof Error ? error : new Error(String(error));
					try {
						span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
						span.recordException(err);
					} catch {
						// never throw from instrumentation into the user path
					}
				}
				try {
					deps.getMetrics()?.recordEvent(durationSecondsSince(start), {
						...attributes,
						'seyfert.error': error !== undefined,
					});
				} catch {
					// metrics must not break handlers
				}
				try {
					span.end();
				} catch {
					// never throw from instrumentation
				}
			};

			try {
				const result = original(name, ...args);
				if (result !== null && typeof result === 'object' && typeof (result as Promise<unknown>).then === 'function') {
					return Promise.resolve(result).then(
						value => {
							finish();
							return value;
						},
						error => {
							finish(error);
							throw error;
						},
					);
				}
				finish();
				return result;
			} catch (error) {
				finish(error);
				throw error;
			}
		});
	};

	return () => {
		events.runEvent = original;
	};
}
