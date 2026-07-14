import { describe, expect, it, vi } from 'vitest';
import { createLogicalWorkers, resolveShardTopology } from '../src/workers';

describe('logical workers', () => {
	it('splits an exclusive shard range into stable workers', () => {
		expect(createLogicalWorkers({ totalShards: 7, shardsPerWorker: 2, shardStart: 1, shardEnd: 6 })).toEqual([
			{ workerId: 0, shardStart: 1, shardEnd: 3, totalShards: 7 },
			{ workerId: 1, shardStart: 3, shardEnd: 5, totalShards: 7 },
			{ workerId: 2, shardStart: 5, shardEnd: 6, totalShards: 7 },
		]);
	});

	it('rejects ranges outside the Discord topology', () => {
		expect(() => createLogicalWorkers({ totalShards: 2, shardsPerWorker: 1, shardEnd: 3 })).toThrow(
			/shardEnd cannot exceed/,
		);
	});

	it('resolves topology through gateway.bot.get without WorkerManager', async () => {
		const info = {
			url: 'wss://gateway.discord.gg',
			shards: 4,
			session_start_limit: { total: 1_000, remaining: 999, reset_after: 1, max_concurrency: 2 },
		};
		const getGatewayBot = vi.fn(async () => info as never);
		await expect(resolveShardTopology({ getGatewayBot, shardsPerWorker: 2 })).resolves.toMatchObject({
			totalShards: 4,
			shardStart: 0,
			shardEnd: 4,
			shardsPerWorker: 2,
			workers: 2,
		});
		expect(getGatewayBot).toHaveBeenCalledOnce();
	});
});
