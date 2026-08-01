import { DataPointType } from '@opentelemetry/sdk-metrics';
import { assert, describe, test } from 'vitest';
import { createCoreMetrics, durationSecondsSince } from '../src/metrics';
import { installTestMeter } from './helpers/otel-test-provider.mts';

const allOff = {
	interactions: false,
	events: false,
	rest: false,
	cache: false,
} as const;

const allOn = {
	interactions: true,
	events: true,
	rest: true,
	cache: true,
} as const;

describe('createCoreMetrics', () => {
	test('record methods do not throw when all instruments are disabled', () => {
		const core = createCoreMetrics(allOff);
		assert.doesNotThrow(() => {
			core.recordInteraction(0.01, {});
			core.recordEvent(0.02, { 'seyfert.event.name': 'ready' });
			core.recordRest(0.03, { 'http.request.method': 'GET' });
			core.recordCache(0.04, { 'seyfert.cache.op': 'get' });
		});
	});

	test('creates histograms when instruments are enabled without throw', () => {
		// Meter provider is optional — NoopMeter accepts createHistogram.
		assert.doesNotThrow(() => {
			const core = createCoreMetrics(allOn);
			core.recordInteraction(0.01, { 'seyfert.interaction.kind': 'command' });
			core.recordEvent(0.02, {});
			core.recordRest(0.03, {});
			core.recordCache(0.04, {});
		});
	});

	test('uses package scope and cache-specific sub-millisecond buckets', async () => {
		const { provider, reader } = installTestMeter();
		try {
			const core = createCoreMetrics(allOn);
			core.recordInteraction(0.01, { 'seyfert.interaction.kind': 'command' });
			core.recordCache(0.000_02, { 'seyfert.cache.op': 'get' });

			const { resourceMetrics } = await reader.collect();
			const scopeMetrics = resourceMetrics.scopeMetrics[0];
			assert.equal(scopeMetrics.scope.name, '@slipher/opentelemetry');
			assert.equal(scopeMetrics.scope.version, '1.0.0');

			const interaction = scopeMetrics.metrics.find(
				metric => metric.descriptor.name === 'seyfert.interaction.duration',
			);
			const cache = scopeMetrics.metrics.find(metric => metric.descriptor.name === 'seyfert.cache.operation.duration');
			assert.equal(interaction?.dataPointType, DataPointType.HISTOGRAM);
			assert.equal(cache?.dataPointType, DataPointType.HISTOGRAM);
			if (interaction?.dataPointType !== DataPointType.HISTOGRAM || cache?.dataPointType !== DataPointType.HISTOGRAM) {
				throw new Error('Expected histogram metric data');
			}
			assert.equal(interaction.dataPoints[0].value.buckets.boundaries[0], 0.005);
			assert.ok(cache.dataPoints[0].value.buckets.boundaries[0] < 0.005);
		} finally {
			await provider.shutdown();
		}
	});
});

describe('durationSecondsSince', () => {
	test('returns a non-negative duration in seconds', () => {
		const start = performance.now();
		const seconds = durationSecondsSince(start);
		assert.ok(seconds >= 0);
		assert.ok(seconds < 1);
	});
});
