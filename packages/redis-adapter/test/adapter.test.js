const { strict } = require("node:assert/strict");
const { test, describe, after, before } = require('node:test');
const { RedisAdapter } = require('../lib/adapter');

describe('RedisAdapter', async () => {
	const bulk = [['key1', { value: 'value1' }], ['key2', { value: 'value2' }]]

	const adapter = new RedisAdapter({
		redisOptions: {
			host: 'localhost',
			port: 6379,
		},
		namespace: 'test',
	});

	before(async () => {
		// Clean the Redis instance before each test
		await adapter.flush();

	});

	await test('constructor', () => {
		strict.strictEqual(adapter.isAsync, true);
		strict.strictEqual(adapter.namespace, 'test');
	});

	await test('get', async () => {
		const result = await adapter.get('testKey');
		strict.deepStrictEqual(result, undefined);
	});

	await test('set', async () => {
		await strict.doesNotReject(async () => {
			await adapter.set('testKey', { value: 'testValue' });
		});
	});

	await test('bulkSet', async () => {
		await strict.doesNotReject(async () => {
			await adapter.bulkSet(bulk);
		});
	});

	await test('bulkGet', async () => {
		const result = await adapter.bulkGet(['key1', 'key2']);
		strict.deepStrictEqual(result, bulk.map(x => x[1]));
	});



	await test('patch', async () => {
		await strict.doesNotReject(async () => {
			await adapter.patch(false, 'testKey', { newValue: 'updatedValue' });
		});
	});

	await test('bulkPatch', async () => {
		await strict.doesNotReject(async () => {
			await adapter.bulkPatch(false, [['key1', { newValue: 'updatedValue1' }], ['key2', { newValue: 'updatedValue2' }]]);
		});
	});

	await test('scan', async () => {
		const result = await adapter.scan('test*');
		strict.strictEqual(result.length, 3);
	});

	after(async () => {
		await adapter.flush();
		await adapter.client.quit();
	});
});
