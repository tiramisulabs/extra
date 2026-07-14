import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScalerAgent } from '../src/agent';
import { ScalerMaster } from '../src/master';
import { type IdentifyGrantMessage, type IdentifyRequestMessage, SCALER_PROTOCOL_VERSION } from '../src/protocol';
import type { RunningWorker, WorkerLaunchRequest, WorkerRunner, WorkerRunnerHooks } from '../src/runner';
import { connectWebSocket, type ProtocolConnection } from '../src/transport';
import type { AllocationIdentity, ObservedWorker, RemoteWorkerLaunch, ShardTopology } from '../src/types';

class FakeRunningWorker implements RunningWorker {
	readonly messages: unknown[] = [];
	exited = false;
	stopCalls = 0;

	constructor(
		readonly hooks: WorkerRunnerHooks,
		private readonly beforeStop?: () => Promise<void>,
	) {}

	async postMessage(message: unknown) {
		this.messages.push(message);
	}

	async stop() {
		this.stopCalls++;
		await this.beforeStop?.();
		this.exit(0, null);
	}

	message(message: unknown) {
		this.hooks.onMessage(message);
	}

	exit(code: number | null, signal: NodeJS.Signals | null) {
		if (this.exited) return;
		this.exited = true;
		this.hooks.onExit(code, signal);
	}
}

class FakeRunner implements WorkerRunner {
	readonly workers: FakeRunningWorker[] = [];
	readonly requests: WorkerLaunchRequest[] = [];

	async spawn(request: WorkerLaunchRequest, hooks: WorkerRunnerHooks): Promise<RunningWorker> {
		this.requests.push(request);
		const worker = new FakeRunningWorker(hooks);
		this.workers.push(worker);
		return worker;
	}
}

class SlowFakeRunner extends FakeRunner {
	override async spawn(request: WorkerLaunchRequest, hooks: WorkerRunnerHooks, signal?: AbortSignal) {
		this.requests.push(request);
		const worker = new FakeRunningWorker(hooks);
		this.workers.push(worker);
		return await new Promise<RunningWorker>((_resolve, reject) => {
			const abort = () => {
				void worker.stop().then(() => reject(signal?.reason ?? new Error('Worker spawn aborted')), reject);
			};
			if (signal?.aborted) abort();
			else signal?.addEventListener('abort', abort, { once: true });
		});
	}
}

class BlockingStopRunner extends FakeRunner {
	readonly stopStarted: Promise<void>;
	private readonly stopBarrier: Promise<void>;
	private markStopStarted!: () => void;
	private releaseStop!: () => void;

	constructor() {
		super();
		this.stopStarted = new Promise(resolve => (this.markStopStarted = resolve));
		this.stopBarrier = new Promise(resolve => (this.releaseStop = resolve));
	}

	override async spawn(request: WorkerLaunchRequest, hooks: WorkerRunnerHooks): Promise<RunningWorker> {
		this.requests.push(request);
		const worker = new FakeRunningWorker(hooks, async () => {
			this.markStopStarted();
			await this.stopBarrier;
		});
		this.workers.push(worker);
		return worker;
	}

	finishStop() {
		this.releaseStop();
	}
}

const topology: ShardTopology = { shardStart: 0, shardEnd: 1, totalShards: 1 };
const identity: AllocationIdentity = { slot: '0:1', token: 'token-1' };

function launch(identityOverride = identity): RemoteWorkerLaunch {
	return {
		workerData: {
			intents: 1,
			token: 'discord-token',
			path: '/worker.js',
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
				session_start_limit: { total: 1_000, remaining: 999, reset_after: 1, max_concurrency: 1 },
			},
			compress: false,
			resharding: false,
		},
		env: { ALLOCATION_TOKEN: identityOverride.token },
	};
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
	vi.useRealTimers();
	vi.restoreAllMocks();
});

