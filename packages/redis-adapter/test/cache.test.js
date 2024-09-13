const { describe, test, after, before } = require('node:test');
const { Cache, Client } = require('seyfert');
const { RedisAdapter } = require('../lib/index');
const { setTimeout } = require('node:timers/promises');
const { doesNotThrow } = require('node:assert/strict');

// all intents
const intents = 53608447;

describe('Test Adapter cache', async t => {
	const adapter = new RedisAdapter({
		redisOptions: {},
		namespace: 'test_cache',
	});

	await adapter.start();

	test('discord cache', async () => {
		doesNotThrow(async () => {
			const client = new Client({
				getRC: async () => ({
					locations: {
						base: '',
						output: ''
					},
					intents,
					token: ''
				})
			});
			client.setServices({
				cache: {
					adapter,
				}
			})
			await client.cache.testAdapter();
		});
		await setTimeout(2e3);
	});


	after(async () => {
		await adapter.flush()
		await adapter.client.quit();
	});
});
