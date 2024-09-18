const { describe, test } = require('node:test');
const { Client } = require('seyfert');
const { ExpirableRedisAdapter } = require('../lib/index');

// all intents
const intents = 53608447;

describe('Test Adapter cache', async t => {
	const adapter = new ExpirableRedisAdapter(
		{
			redisOptions: {},
			namespace: 'ex_test_cache',
		},
		{
			default: {
				expire: 2e3,
			},
		},
	);

	await adapter.start();

	test('discord cache', async () => {
		const client = new Client({
			getRC: async () => ({
				locations: {
					base: '',
					output: '',
				},
				intents,
				token: '',
			}),
		});
		client.setServices({
			cache: {
				adapter,
			},
		});
		await client.cache.testAdapter();
		await adapter.client.quit();
	});
});
