import { assert, describe, test } from 'vitest';
import {
	DEFAULT_CACHE_SKIP_RESOURCES,
	DEFAULT_SERVICE_NAME,
	resolveInstrumentFlags,
	resolvePluginOptions,
} from '../src/options';

describe('resolveInstrumentFlags', () => {
	test('defaults all surfaces on', () => {
		assert.deepEqual(resolveInstrumentFlags(), {
			interactions: true,
			events: true,
			rest: true,
			cache: true,
		});
	});

	test('allows disabling one surface', () => {
		assert.equal(resolveInstrumentFlags({ cache: false }).cache, false);
		assert.equal(resolveInstrumentFlags({ cache: false }).rest, true);
	});
});

describe('resolvePluginOptions', () => {
	test('fills serviceName and skipResources defaults', () => {
		const resolved = resolvePluginOptions({});
		assert.equal(resolved.serviceName, DEFAULT_SERVICE_NAME);
		assert.deepEqual([...resolved.cache.skipResources], [...DEFAULT_CACHE_SKIP_RESOURCES]);
		assert.equal(resolved.checkIfShouldTrace({ kind: 'event', name: 'x', args: [] }), true);
	});

	test('puts remaining NodeSDK fields on sdk and strips plugin-only keys', () => {
		const spanProcessors: never[] = [];
		const resolved = resolvePluginOptions({
			serviceName: 'custom',
			instrument: { rest: false },
			cache: { skipResources: ['members'] },
			checkIfShouldTrace: () => false,
			spanProcessors,
		});
		assert.equal('serviceName' in resolved.sdk, false);
		assert.equal('instrument' in resolved.sdk, false);
		assert.equal('cache' in resolved.sdk, false);
		assert.equal('checkIfShouldTrace' in resolved.sdk, false);
		assert.equal(resolved.sdk.spanProcessors, spanProcessors);
	});
});
