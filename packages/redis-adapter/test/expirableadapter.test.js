const { strict } = require('node:assert/strict');
const { test, describe, after, before } = require('node:test');
const { ExpirableRedisAdapter } = require('../lib/index');

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

	before(async () => {
		await adapter.flush();
		// Clean the Redis instance before each test
	});

	await test('constructor', () => {
		strict.strictEqual(adapter.isAsync, true);
		strict.strictEqual(adapter.namespace, 'ex_custom_namespace');
	});

	await test('get', async () => {
		const result = await adapter.get('test_key');
		strict.deepStrictEqual(result, undefined);
	});

	await test('set', async () => {
		await strict.doesNotReject(async () => {
			await adapter.set('test_key', { value: 'testValue' });
		});
	});

	await test('bulkSet', async () => {
		await strict.doesNotReject(async () => {
			//@ts-expect-error
			await adapter.bulkSet(bulk);
		});
	});

	await test('bulkGet', async () => {
		const result = await adapter.bulkGet(['key1', 'key2']);
		strict.deepStrictEqual(
			result,
			bulk.map(x => x[1]),
		);
	});

	await test('patch', async () => {
		await strict.doesNotReject(async () => {
			await adapter.patch(false, 'test_key', { newValue: 'updatedValue' });
		});
	});

	await test('bulkPatch', async () => {
		await strict.doesNotReject(async () => {
			await adapter.bulkPatch(false, [
				['key1', { newValue: 'updatedValue1' }],
				['key2', { newValue: 'updatedValue2' }],
			]);
		});
	});

	await test('scan', async () => {
		const result = await adapter.scan('*');
		strict.strictEqual(result.length, 3);
	});

	after(async () => {
		await adapter.flush();
		await adapter.client.quit();
	});
});
