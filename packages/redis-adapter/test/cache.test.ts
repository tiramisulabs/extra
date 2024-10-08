// @ts-check
import { Client } from 'seyfert';
import { describe, test } from 'vitest';
import { RedisAdapter } from '../lib/index';

// all intents
const intents = 53608447;

describe('Test Adapter cache', async _ => {
	const adapter = new RedisAdapter({
		redisOptions: {},
		namespace: 'test_cache',
	});

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
