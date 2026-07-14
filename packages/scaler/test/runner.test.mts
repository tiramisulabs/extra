import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProcessWorkerRunner } from '../src/runner';

const originalScalerToken = process.env.SCALER_TOKEN;

afterEach(() => {
	if (originalScalerToken === undefined) delete process.env.SCALER_TOKEN;
	else process.env.SCALER_TOKEN = originalScalerToken;
});

describe('ProcessWorkerRunner', () => {
	it('defaults to a one-second post-shard-close grace', () => {
		expect(new ProcessWorkerRunner()).toHaveProperty('terminationGraceMs', 1_000);
	});

	it('forks with only Seyfert classic worker environment and stops after shard closure', async () => {
		process.env.SCALER_TOKEN = 'must-not-reach-worker';
		const messages: unknown[] = [];
		const exits: [number | null, NodeJS.Signals | null][] = [];
		const runner = new ProcessWorkerRunner({
			modulePath: fileURLToPath(new URL('./fixtures/runner-child.mjs', import.meta.url)),
			stdio: 'ignore',
			terminationGraceMs: 0,
			disconnectTimeoutMs: 500,
			killGraceMs: 500,
		});
		const running = await runner.spawn(
			{
				workerId: 0,
				identity: { slot: 'slot', token: 'token' },
				topology: { shardStart: 0, shardEnd: 1, totalShards: 1 },
				launch: {
					workerData: {
						intents: 1,
						token: 'discord-token',
						path: '/ignored.js',
						shards: [0],
						totalShards: 1,
						totalWorkers: 1,
						mode: 'clusters',
						workerId: 0,
						debug: false,
						workerProxy: false,
						info: {
							url: 'wss://gateway.discord.gg',
							shards: 1,
							session_start_limit: { total: 1, remaining: 1, reset_after: 1, max_concurrency: 1 },
						},
						compress: false,
						resharding: false,
					},
				},
			},
			{
				onMessage: message => messages.push(message),
				onError: error => {
					throw error;
				},
				onExit: (code, signal) => exits.push([code, signal]),
			},
		);
		await vi.waitFor(() => expect(messages).toHaveLength(1));
		expect(messages[0]).toEqual({
			type: 'ENV',
			workerId: 0,
			mode: 'clusters',
			shards: [0],
			totalShards: 1,
			controlPlaneTokenPresent: false,
		});
		await running.stop(true);
		expect(running.exited).toBe(true);
		expect(exits).toEqual([[0, null]]);
	});
});
