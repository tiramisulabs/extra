import type { CoreMetrics } from '../metrics';
import type { TraceSource } from '../options';

/**
 * What every setup-time instrumentor may wrap. Each one narrows the members it
 * actually reads, so the plugin can hand the same target to all of them.
 */
export interface InstrumentTarget {
	client: unknown;
	api: unknown;
}

export interface InstrumentDeps {
	traceEnabled: boolean;
	checkIfShouldTrace: (source: TraceSource) => boolean;
	getMetrics: () => CoreMetrics | undefined;
}
