import {
	context,
	type ContextManager,
	type TracerProvider,
	ProxyTracerProvider,
	trace,
} from '@opentelemetry/api';
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
		serviceName: resolved.serviceName,
	});
	sdk.start();

	if (resolved.contextManager) {
		trySetContextManager(resolved.contextManager);
	}

	return {
		sdk,
		shutdown: () => sdk.shutdown(),
	};
}

/**
 * Enable + register a context manager only when none is active.
 * Swallows double-enable / duplicate-registration errors (Elysia spirit).
 */
function trySetContextManager(contextManager: ContextManager): void {
	try {
		// Private API: returns NoopContextManager when no global manager is set.
		// @ts-expect-error private method — same pattern as Elysia
		const current = context._getContextManager?.() as { constructor?: { name?: string } } | undefined;
		const noneSet =
			current === undefined || current.constructor?.name === 'NoopContextManager';
		if (!noneSet) return;

		contextManager.enable();
		context.setGlobalContextManager(contextManager);
	} catch {
		// ignore double-enable
	}
}
