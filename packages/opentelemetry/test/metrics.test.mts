import { assert, describe, test } from 'vitest';
import { createCoreMetrics, durationSecondsSince } from '../src/metrics';

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
		const core = createCoreMetrics('test', allOff);
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
			const core = createCoreMetrics('test', allOn);
			core.recordInteraction(0.01, { 'seyfert.interaction.kind': 'command' });
			core.recordEvent(0.02, {});
			core.recordRest(0.03, {});
			core.recordCache(0.04, {});
		});
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
