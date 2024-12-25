import { assert, afterAll, beforeAll, describe, test } from 'vitest';
import { RedisAdapter } from '../lib/index';

describe('RedisAdapter', async () => {
	const bulk = [
		['key1', { value: 'value1' }],
		['key2', { value: 'value2' }],
	];

	const adapter = new RedisAdapter({
		redisOptions: {},
		namespace: 'custom_namespace',
	});

	await adapter.start();

	beforeAll(async () => {
		await adapter.flush();
		// Clean the Redis instance
	});

	test('constructor', () => {
		assert.equal(adapter.isAsync, true);
		assert.equal(adapter.namespace, 'custom_namespace');
	});

	test('get', async () => {
		const result = await adapter.get('test_key');
		assert.deepEqual(result, undefined);
	});

	test('set', async () => {
		assert.doesNotThrow(async () => {
			await adapter.set('test_key', { value: 'testValue' });
		});
	});

	test('bulkSet', async () => {
		assert.doesNotThrow(async () => {
			//@ts-expect-error
			await adapter.bulkSet(bulk);
		});
	});

	test('bulkGet', async () => {
		const result = await adapter.bulkGet(['key1', 'key2']);
		assert.deepEqual(
			result,
			// @ts-expect-error
			bulk.map(x => x[1]),
		);
	});

	test('patch', async () => {
		assert.doesNotThrow(async () => {
			await adapter.patch('test_key', { newValue: 'updatedValue' });
		});
	});

	test('bulkPatch', async () => {
		assert.doesNotThrow(async () => {
			await adapter.bulkPatch([
				['key1', { newValue: 'updatedValue1' }],
				['key2', { newValue: 'updatedValue2' }],
			]);
		});
	});

	test('scan', async () => {
		const result = await adapter.scan('*');
		assert.equal(result.length, 3);
	});

	afterAll(async () => {
		await adapter.flush();
		await adapter.client.quit();
	});
});
