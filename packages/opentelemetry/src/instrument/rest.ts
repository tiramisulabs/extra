import type { CoreMetrics } from '../metrics';
import type { TraceSource } from '../options';

export interface RestInstrumentDeps {
	checkIfShouldTrace: (source: TraceSource) => boolean;
	getMetrics: () => CoreMetrics | undefined;
}

/**
 * Instrument Discord REST via `api.rest.observe`.
 * Full implementation lands in Task 11; returns a no-op disposer for now.
 */
export function instrumentRest(
	_api:
		| {
				rest?: {
					observe?: (observer: object, opts?: object) => () => void;
				};
		  }
		| undefined,
	_deps: RestInstrumentDeps,
): () => void {
	return () => {};
}
