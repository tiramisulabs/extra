const { describe, test, after, before } = require('node:test');
const { Cache, Client } = require('seyfert');
const { RedisAdapter } = require('../lib/index');
const { doesNotReject } = require('node:assert/strict');
const { setTimeout } = require('node:timers/promises');
const { doesNotThrow } = require('node:assert/strict');

// all intents
const intents = 53608447;

describe('Test Adapter cache', async t => {
	const adapter = new RedisAdapter({
		redisOptions: {
			host: 'localhost',
			port: 6379,
		},
		namespace: 'test_cache',
	});

	test('discord cache', async () => {
		doesNotThrow(async () => {
			const client = new Client({ getRC: () => ({ intents }) });
			client.setServices({
				cache: {
					adapter,
				}
			})
			await client.cache.testAdapter();
		});
		await setTimeout(5000);
	});

	after(async () => {
		await adapter.flush()
		await adapter.client.quit();
	});
});
