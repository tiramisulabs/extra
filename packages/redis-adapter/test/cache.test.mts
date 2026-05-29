import { describe, test } from 'vitest';
import { RedisAdapter } from '../lib/index';

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
	describe.skip('Test Adapter cache', () => {
		test('requires REDIS_URL to run integration tests', () => {});
	});
} else {
	describe('Test Adapter cache', async _ => {
		const adapter = new RedisAdapter({
			redisOptions: { url: redisUrl },
			namespace: 'test_cache',
		});

		await adapter.start();

		test('discord cache', async () => {
			// const client = new Client({
			// 	getRC: async () => ({
			// 		locations: {
			// 			base: '',
			// 			output: '',
			// 		},
			// 		intents,
			// 		token: '',
			// 	}),
			// });
			// client.setServices({
			// 	cache: {
			// 		adapter,
			// 	},
			// });
			// await client.cache.testAdapter();
			await adapter.client.quit();
		});
	});
}
