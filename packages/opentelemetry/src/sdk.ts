import { context, metrics, ProxyTracerProvider, propagation, type TracerProvider, trace } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import type { ResolvedOpenTelemetryOptions } from './options';

/**
 * Whether this process still has only the API proxy provider (no real SDK).
 */
export function shouldStartNodeSDK(provider: TracerProvider): boolean {
	if (!(provider instanceof ProxyTracerProvider)) return false;
	return provider.getDelegateTracer('check') === undefined;
}

export interface OwnedSdk {
	sdk: NodeSDK;
	shutdown(): Promise<void>;
}

type GlobalApi = Partial<Record<'context' | 'metrics' | 'propagation' | 'trace', unknown>>;

// OpenTelemetry exposes global disable operations but no public identity getters
// for context/propagation. Snapshot its versioned registries so teardown removes
// only globals this SDK installed, never providers that were already owned by the host.
const GLOBAL_API_KEY = Symbol.for('opentelemetry.js.api.1');
const GLOBAL_LOGS_API_KEY = Symbol.for('io.opentelemetry.js.api.logs');

function snapshotGlobalApi(): GlobalApi {
	const registry = (globalThis as unknown as Record<symbol, GlobalApi | undefined>)[GLOBAL_API_KEY];
	return registry ? { ...registry } : {};
}

function getGlobalLogsApi(): unknown {
	return (globalThis as unknown as Record<symbol, unknown>)[GLOBAL_LOGS_API_KEY];
}

/**
 * Start a NodeSDK we own when no real tracer provider is registered yet.
 * Returns `undefined` when the host/preload already installed a provider.
 */
export function startOwnedSdk(resolved: ResolvedOpenTelemetryOptions): OwnedSdk | undefined {
	if (!shouldStartNodeSDK(trace.getTracerProvider())) return undefined;

	const before = snapshotGlobalApi();
	const beforeLogs = getGlobalLogsApi();
	const sdk = new NodeSDK({
		...resolved.sdk,
		contextManager: resolved.contextManager,
		serviceName: resolved.serviceName,
	});
	sdk.start();
	const installed = snapshotGlobalApi();
	const installedLogs = getGlobalLogsApi();
	let shutdown: Promise<void> | undefined;

	return {
		sdk,
		shutdown: () => {
			shutdown ??= sdk.shutdown().finally(() => {
				const current = snapshotGlobalApi();
				if (before.trace === undefined && current.trace === installed.trace) trace.disable();
				if (before.metrics === undefined && current.metrics === installed.metrics) metrics.disable();
				if (before.context === undefined && current.context === installed.context) context.disable();
				if (before.propagation === undefined && current.propagation === installed.propagation) propagation.disable();
				if (beforeLogs === undefined && getGlobalLogsApi() === installedLogs) {
					delete (globalThis as unknown as Record<symbol, unknown>)[GLOBAL_LOGS_API_KEY];
				}
			});
			return shutdown;
		},
	};
}
