import type { ContextManager } from '@opentelemetry/api';
import type { NodeSDKConfiguration } from '@opentelemetry/sdk-node';

export interface InstrumentFlags {
	interactions?: boolean;
	events?: boolean;
	rest?: boolean;
	cache?: boolean;
}

export type TraceSource =
	| { kind: 'command' | 'component' | 'modal'; context: unknown }
	| { kind: 'event'; name: string; args: readonly unknown[] }
	| { kind: 'rest'; method: string; path: string }
	| { kind: 'cache'; op: string; resource: string };

export interface OpenTelemetryPluginOptions extends Partial<NodeSDKConfiguration> {
	serviceName?: string;
	instrument?: InstrumentFlags;
	checkIfShouldTrace?: (source: TraceSource) => boolean;
	contextManager?: ContextManager;
	cache?: {
		skipResources?: string[];
	};
}
