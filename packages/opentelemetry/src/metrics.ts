import type { Attributes, Histogram } from '@opentelemetry/api';
import type { ResolvedSignalFlags } from './options';
import { getMeter } from './trace-api';

const DURATION_BOUNDARIES = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10, 30, 60];
const CACHE_DURATION_BOUNDARIES = [
	0.000_01, 0.000_025, 0.000_05, 0.000_1, 0.000_25, 0.000_5, 0.001, 0.002_5, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5,
	1,
];

const histogramOptions = {
	unit: 's',
	advice: { explicitBucketBoundaries: DURATION_BOUNDARIES },
} as const;

const cacheHistogramOptions = {
	unit: 's',
	advice: { explicitBucketBoundaries: CACHE_DURATION_BOUNDARIES },
} as const;

export interface CoreMetrics {
	recordInteraction(durationSeconds: number, attributes: Attributes): void;
	recordEvent(durationSeconds: number, attributes: Attributes): void;
	recordRest(durationSeconds: number, attributes: Attributes): void;
	recordCache(durationSeconds: number, attributes: Attributes): void;
}

export function createCoreMetrics(signals: ResolvedSignalFlags): CoreMetrics {
	const meter = getMeter();

	const interaction = signals.interactions
		? meter.createHistogram('seyfert.interaction.duration', {
				...histogramOptions,
				description: 'Duration of Seyfert interaction handlers',
			})
		: undefined;

	const event = signals.events
		? meter.createHistogram('seyfert.event.duration', {
				...histogramOptions,
				description: 'Duration of Seyfert gateway event handlers',
			})
		: undefined;

	const rest = signals.rest
		? meter.createHistogram('seyfert.rest.duration', {
				...histogramOptions,
				description: 'Duration of Discord REST calls',
			})
		: undefined;

	const cache = signals.cache
		? meter.createHistogram('seyfert.cache.operation.duration', {
				...cacheHistogramOptions,
				description: 'Duration of Seyfert cache operations',
			})
		: undefined;

	const record = (histogram: Histogram | undefined, value: number, attributes: Attributes) => {
		histogram?.record(value, attributes);
	};

	return {
		recordInteraction: (v, a) => record(interaction, v, a),
		recordEvent: (v, a) => record(event, v, a),
		recordRest: (v, a) => record(rest, v, a),
		recordCache: (v, a) => record(cache, v, a),
	};
}

export function durationSecondsSince(startMs: number): number {
	return (performance.now() - startMs) / 1000;
}
