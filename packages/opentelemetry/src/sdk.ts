import { ProxyTracerProvider, type TracerProvider, trace } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import type { ResolvedOpenTelemetryOptions } from './options';

/**
 * Whether this process still has only the API proxy provider (no real SDK).
 * Mirrors Elysia's `shouldStartNodeSDK` guard.
 */
export function shouldStartNodeSDK(provider: TracerProvider): boolean {
	if (!(provider instanceof ProxyTracerProvider)) return false;
	return provider.getDelegateTracer('check') === undefined;
}

export interface OwnedSdk {
	sdk: NodeSDK;
	shutdown(): Promise<void>;
}

/**
 * Start a NodeSDK we own when no real tracer provider is registered yet.
 * Returns `undefined` when the host/preload already installed a provider.
 */
export function startOwnedSdk(resolved: ResolvedOpenTelemetryOptions): OwnedSdk | undefined {
	if (!shouldStartNodeSDK(trace.getTracerProvider())) return undefined;

	const sdk = new NodeSDK({
		...resolved.sdk,
		contextManager: resolved.contextManager,
		serviceName: resolved.serviceName,
	});
	sdk.start();

	return {
		sdk,
		shutdown: () => sdk.shutdown(),
	};
}
