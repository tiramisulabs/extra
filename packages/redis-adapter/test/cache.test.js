const { describe, test } = require('node:test');
const { Client } = require('seyfert');
const { RedisAdapter } = require('../lib/index');
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

			await adapter.client.quit();
		});
	});
});
