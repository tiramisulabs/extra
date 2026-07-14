import { describe, expect, it } from 'vitest';
import { createSeyfertLaunch } from '../src/master-entry';

const info = {
	url: 'wss://gateway.discord.gg',
	shards: 8,
	session_start_limit: { total: 1_000, remaining: 999, reset_after: 1, max_concurrency: 2 },
};

describe('createSeyfertLaunch', () => {
	it('derives the invariant WorkerData fields from config, topology, and the logical worker', async () => {
		const createLaunch = createSeyfertLaunch({
			config: { token: 'discord-token', intents: 513, debug: true },
			topology: { info, workers: 3 },
			workerPath: '/srv/bot/worker.js',
			compress: true,
			env: { APP_ENV: 'test' },
		});

		const launch = await createLaunch({
			worker: { workerId: 1, shardStart: 2, shardEnd: 5, totalShards: 6 },
			target: { hostId: 'host-a', bootId: 'boot-a' },
			identity: { slot: '1:1', token: 'allocation-token' },
			signal: new AbortController().signal,
		});

		expect(launch).toEqual({
			workerData: {
				token: 'discord-token',
				intents: 513,
				path: '/srv/bot/worker.js',
				shards: [2, 3, 4],
				totalShards: 6,
				totalWorkers: 3,
				workerId: 1,
				mode: 'clusters',
				debug: true,
				workerProxy: false,
				info: { ...info, shards: 6 },
				compress: true,
				resharding: false,
			},
			env: { APP_ENV: 'test' },
		});
	});
});
