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
});
