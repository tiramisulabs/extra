import { describe, test } from 'vitest';
import { ExpirableRedisAdapter } from '../lib/index';

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
	describe.skip('Test Expirable Adapter cache', () => {
		test('requires REDIS_URL to run integration tests', () => {});
	});
} else {
	describe('Test Expirable Adapter cache', async _ => {
		const adapter = new ExpirableRedisAdapter(
			{
				redisOptions: { url: redisUrl },
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
