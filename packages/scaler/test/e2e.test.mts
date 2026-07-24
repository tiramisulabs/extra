import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScalerAgent } from '../src/agent';
import { ScalerMaster } from '../src/master';
import { ProcessWorkerRunner } from '../src/runner';
import { SeyfertScaler } from '../src/scaler';
import type { LogicalWorker } from '../src/types';
// @ts-expect-error The fake gateway is an intentionally uncompiled runtime fixture.
import { startFakeGateway } from './fixtures/fake-gateway.mjs';

interface GatewayEvent {
	connectionId: number;
	at: number;
}

interface IdentifyEvent extends GatewayEvent {
	shardId: number;
	totalShards: number;
}

interface FakeGateway {
	url: string;
	identifies: IdentifyEvent[];
	closes: GatewayEvent[];
	activeConnectionCount(): number;
	close(): Promise<void>;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('scaler e2e', () => {
	it('launches real Seyfert shards through the identify gate and performs a same-host handoff cleanly', async () => {
		const gateway = (await startFakeGateway()) as FakeGateway;
		let master: ScalerMaster | undefined;
		let agent: ScalerAgent | undefined;
		let scaler: SeyfertScaler | undefined;
		try {
			const authToken = 'e2e-scaler-token';
			master = new ScalerMaster({
				authToken,
				host: '127.0.0.1',
				port: 0,
				liveness: { pingIntervalMs: 1_000, hostTimeoutMs: 10_000, requestTimeoutMs: 30_000 },
			});
			const address = await master.listen();
			if (!address || typeof address === 'string') throw new Error('Scaler master did not bind a TCP port');

			const workerPath = fileURLToPath(new URL('./fixtures/e2e-worker.mjs', import.meta.url));
			const runner = new ProcessWorkerRunner({ modulePath: workerPath, stdio: 'pipe' });
			agent = new ScalerAgent({
				hostId: 'e2e-host',
				bootId: 'e2e-boot',
				host: '127.0.0.1',
				port: address.port,
				authToken,
				capacity: { maxWorkers: 1 },
				runner,
				connection: { heartbeatIntervalMs: 1_000 },
			});
			const worker: LogicalWorker = { workerId: 0, shardStart: 0, shardEnd: 2, totalShards: 2 };
			scaler = new SeyfertScaler({
				master,
				workers: [worker],
				startupTimeoutMs: 5_000,
				readinessTimeoutMs: 30_000,
				createLaunch() {
					return {
						workerData: {
							intents: 0,
							token: 'e2e-token',
							path: workerPath,
							shards: [0, 1],
							totalShards: 2,
							totalWorkers: 1,
							mode: 'clusters',
							workerId: 0,
							debug: false,
							workerProxy: false,
							info: {
								url: gateway.url,
								shards: 2,
								session_start_limit: {
									total: 1_000,
									remaining: 1_000,
									reset_after: 1,
									max_concurrency: 1,
								},
							},
							compress: false,
							resharding: false,
						},
					};
				},
			});

			const errors: Error[] = [];
			master.on('error', error => errors.push(error));
			agent.on('error', error => errors.push(error));
			scaler.on('error', error => errors.push(error));

			await agent.start();
			const launchStartedAt = performance.now();
			const assignments = await scaler.start();
			expect(assignments.get(0)?.state).toBe('routed');
			expect(performance.now() - launchStartedAt).toBeGreaterThanOrEqual(5_500);
			expect(gateway.identifies).toHaveLength(2);
			expect(gateway.identifies.map(event => [event.shardId, event.totalShards])).toEqual([
				[0, 2],
				[1, 2],
			]);
			// Grants are 5.5s apart. Each shard opens its socket after the grant, so
			// gateway receipt can differ by a few milliseconds of handshake latency.
			const identifySpacingMs = gateway.identifies[1]!.at - gateway.identifies[0]!.at;
			expect(identifySpacingMs).toBeGreaterThanOrEqual(5_450);

			const firstAllocationConnections = new Set(gateway.identifies.map(event => event.connectionId));
			await scaler.handoff(0, { hostId: 'e2e-host', bootId: 'e2e-boot' });
			expect(gateway.identifies).toHaveLength(4);
			const firstAllocationCloses = gateway.closes.filter(event => firstAllocationConnections.has(event.connectionId));
			expect(firstAllocationCloses).toHaveLength(2);
			const lastOldConnectionClose = Math.max(...firstAllocationCloses.map(event => event.at));
			expect(gateway.identifies[2]!.at).toBeGreaterThanOrEqual(lastOldConnectionClose);

			await scaler.stop();
			await vi.waitFor(() => expect(gateway.activeConnectionCount()).toBe(0));
			expect(agent.workers).toEqual([]);
			await agent.stop();
			expect(agent.state).toBe('stopped');
			expect(errors).toEqual([]);
		} finally {
			await scaler?.stop().catch(() => undefined);
			await agent?.stop().catch(() => undefined);
			await master?.close().catch(() => undefined);
			await gateway.close();
		}
	}, 45_000);
});
