import { afterAll, assert, beforeAll, describe, test } from 'vitest';
import { RedisAdapter } from '../src';

const namespace = `slipher_adapter_${process.pid}`;
const adapter = new RedisAdapter({
	redisOptions: { url: process.env.SLIPHER_REDIS_URL ?? 'redis://127.0.0.1:6379' },
	namespace,
});

describe('RedisAdapter', () => {
	beforeAll(async () => {
		await adapter.start();
		await adapter.flush();
	});

	afterAll(async () => {
		await adapter.flush();
		adapter.client.close();
	});

	test('supports the base adapter operations', async () => {
		assert.equal(adapter.isAsync, true);
		assert.equal(adapter.namespace, namespace);
		assert.equal(await adapter.get('missing'), undefined);

		await adapter.set('test_key', { value: 'testValue' });
		await adapter.bulkSet([
			['key1', { value: 'value1' }],
			['key2', { value: 'value2' }],
		]);
		await adapter.patch('test_key', { newValue: 'updatedValue' });
		await adapter.bulkPatch([
			['key1', { newValue: 'updatedValue1' }],
			['key2', { newValue: 'updatedValue2' }],
		]);

		assert.deepEqual(await adapter.get('test_key'), {
			newValue: 'updatedValue',
			value: 'testValue',
		});
		assert.deepEqual(await adapter.bulkGet(['key1', 'key2']), [
			{ newValue: 'updatedValue1', value: 'value1' },
			{ newValue: 'updatedValue2', value: 'value2' },
		]);
		assert.equal((await adapter.scan('*')).length, 3);
	});
});