async function setup(authToken = 'secret', runner: FakeRunner = new FakeRunner(), respawnDelayMs = 0) {
	const master = new ScalerMaster({ authToken: 'secret', port: 0 });
	const address = (await master.listen()) as AddressInfo;
	const agent = new ScalerAgent({
		hostId: 'host-a',
		host: '127.0.0.1',
		port: address.port,
		authToken,
		capacity: { maxWorkers: 2 },
		runner,
		connection: {
			reconnect: { initialDelayMs: 60_000, maxDelayMs: 60_000, jitter: 0 },
			respawn: { initialDelayMs: respawnDelayMs, maxDelayMs: respawnDelayMs, jitter: 0 },
			heartbeatIntervalMs: 60_000,
		},
	});
	cleanups.push(
		() => master.close(),
		() => agent.stop(),
	);
	return { master, agent, runner };
}

describe('agent and master integration', () => {
	it('runs the vanilla WorkerClient manager protocol', async () => {
		const { master, agent, runner } = await setup();
		await agent.start();
		const target = { hostId: 'host-a', bootId: agent.descriptor.bootId };
		const workerLaunch = launch();
		workerLaunch.workerData.info.shards = 99;
		const launchTask = master.launch(target, 0, identity, topology, workerLaunch);
		await until(() => runner.workers.length === 1);
		const worker = runner.workers[0]!;

		worker.message({ type: 'WORKER_START', workerId: 0 });
		await until(() => hasMessage(worker, 'SPAWN_SHARDS'));
		expect(worker.messages.find(message => isMessage(message, 'SPAWN_SHARDS'))).toMatchObject({
			info: { shards: topology.totalShards },
		});
		worker.message({ type: 'CONNECT_QUEUE', workerId: 0, shardId: 0 });
		await until(() => hasMessage(worker, 'ALLOW_CONNECT'));
		worker.message({ type: 'WORKER_SHARDS_CONNECTED', workerId: 0 });
		worker.message({ type: 'WORKER_READY', workerId: 0 });

		await expect(launchTask).resolves.toBeUndefined();
		expect(master.hosts.get('host-a')?.observed[0]).toMatchObject({ workerId: 0, ready: true, identity });

		const stopTask = master.stop(target, 0, identity);
		await expect(stopTask).resolves.toBeUndefined();
		expect(worker.stopCalls).toBe(1);
		expect(master.hosts.get('host-a')?.observed).toEqual([]);
	});

	it('preserves workers when the control plane disconnects', async () => {
		const { master, agent, runner } = await setup();
		await agent.start();
		const target = { hostId: 'host-a', bootId: agent.descriptor.bootId };
		const launchTask = master.launch(target, 0, identity, topology, launch());
		await until(() => runner.workers.length === 1);
		runner.workers[0]!.message({ type: 'WORKER_READY', workerId: 0 });
		await launchTask;

		await master.close();
		await until(() => agent.state === 'disconnected');
		expect(runner.workers[0]!.stopCalls).toBe(0);
	});

	it('respawns a crashed worker locally with a fresh token', async () => {
		const { master, agent, runner } = await setup();
		await agent.start();
		const target = { hostId: 'host-a', bootId: agent.descriptor.bootId };
		const launchTask = master.launch(target, 0, identity, topology, launch());
		await until(() => runner.workers.length === 1);
		runner.workers[0]!.message({ type: 'WORKER_READY', workerId: 0 });
		await launchTask;

		const ready = vi.fn();
		master.on('workerReady', ready);
		runner.workers[0]!.exit(1, null);
		await until(() => runner.workers.length === 2);
		const replacement = runner.workers[1]!;
		replacement.message({ type: 'WORKER_START', workerId: 0 });
		await until(() => hasMessage(replacement, 'SPAWN_SHARDS'));
		replacement.message({ type: 'CONNECT_QUEUE', workerId: 0, shardId: 0 });
		await until(() => hasMessage(replacement, 'ALLOW_CONNECT'));
		replacement.message({ type: 'WORKER_READY', workerId: 0 });
		await until(() => ready.mock.calls.some(call => call[4] === true));

		const replacementIdentity = runner.requests[1]!.identity;
		expect(replacementIdentity.slot).toBe(identity.slot);
		expect(replacementIdentity.token).not.toBe(identity.token);
		expect(master.hosts.get('host-a')?.observed[0]?.identity).toEqual(replacementIdentity);
	});

	it('cancels a pending respawn across stop and a new agent session', async () => {
		const { master, agent, runner } = await setup('secret', new FakeRunner(), 100);
		await agent.start();
		const target = { hostId: 'host-a', bootId: agent.descriptor.bootId };
		const launchTask = master.launch(target, 0, identity, topology, launch());
		await until(() => runner.workers.length === 1);
		runner.workers[0]!.message({ type: 'WORKER_READY', workerId: 0 });
		await launchTask;

		runner.workers[0]!.exit(1, null);
		await agent.stop();
		await agent.start();
		await new Promise(resolve => setTimeout(resolve, 200));

		expect(runner.workers).toHaveLength(1);
	});

	it('fails launch immediately when a worker requests unsupported manager RPC', async () => {
		const { master, agent, runner } = await setup();
		await agent.start();
		const target = { hostId: 'host-a', bootId: agent.descriptor.bootId };
		const launchTask = master.launch(target, 0, identity, topology, launch());
		await until(() => runner.workers.length === 1);
		runner.workers[0]!.message({
			type: 'CACHE_REQUEST',
			workerId: 0,
			nonce: 'cache-request',
			method: 'get',
			args: [],
		});
		await expect(launchTask).rejects.toThrow(/WorkerAdapter is not supported/);
		expect(runner.workers[0]!.stopCalls).toBe(1);
	});

	it('rejects workerData.resharding before spawning a worker', async () => {
		const { master, agent, runner } = await setup();
		await agent.start();
		const workerLaunch = launch();
		workerLaunch.workerData.resharding = true;

		await expect(
			master.launch({ hostId: 'host-a', bootId: agent.descriptor.bootId }, 0, identity, topology, workerLaunch),
		).rejects.toThrow('does not support workerData.resharding=true');
		expect(runner.workers).toHaveLength(0);
	});

	it('keeps another host route when a lost host reconnects with a stale ready snapshot', async () => {
		const master = new ScalerMaster({ authToken: 'secret', port: 0 });
		const address = (await master.listen()) as AddressInfo;
		cleanups.push(() => master.close());
		const connections: ProtocolConnection[] = [];
		const connect = async (hostId: string) => {
			const connection = await connectWebSocket({
				host: '127.0.0.1',
				port: address.port,
				hostId,
				authToken: 'secret',
			});
			connections.push(connection);
			return connection;
		};
		cleanups.push(async () => {
			for (const connection of connections) connection.terminate();
		});

		const identityA = { slot: 'allocation-a', token: 'token-a' };
		const identityB = { slot: 'allocation-b', token: 'token-b' };
		const a = await connect('host-a');
		await a.send({
			type: 'HELLO',
			version: SCALER_PROTOCOL_VERSION,
			host: { hostId: 'host-a', bootId: 'boot-a', maxWorkers: 1 },
			workers: [{ workerId: 0, identity: identityA, topology, ready: true }],
		});
		await until(() => master.hosts.has('host-a'));
		a.terminate();
		await until(() => !master.hosts.has('host-a'));

		const messagesB: unknown[] = [];
		const b = await connect('host-b');
		b.on('message', message => messagesB.push(message));
		await b.send({
			type: 'HELLO',
			version: SCALER_PROTOCOL_VERSION,
			host: { hostId: 'host-b', bootId: 'boot-b', maxWorkers: 1 },
			workers: [{ workerId: 0, identity: identityB, topology, ready: true }],
		});
		await until(() => master.hosts.has('host-b'));

		const messagesA: unknown[] = [];
		const reconnectedA = await connect('host-a');
		reconnectedA.on('message', message => messagesA.push(message));
		await reconnectedA.send({
			type: 'HELLO',
			version: SCALER_PROTOCOL_VERSION,
			host: { hostId: 'host-a', bootId: 'boot-a', maxWorkers: 1 },
			workers: [{ workerId: 0, identity: identityA, topology, ready: true }],
		});
		await until(() => master.hosts.has('host-a'));

		const staleStop = master.stop({ hostId: 'host-a', bootId: 'boot-a' }, 0, identityA);
		await until(() => messagesA.some(message => isMessage(message, 'STOP')));
		await reconnectedA.send({
			type: 'WORKER_STATUS',
			version: SCALER_PROTOCOL_VERSION,
			workerId: 0,
			identity: identityA,
			topology,
			status: 'exited',
			code: 0,
			signal: null,
		});
		await staleStop;

		await master.postMessage({ hostId: 'host-b', bootId: 'boot-b' }, 0, identityB, { routed: 'b' });
		await until(() =>
			messagesB.some(
				message => isMessage(message, 'WORKER_MSG') && (message as { body?: { routed?: string } }).body?.routed === 'b',
			),
		);

		const oldHostB = (master as unknown as { hostsById: Map<string, unknown> }).hostsById.get('host-b')!;
		const identityB2 = { slot: 'allocation-b', token: 'token-b2' };
		const messagesB2: unknown[] = [];
		const reconnectedB = await connect('host-b');
		reconnectedB.on('message', message => messagesB2.push(message));
		await reconnectedB.send({
			type: 'HELLO',
			version: SCALER_PROTOCOL_VERSION,
			host: { hostId: 'host-b', bootId: 'boot-b', maxWorkers: 1 },
			workers: [{ workerId: 0, identity: identityB2, topology, ready: true }],
		});
		await until(() => master.hosts.get('host-b')?.observed[0]?.identity.token === identityB2.token);

		await (
			master as unknown as {
				receive(host: unknown, message: unknown): Promise<void>;
			}
		).receive(oldHostB, {
			type: 'WORKER_STATUS',
			version: SCALER_PROTOCOL_VERSION,
			workerId: 0,
			identity: identityB,
			topology,
			status: 'exited',
			code: 1,
			signal: null,
		});
		await master.postMessage({ hostId: 'host-b', bootId: 'boot-b' }, 0, identityB2, { routed: 'b2' });
		await until(() =>
			messagesB2.some(
				message =>
					isMessage(message, 'WORKER_MSG') && (message as { body?: { routed?: string } }).body?.routed === 'b2',
			),
		);
	});

	it('stops a child whose LAUNCH is still waiting for runner.spawn', async () => {
		const runner = new SlowFakeRunner();
		const { master, agent } = await setup('secret', runner);
		await agent.start();
		const target = { hostId: 'host-a', bootId: agent.descriptor.bootId };
		const launchTask = master.launch(target, 0, identity, topology, launch());
		await until(() => runner.workers.length === 1);

		await expect(agent.stop()).resolves.toBeUndefined();
		expect(runner.workers[0]!.exited).toBe(true);
		expect(agent.workers).toEqual([]);
		await expect(launchTask).rejects.toThrow();
	});

	it('waits for an in-flight stop before restarting', async () => {
		const runner = new BlockingStopRunner();
		const { master, agent } = await setup('secret', runner);
		await agent.start();
		const target = { hostId: 'host-a', bootId: agent.descriptor.bootId };
		const launchTask = master.launch(target, 0, identity, topology, launch());
		await until(() => runner.workers.length === 1);
		runner.workers[0]!.message({ type: 'WORKER_READY', workerId: 0 });
		await launchTask;

		const stopTask = agent.stop();
		await runner.stopStarted;
		let restartSettled = false;
		const restartTask = agent.start().then(() => (restartSettled = true));
		await new Promise(resolve => setTimeout(resolve, 20));
		expect(restartSettled).toBe(false);

		runner.finishStop();
		await stopTask;
		await restartTask;
		expect(agent.state).toBe('authenticated');
	});

	it('rejects authentication before HELLO', async () => {
		const { agent } = await setup('wrong-secret');
		await expect(agent.start()).rejects.toThrow(/401/);
	});

	it('skips a stale identify reservation without delaying the next request in its bucket', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		const master = new ScalerMaster({ authToken: 'secret', port: 0, now: () => Date.now() });
		const sent: IdentifyGrantMessage[] = [];
		const host = identifyHost(message => {
			sent.push(message);
		});
		const identify = identifyHarness(master);

		identify(host, identifyRequest(0, 'stale'));
		identify(host, identifyRequest(1, 'next'));
		host.observed.delete(0);
		await vi.advanceTimersByTimeAsync(0);

		expect(sent.map(message => message.requestId)).toEqual(['next']);

		identify(host, identifyRequest(2, 'serialized'));
		await vi.advanceTimersByTimeAsync(5_499);
		expect(sent.map(message => message.requestId)).toEqual(['next']);
		await vi.advanceTimersByTimeAsync(1);
		expect(sent.map(message => message.requestId)).toEqual(['next', 'serialized']);
	});

	it('starts the identify cooldown when a deferred grant send settles', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		const master = new ScalerMaster({ authToken: 'secret', port: 0, now: () => Date.now() });
		const attempts: string[] = [];
		let resolveFirst!: () => void;
		const firstSend = new Promise<void>(resolve => (resolveFirst = resolve));
		const host = identifyHost(message => {
			attempts.push(message.requestId);
			if (message.requestId === 'deferred') return firstSend;
			return undefined;
		});
		const identify = identifyHarness(master);

		identify(host, identifyRequest(0, 'deferred'));
		identify(host, identifyRequest(1, 'next'));
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(6_000);
		expect(attempts).toEqual(['deferred']);

		resolveFirst();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(5_499);
		expect(attempts).toEqual(['deferred']);
		await vi.advanceTimersByTimeAsync(1);
		expect(attempts).toEqual(['deferred', 'next']);
	});

	it('keeps the identify cooldown when sending a grant fails', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		const master = new ScalerMaster({ authToken: 'secret', port: 0, now: () => Date.now() });
		const attempts: string[] = [];
		const host = identifyHost(message => {
			attempts.push(message.requestId);
			if (message.requestId === 'failed') throw new Error('send failed');
		});
		const identify = identifyHarness(master);

		identify(host, identifyRequest(0, 'failed'));
		identify(host, identifyRequest(1, 'next'));
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(5_499);
		expect(attempts).toEqual(['failed']);
		await vi.advanceTimersByTimeAsync(1);

		expect(attempts).toEqual(['failed', 'next']);
	});
});

