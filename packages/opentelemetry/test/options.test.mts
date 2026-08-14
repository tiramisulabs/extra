import { assert, describe, test } from 'vitest';
import {
	DEFAULT_CACHE_SKIP_RESOURCES,
	DEFAULT_SERVICE_NAME,
	resolveMetricFlags,
	resolvePluginOptions,
	resolveTraceFlags,
} from '../src/options';

describe('signal flags', () => {
	test('traces default cache spans off', () => {
		assert.deepEqual(resolveTraceFlags(), {
			interactions: true,
			events: true,
			rest: true,
			cache: false,
		});
	});

	test('metrics default all surfaces on', () => {
		assert.deepEqual(resolveMetricFlags(), {
			interactions: true,
			events: true,
			rest: true,
			cache: true,
			gateway: true,
		});
	});

	test('allows overriding one surface independently', () => {
		assert.equal(resolveTraceFlags({ cache: true }).cache, true);
		assert.equal(resolveMetricFlags({ rest: false }).rest, false);
	});
});

describe('resolvePluginOptions', () => {
	test('fills serviceName and skipResources defaults', () => {
		const resolved = resolvePluginOptions({});
		assert.equal(resolved.serviceName, DEFAULT_SERVICE_NAME);
		assert.equal(resolved.traces.cache, false);
		assert.equal(resolved.metrics.cache, true);
		assert.deepEqual([...resolved.cache.skipResources], [...DEFAULT_CACHE_SKIP_RESOURCES]);
		assert.equal(resolved.checkIfShouldTrace({ kind: 'event', name: 'x', args: [] }), true);
	});

	test('puts remaining NodeSDK fields on sdk and strips plugin-only keys', () => {
		const spanProcessors: never[] = [];
		const resolved = resolvePluginOptions({
			serviceName: 'custom',
			traces: { rest: false },
			metrics: { cache: false },
			cache: { skipResources: ['members'] },
			checkIfShouldTrace: () => false,
			spanProcessors,
		});
		assert.equal('serviceName' in resolved.sdk, false);
		assert.equal('traces' in resolved.sdk, false);
		assert.equal('metrics' in resolved.sdk, false);
		assert.equal('cache' in resolved.sdk, false);
		assert.equal('checkIfShouldTrace' in resolved.sdk, false);
		assert.equal(resolved.sdk.spanProcessors, spanProcessors);
	});
});
