import type { CoreMetrics } from '../metrics';
import type { TraceSource } from '../options';

export interface CacheInstrumentDeps {
	checkIfShouldTrace: (source: TraceSource) => boolean;
	skipResources: ReadonlySet<string>;
	getMetrics: () => CoreMetrics | undefined;
}

/**
 * Wrap cache adapter operations under spans.
 * Full implementation lands in Task 12; returns a no-op disposer for now.
 */
export function instrumentCache(
	_client: unknown,
	_deps: CacheInstrumentDeps,
): () => void {
	return () => {};
}
