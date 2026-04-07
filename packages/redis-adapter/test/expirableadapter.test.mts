// @ts-check
import { afterAll, assert, beforeAll, describe, test } from 'vitest';
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

	const createAdapter = async (
		namespace: string,
		options: ConstructorParameters<typeof ExpirableRedisAdapter>[1] = {},
	) => {
		const instance = new ExpirableRedisAdapter(
			{
				redisOptions: {},
				namespace,
			},
			options,
		);

		await instance.start();
		await instance.flush();
		return instance;
	};

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

	await test('uses ondemand cache per resource', async () => {
		const localAdapter = await createAdapter('ondemand_namespace', {
			default: {
				ondemand: false,
				native: false,
			},
			user: {
				ondemand: true,
			},
			guild: {
				native: true,
			},
		});

		try {
			await localAdapter.set('user.1', { value: 'cached-user' });
			await localAdapter.set('guild.1', { value: 'plain-guild' });

			await localAdapter.client.del([
				'ondemand_namespace:user.1',
				'ondemand_namespace:guild.1',
			]);

			assert.deepEqual(await localAdapter.get('user.1'), { value: 'cached-user' });
			assert.deepEqual(await localAdapter.get('guild.1'), undefined);
		} finally {
			await localAdapter.flush();
			await localAdapter.client.quit();
		}
	});

	await test('evicts ondemand cache entries with per-resource limit', async () => {
		const localAdapter = await createAdapter('limited_ondemand_namespace', {
			user: {
				ondemand: true,
				limit: 2,
			},
		});

		try {
			await localAdapter.set('user.1', { value: 'one' });
			await localAdapter.set('user.2', { value: 'two' });
			await localAdapter.get('user.1');
			await localAdapter.set('user.3', { value: 'three' });

			await localAdapter.client.del([
				'limited_ondemand_namespace:user.1',
				'limited_ondemand_namespace:user.2',
				'limited_ondemand_namespace:user.3',
			]);

			assert.deepEqual(await localAdapter.get('user.1'), { value: 'one' });
			assert.deepEqual(await localAdapter.get('user.2'), undefined);
			assert.deepEqual(await localAdapter.get('user.3'), { value: 'three' });
		} finally {
			await localAdapter.flush();
			await localAdapter.client.quit();
		}
	});

	afterAll(async () => {
		await adapter.flush();
		await adapter.client.quit();
	});
});
