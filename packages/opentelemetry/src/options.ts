import type { ContextManager } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';

type NodeSDKOptions = NonNullable<ConstructorParameters<typeof NodeSDK>[0]>;

export const DEFAULT_SERVICE_NAME = 'seyfert';

/** High-churn cache resources skipped by default (Seyfert key namespaces). */
export const DEFAULT_CACHE_SKIP_RESOURCES = ['presence', 'voice_state'] as const;

export interface InstrumentFlags {
	interactions?: boolean;
	events?: boolean;
	rest?: boolean;
	cache?: boolean;
}

export interface ResolvedInstrumentFlags {
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
	instrument?: InstrumentFlags;
	checkIfShouldTrace?: (source: TraceSource) => boolean;
	contextManager?: ContextManager;
	cache?: {
		skipResources?: string[];
	};
}

export interface ResolvedOpenTelemetryOptions {
	serviceName: string;
	instrument: ResolvedInstrumentFlags;
	checkIfShouldTrace: (source: TraceSource) => boolean;
	contextManager?: ContextManager;
	cache: { skipResources: ReadonlySet<string> };
	/** Remaining NodeSDK fields (spanProcessors, instrumentations, …) */
	sdk: Partial<NodeSDKOptions>;
}

export function resolveInstrumentFlags(flags: InstrumentFlags = {}): ResolvedInstrumentFlags {
	return {
		interactions: flags.interactions ?? true,
		events: flags.events ?? true,
		rest: flags.rest ?? true,
		cache: flags.cache ?? true,
	};
}

export function resolvePluginOptions(options: OpenTelemetryPluginOptions = {}): ResolvedOpenTelemetryOptions {
	const {
		serviceName = DEFAULT_SERVICE_NAME,
		instrument,
		checkIfShouldTrace = () => true,
		contextManager,
		cache,
		...sdk
	} = options;

	const skip = cache?.skipResources ?? [...DEFAULT_CACHE_SKIP_RESOURCES];

	return {
		serviceName,
		instrument: resolveInstrumentFlags(instrument),
		checkIfShouldTrace,
		contextManager,
		cache: { skipResources: new Set(skip) },
		sdk,
	};
}
