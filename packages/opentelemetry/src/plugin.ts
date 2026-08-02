import { createPlugin } from 'seyfert';
import { createInteractionContextScope } from './context-scope';
import { createTraceHandle } from './handle';
import { instrumentCache } from './instrument/cache';
import { instrumentEvents } from './instrument/events';
import {
	type InteractionHandlerKind,
	type InteractionInstrumentor,
	instrumentInteractionMiddlewares,
	registerInteractionInstrumentation,
} from './instrument/interactions';
import { instrumentRest } from './instrument/rest';
import { type CoreMetrics, createCoreMetrics } from './metrics';
import { type OpenTelemetryPluginOptions, resolvePluginOptions } from './options';
import { type OwnedSdk, startOwnedSdk } from './sdk';

export function opentelemetry(options: OpenTelemetryPluginOptions = {}) {
	const resolved = resolvePluginOptions(options);
	let interactionInstrumentor: InteractionInstrumentor | undefined;
	const handle = createTraceHandle({
		instrumentInteractions: (handlers: Iterable<object>, kind?: InteractionHandlerKind) =>
			interactionInstrumentor?.instrument(handlers, kind) ?? 0,
	});
	let owned: OwnedSdk | undefined;
	let metrics: CoreMetrics | undefined;
	const cleanups: Array<() => void> = [];
	let setupActive = false;
	let tornDown = false;

	const runCleanups = () => {
		for (const cleanup of cleanups.splice(0).reverse()) {
			try {
				cleanup();
			} catch {
				// never throw from instrumentation cleanup
			}
		}
	};

	return createPlugin({
		name: '@slipher/opentelemetry',
		client: {
			trace: () => handle,
		},
		ctx: {
			trace: () => handle,
		},
		options() {
			if (!resolved.traces.interactions && !resolved.metrics.interactions) return {};
			return {
				contextScopes: [
					createInteractionContextScope({
						traceEnabled: resolved.traces.interactions,
						checkIfShouldTrace: resolved.checkIfShouldTrace,
						getMetrics: () => metrics,
					}),
				],
			};
		},
		register(api) {
			if (!resolved.traces.interactions) return;
			interactionInstrumentor = registerInteractionInstrumentation(api, {
				checkIfShouldTrace: resolved.checkIfShouldTrace,
			});
		},
		setup(client, api) {
			if (tornDown) {
				throw new Error('@slipher/opentelemetry cannot be set up after teardown; create a new plugin instance');
			}
			// Idempotent: unwrap previous instrumentors before re-wrapping.
			if (setupActive) {
				runCleanups();
			}
			setupActive = true;

			// Keep an already-owned SDK; a second start would no-op and drop the handle.
			owned ??= startOwnedSdk(resolved);
			metrics = createCoreMetrics(resolved.metrics);
			if (resolved.traces.interactions) {
				cleanups.push(
					instrumentInteractionMiddlewares(client, {
						checkIfShouldTrace: resolved.checkIfShouldTrace,
					}),
				);
			}

			if (resolved.traces.events || resolved.metrics.events) {
				cleanups.push(
					instrumentEvents(
						client,
						{
							traceEnabled: resolved.traces.events,
							checkIfShouldTrace: resolved.checkIfShouldTrace,
							getMetrics: () => metrics,
						},
						api,
					),
				);
			}
			if (resolved.traces.rest || resolved.metrics.rest) {
				cleanups.push(
					instrumentRest(api, {
						traceEnabled: resolved.traces.rest,
						checkIfShouldTrace: resolved.checkIfShouldTrace,
						getMetrics: () => metrics,
					}),
				);
			}
			if (resolved.traces.cache || resolved.metrics.cache) {
				cleanups.push(
					instrumentCache(client, {
						traceEnabled: resolved.traces.cache,
						checkIfShouldTrace: resolved.checkIfShouldTrace,
						skipResources: resolved.cache.skipResources,
						getMetrics: () => metrics,
					}),
				);
			}
		},
		async teardown() {
			if (tornDown) return;
			tornDown = true;
			try {
				runCleanups();
				if (owned) await owned.shutdown();
			} finally {
				owned = undefined;
				metrics = undefined;
				setupActive = false;
			}
		},
	});
}

// Inferred so the client/ctx `trace` extension (E/C) reaches consumers via SeyfertRegistry.
// A hand-written interface + `as` cast previously erased it, breaking `client.trace` typing.
export type OpenTelemetryPlugin = ReturnType<typeof opentelemetry>;
