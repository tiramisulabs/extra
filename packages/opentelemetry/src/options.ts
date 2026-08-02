import type { ContextManager } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';

export type NodeSDKOptions = NonNullable<ConstructorParameters<typeof NodeSDK>[0]>;

export const DEFAULT_SERVICE_NAME = 'seyfert';

/** High-churn cache resources skipped by default (Seyfert key namespaces). */
export const DEFAULT_CACHE_SKIP_RESOURCES = ['presence', 'voice_state'] as const;

export interface SignalFlags {
	interactions?: boolean;
	events?: boolean;
	rest?: boolean;
	cache?: boolean;
}

export interface ResolvedSignalFlags {
	interactions: boolean;
	events: boolean;
	rest: boolean;
	cache: boolean;
}

export type TraceSource =
	| { kind: 'command' | 'component' | 'modal'; context: unknown }
	| { kind: 'event'; name: string; args: readonly unknown[] }
	| { kind: 'rest'; method: string; path: string }
	| { kind: 'cache'; op: string; resource: string };

export interface OpenTelemetryPluginOptions extends Partial<NodeSDKOptions> {
	serviceName?: string;
	traces?: SignalFlags;
	metrics?: SignalFlags;
	checkIfShouldTrace?: (source: TraceSource) => boolean;
	contextManager?: ContextManager;
	cache?: {
		skipResources?: string[];
	};
}

/** Options for starting OpenTelemetry before application modules are loaded. */
export interface OpenTelemetryBootstrapOptions extends Partial<NodeSDKOptions> {
	serviceName?: string;
	contextManager?: ContextManager;
}

export interface ResolvedOpenTelemetryOptions {
	serviceName: string;
	traces: ResolvedSignalFlags;
	metrics: ResolvedSignalFlags;
	checkIfShouldTrace: (source: TraceSource) => boolean;
	contextManager?: ContextManager;
	cache: { skipResources: ReadonlySet<string> };
	/** Remaining NodeSDK fields (spanProcessors, instrumentations, …) */
	sdk: Partial<NodeSDKOptions>;
}

function resolveSignalFlags(flags: SignalFlags, cacheDefault: boolean): ResolvedSignalFlags {
	return {
		interactions: flags.interactions ?? true,
		events: flags.events ?? true,
		rest: flags.rest ?? true,
		cache: flags.cache ?? cacheDefault,
	};
}

export function resolveTraceFlags(flags: SignalFlags = {}): ResolvedSignalFlags {
	return resolveSignalFlags(flags, false);
}

export function resolveMetricFlags(flags: SignalFlags = {}): ResolvedSignalFlags {
	return resolveSignalFlags(flags, true);
}

export function resolvePluginOptions(options: OpenTelemetryPluginOptions = {}): ResolvedOpenTelemetryOptions {
	const {
		serviceName = DEFAULT_SERVICE_NAME,
		traces,
		metrics,
		checkIfShouldTrace = () => true,
		contextManager,
		cache,
		...sdk
	} = options;

	const skip = cache?.skipResources ?? [...DEFAULT_CACHE_SKIP_RESOURCES];

	return {
		serviceName,
		traces: resolveTraceFlags(traces),
		metrics: resolveMetricFlags(metrics),
		checkIfShouldTrace,
		contextManager,
		cache: { skipResources: new Set(skip) },
		sdk,
	};
}
