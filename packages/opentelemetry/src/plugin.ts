import { createPlugin, type SeyfertPlugin } from 'seyfert';
import { createInteractionContextScope } from './context-scope';
import { createTraceHandle } from './handle';
import { instrumentCache } from './instrument/cache';
import { instrumentEvents } from './instrument/events';
import { registerInteractionInstrumentation } from './instrument/interactions';
import { instrumentRest } from './instrument/rest';
import { createCoreMetrics, type CoreMetrics } from './metrics';
import { resolvePluginOptions, type OpenTelemetryPluginOptions } from './options';
import { startOwnedSdk, type OwnedSdk } from './sdk';
import { setTraceServiceName } from './trace-api';

export interface OpenTelemetryPlugin extends SeyfertPlugin {
	name: '@slipher/opentelemetry';
}

export function opentelemetry(options: OpenTelemetryPluginOptions = {}): OpenTelemetryPlugin {
	const resolved = resolvePluginOptions(options);
	const handle = createTraceHandle();
	let owned: OwnedSdk | undefined;
	let metrics: CoreMetrics | undefined;
	const cleanups: Array<() => void> = [];

	return createPlugin({
		name: '@slipher/opentelemetry',
		client: {
			trace: () => handle,
		},
		ctx: {
			trace: () => handle,
		},
		options() {
			if (!resolved.instrument.interactions) return {};
			return {
				contextScopes: [
					createInteractionContextScope({
						serviceName: resolved.serviceName,
						checkIfShouldTrace: resolved.checkIfShouldTrace,
						getMetrics: () => metrics,
					}),
				],
			};
		},
		register(api) {
			if (!resolved.instrument.interactions) return;
			registerInteractionInstrumentation(api, {
				checkIfShouldTrace: resolved.checkIfShouldTrace,
			});
		},
		setup(client, api) {
			setTraceServiceName(resolved.serviceName);
			owned = startOwnedSdk(resolved);
			metrics = createCoreMetrics(resolved.serviceName, resolved.instrument);

			if (resolved.instrument.events) {
				cleanups.push(
					instrumentEvents(client, {
						checkIfShouldTrace: resolved.checkIfShouldTrace,
						getMetrics: () => metrics,
					}),
				);
			}
			if (resolved.instrument.rest) {
				cleanups.push(
					instrumentRest(api, {
						checkIfShouldTrace: resolved.checkIfShouldTrace,
						getMetrics: () => metrics,
					}),
				);
			}
			if (resolved.instrument.cache) {
				cleanups.push(
					instrumentCache(client, {
						checkIfShouldTrace: resolved.checkIfShouldTrace,
						skipResources: resolved.cache.skipResources,
						getMetrics: () => metrics,
					}),
				);
			}
		},
		async teardown() {
			try {
				for (const cleanup of cleanups.splice(0).reverse()) {
					try {
						cleanup();
					} catch {
						// never throw from instrumentation cleanup
					}
				}
				if (owned) await owned.shutdown();
			} finally {
				owned = undefined;
				metrics = undefined;
			}
		},
	}) as OpenTelemetryPlugin;
}