interface IdentifyHost {
	connection: {
		readonly open: boolean;
		send(message: IdentifyGrantMessage): Promise<void>;
	};
	observed: Map<number, ObservedWorker>;
}

function identifyHost(send: (message: IdentifyGrantMessage) => void | Promise<void>): IdentifyHost {
	return {
		connection: {
			open: true,
			async send(message) {
				await send(message);
			},
		},
		observed: new Map(
			[0, 1, 2].map(workerId => [
				workerId,
				{
					workerId,
					identity: { slot: `${workerId}:1`, token: `token-${workerId}` },
					topology,
					ready: false,
				},
			]),
		),
	};
}

function identifyHarness(master: ScalerMaster) {
	return (master as unknown as { identify(host: IdentifyHost, message: IdentifyRequestMessage): void }).identify.bind(
		master,
	);
}

function identifyRequest(workerId: number, requestId: string): IdentifyRequestMessage {
	return {
		type: 'IDENTIFY_REQUEST',
		version: SCALER_PROTOCOL_VERSION,
		requestId,
		workerId,
		identity: { slot: `${workerId}:1`, token: `token-${workerId}` },
		shardId: 0,
		maxConcurrency: 1,
	};
}

function hasMessage(worker: FakeRunningWorker, type: string) {
	return worker.messages.some(message => isMessage(message, type));
}

function isMessage(message: unknown, type: string) {
	return typeof message === 'object' && message !== null && 'type' in message && message.type === type;
}

async function until(predicate: () => boolean) {
	await vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 2_000, interval: 5 });
}
