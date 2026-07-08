import type { CoreMetrics } from '../metrics';
import type { TraceSource } from '../options';

export interface EventsInstrumentDeps {
	checkIfShouldTrace: (source: TraceSource) => boolean;
	getMetrics: () => CoreMetrics | undefined;
}

/**
 * Wrap gateway event dispatch under root spans.
 * Full implementation lands in Task 10; returns a no-op disposer for now.
 */
export function instrumentEvents(
	_client: unknown,
	_deps: EventsInstrumentDeps,
): () => void {
	return () => {};
}
