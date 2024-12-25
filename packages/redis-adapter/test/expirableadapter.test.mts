// @ts-check
import { assert, afterAll, beforeAll, describe, test } from 'vitest';
import { ExpirableRedisAdapter } from '../lib/index';

describe('ExpirableRedisAdapter', async () => {
	const bulk = [
		['key1', { value: 'value1' }],
		['key2', { value: 'value2' }],
	];

	const adapter = new ExpirableRedisAdapter(
		{
			redisOptions: {},
			namespace: 'ex_custom_namespace',
		},
		{
			default: {
				expire: 2e3,
			},
		},
	);

	await adapter.start();

	beforeAll(async () => {
		await adapter.flush();
		// Clean the Redis instance before each test
	});

	await test('constructor', () => {
		assert.equal(adapter.isAsync, true);
		assert.equal(adapter.namespace, 'ex_custom_namespace');
	});

	await test('get', async () => {
		const result = await adapter.get('test_key');
		assert.deepEqual(result, undefined);
	});

	await test('set', async () => {
		await assert.doesNotThrow(async () => {
			await adapter.set('test_key', { value: 'testValue' });
		});
	});

	await test('bulkSet', async () => {
		await assert.doesNotThrow(async () => {
			//@ts-expect-error
			await adapter.bulkSet(bulk);
		});
	});

	await test('bulkGet', async () => {
		const result = await adapter.bulkGet(['key1', 'key2']);
		assert.deepEqual(
			result,
			// @ts-expect-error
			bulk.map(x => x[1]),
		);
	});

	await test('patch', async () => {
		await assert.doesNotThrow(async () => {
			await adapter.patch('test_key', { newValue: 'updatedValue' });
		});
	});

	await test('bulkPatch', async () => {
		await assert.doesNotThrow(async () => {
			await adapter.bulkPatch([
				['key1', { newValue: 'updatedValue1' }],
				['key2', { newValue: 'updatedValue2' }],
			]);
		});
	});

	await test('scan', async () => {
		const result = await adapter.scan('*');
		assert.equal(result.length, 3);
	});

	afterAll(async () => {
		await adapter.flush();
		await adapter.client.quit();
	});
});
