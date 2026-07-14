import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SeyfertScaler } from '../src/scaler';
import type {
	AllocationIdentity,
	ConnectedScalerHost,
	LogicalWorker,
	ObservedWorker,
	PlacementLocation,
	RemoteWorkerLaunch,
	ShardTopology,
} from '../src/types';

class FakeMaster extends EventEmitter {
	readonly hostMap = new Map<string, ConnectedScalerHost>();
	readonly calls: string[] = [];

	get hosts() {
		return this.hostMap as ReadonlyMap<string, ConnectedScalerHost>;
	}

	async listen() {
		this.calls.push('listen');
	}

	async close() {
		this.calls.push('close');
	}

	async launch(
		target: PlacementLocation,
		workerId: number,
		identity: AllocationIdentity,
		topology: ShardTopology,
		_launch: RemoteWorkerLaunch,
	) {
		this.calls.push(`launch:${workerId}:${target.hostId}:${identity.slot}`);
		const host = this.hostMap.get(target.hostId)!;
		(host.observed as ObservedWorker[]).push({
			workerId,
			identity: { ...identity },
			topology: { ...topology },
			ready: true,
		});
	}

	async stop(target: PlacementLocation, workerId: number, identity: AllocationIdentity) {
		this.calls.push(`stop:${workerId}:${target.hostId}:${identity.slot}`);
		const host = this.hostMap.get(target.hostId);
		if (!host) throw new Error(`Host ${target.hostId} is unavailable`);
		const observed = host.observed as ObservedWorker[];
		const index = observed.findIndex(
			worker => worker.workerId === workerId && worker.identity.token === identity.token,
		);
		if (index === -1) throw new Error('Worker is unavailable');
		observed.splice(index, 1);
	}

	async postMessage(_target: PlacementLocation, workerId: number, _identity: AllocationIdentity, body: unknown) {
		this.calls.push(`post:${workerId}:${JSON.stringify(body)}`);
	}

	disconnect(hostId: string) {
		const host = this.hostMap.get(hostId)!;
		this.hostMap.delete(hostId);
		this.emit('hostDisconnected', { ...host.descriptor });
	}

	workerExit(hostId: string, workerId: number, identity: AllocationIdentity) {
		const current = this.hostMap.get(hostId)!;
		const observed = current.observed as ObservedWorker[];
		const index = observed.findIndex(value => value.workerId === workerId && value.identity.token === identity.token);
		if (index !== -1) observed.splice(index, 1);
		this.emit('workerExit', workerId, identity, 1, null, {
			hostId,
			bootId: current.descriptor.bootId,
		});
	}

	workerReady(hostId: string, workerId: number, identity: AllocationIdentity, topology: ShardTopology) {
		const current = this.hostMap.get(hostId)!;
		(current.observed as ObservedWorker[]).push({ workerId, identity, topology, ready: true });
		this.emit(
			'workerReady',
			workerId,
			identity,
			topology,
			{
				hostId,
				bootId: current.descriptor.bootId,
			},
			true,
		);
	}
}

class HangingLaunchMaster extends FakeMaster {
	override async launch(
		target: PlacementLocation,
		workerId: number,
		identity: AllocationIdentity,
		topology: ShardTopology,
		_launch: RemoteWorkerLaunch,
	) {
		this.calls.push(`launch:${workerId}:${target.hostId}:${identity.slot}`);
		const current = this.hostMap.get(target.hostId)!;
		(current.observed as ObservedWorker[]).push({
			workerId,
			identity: { ...identity },
			topology: { ...topology },
			ready: false,
		});
		await new Promise<void>(() => undefined);
	}
}

class HangingAfterFirstLaunchMaster extends FakeMaster {
	private launchCount = 0;

	override async launch(
		target: PlacementLocation,
		workerId: number,
		identity: AllocationIdentity,
		topology: ShardTopology,
		launch: RemoteWorkerLaunch,
	) {
		if (this.launchCount++ === 0) return super.launch(target, workerId, identity, topology, launch);
		this.calls.push(`launch:${workerId}:${target.hostId}:${identity.slot}`);
		const current = this.hostMap.get(target.hostId)!;
		(current.observed as ObservedWorker[]).push({
			workerId,
			identity: { ...identity },
			topology: { ...topology },
			ready: false,
		});
		await new Promise<void>(() => undefined);
	}
}

class LateRejectingLaunchMaster extends FakeMaster {
	readonly launchStarted: Promise<void>;
	private markLaunchStarted!: () => void;
	private rejectLaunch?: (error: Error) => void;

	constructor() {
		super();
		this.launchStarted = new Promise(resolve => (this.markLaunchStarted = resolve));
	}

	override launch(
		target: PlacementLocation,
		workerId: number,
		identity: AllocationIdentity,
		topology: ShardTopology,
		_launch: RemoteWorkerLaunch,
	) {
		this.calls.push(`launch:${workerId}:${target.hostId}:${identity.slot}`);
		const current = this.hostMap.get(target.hostId)!;
		(current.observed as ObservedWorker[]).push({
			workerId,
			identity: { ...identity },
			topology: { ...topology },
			ready: false,
		});
		const launch = new Promise<void>((_resolve, reject) => (this.rejectLaunch = reject));
		this.markLaunchStarted();
		return launch;
	}

	failLaunch() {
		this.rejectLaunch?.(new Error('late launch failure'));
	}
}

class RejectingNextLaunchMaster extends FakeMaster {
	private rejectNext = false;

	failNextLaunch() {
		this.rejectNext = true;
	}

	override async launch(
		target: PlacementLocation,
		workerId: number,
		identity: AllocationIdentity,
		topology: ShardTopology,
		launch: RemoteWorkerLaunch,
	) {
		await super.launch(target, workerId, identity, topology, launch);
		if (!this.rejectNext) return;
		this.rejectNext = false;
		throw new Error('launch rejected');
	}
}

const worker: LogicalWorker = { workerId: 0, shardStart: 0, shardEnd: 1, totalShards: 1 };

function host(hostId: string, observed: ObservedWorker[] = [], maxWorkers = 1): ConnectedScalerHost {
	return {
		descriptor: { hostId, bootId: `${hostId}-boot`, maxWorkers },
		connectedAt: hostId === 'a' ? 1 : 2,
		lastSeenAt: 1,
		observed,
	};
}

function createLaunch({ worker: value }: { worker: Readonly<LogicalWorker> }) {
	return {
		workerData: {
			intents: 1,
			token: 'discord-token',
			path: '/worker.js',
			shards: Array.from({ length: value.shardEnd - value.shardStart }, (_, index) => value.shardStart + index),
			totalShards: value.totalShards,
			totalWorkers: 1,
			mode: 'clusters' as const,
			workerId: value.workerId,
			debug: false,
			workerProxy: false,
			info: {
				url: 'wss://gateway.discord.gg',
				shards: value.totalShards,
				session_start_limit: { total: 1, remaining: 1, reset_after: 1, max_concurrency: 1 },
			},
			compress: false,
			resharding: false,
		},
	};
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('SeyfertScaler', () => {
	it('launches, publishes BOT_READY, and performs same-host rolling handoff linearly', async () => {
		const master = new FakeMaster();
		master.hostMap.set('a', host('a'));
		const scaler = new SeyfertScaler({ master, workers: [worker], createLaunch, startupTimeoutMs: 1_000 });
		const assignmentStates: string[] = [];
		scaler.on('assignment', assignment => assignmentStates.push(assignment.state));
		await scaler.start();
		const first = scaler.assignments.get(0)!;
		expect(first.state).toBe('routed');
		expect(assignmentStates).toEqual(['launching', 'routed']);
		expect(master.calls.slice(0, 3).map(call => call.split(':')[0])).toEqual(['listen', 'launch', 'post']);

		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6_000);
		await scaler.handoff(0, { hostId: 'a', bootId: 'a-boot' });
		const lifecycle = master.calls.filter(call => call.startsWith('launch:') || call.startsWith('stop:'));
		expect(lifecycle.map(call => call.split(':')[0])).toEqual(['launch', 'stop', 'launch']);
		expect(slotOf(lifecycle[1]!)).toBe(slotOf(lifecycle[0]!));
		expect(slotOf(lifecycle[2]!)).not.toBe(slotOf(lifecycle[0]!));
		await scaler.stop(false);
	});

	it('adopts exactly one compatible ready worker after master restart', async () => {
		const master = new FakeMaster();
		master.hostMap.set(
			'a',
			host('a', [
				{
					workerId: 0,
					identity: { slot: 'existing', token: 'existing-token' },
					topology: { ...worker },
					ready: true,
				},
			]),
		);
		const scaler = new SeyfertScaler({ master, workers: [worker], createLaunch, startupTimeoutMs: 1_000 });
		await scaler.start();
		expect(master.calls.some(call => call.startsWith('launch:'))).toBe(false);
		expect(scaler.assignments.get(0)).toMatchObject({
			state: 'routed',
			identity: { slot: 'existing', token: 'existing-token' },
		});
		await scaler.stop(false);
	});

	it('adopts workers from a host that reconnects after startup begins', async () => {
		const master = new FakeMaster();
		const scaler = new SeyfertScaler({ master, workers: [worker], createLaunch, startupTimeoutMs: 1_000 });
		const start = scaler.start();
		setTimeout(() => {
			master.hostMap.set(
				'a',
				host('a', [
					{
						workerId: 0,
						identity: { slot: 'existing', token: 'existing-token' },
						topology: { ...worker },
						ready: true,
					},
				]),
			);
		}, 10);

		await start;
		expect(master.calls.some(call => call.startsWith('launch:'))).toBe(false);
		expect(scaler.assignments.get(0)).toMatchObject({
			state: 'routed',
			identity: { slot: 'existing', token: 'existing-token' },
		});
		await scaler.stop(false);
	});

	it('waits for a compatible observed worker that is still launching', async () => {
		const master = new FakeMaster();
		const observed = {
			workerId: 0,
			identity: { slot: 'existing', token: 'existing-token' },
			topology: { ...worker },
			ready: false,
		};
		master.hostMap.set('a', host('a', [observed]));
		setTimeout(() => (observed.ready = true), 10);
		const scaler = new SeyfertScaler({
			master,
			workers: [worker],
			createLaunch,
			startupTimeoutMs: 1_000,
			readinessTimeoutMs: 1_000,
		});
		await scaler.start();
		expect(master.calls.some(call => call.startsWith('launch:'))).toBe(false);
		expect(scaler.assignments.get(0)?.state).toBe('routed');
		await scaler.stop(false);
	});

	it('rejects createLaunch workerData.resharding before contacting the agent', async () => {
		const master = new FakeMaster();
		master.hostMap.set('a', host('a'));
		const scaler = new SeyfertScaler({
			master,
			workers: [worker],
			startupTimeoutMs: 1_000,
			createLaunch: input => {
				const value = createLaunch(input);
				value.workerData.resharding = true;
				return value;
			},
		});

		await expect(scaler.start()).rejects.toThrow('does not support workerData.resharding=true');
		expect(master.calls.some(call => call.startsWith('launch:'))).toBe(false);
		await scaler.stop(false);
	});

	it('detaches master events when stopped without closing the master', async () => {
		const master = new FakeMaster();
		master.hostMap.set('a', host('a'));
		const scaler = new SeyfertScaler({ master, workers: [worker], createLaunch, startupTimeoutMs: 1_000 });
		const messages = vi.fn();
		scaler.on('workerMessage', messages);
		await scaler.start();
		const current = scaler.assignments.get(0)!;
		if (current.state !== 'routed') throw new Error('Expected routed worker');

		expect(master.listenerCount('workerMessage')).toBe(1);
		await scaler.stop(false);
		expect(master.listenerCount('workerReady')).toBe(0);
		expect(master.listenerCount('workerExit')).toBe(0);
		expect(master.listenerCount('workerMessage')).toBe(0);
		expect(master.listenerCount('hostDisconnected')).toBe(0);
		expect(master.listenerCount('hostSnapshot')).toBe(0);

		master.emit('workerMessage', 0, current.identity, { after: 'stop' }, current.placement);
		expect(messages).not.toHaveBeenCalled();
		expect(master.calls).not.toContain('close');
	});

	it('does not re-place a disconnected host by default', async () => {
		const master = new FakeMaster();
		master.hostMap.set('a', host('a'));
		master.hostMap.set('b', host('b'));
		const scaler = new SeyfertScaler({ master, workers: [worker], createLaunch, startupTimeoutMs: 1_000 });
		await scaler.start();
		master.disconnect('a');
		await vi.waitFor(() => expect(scaler.assignments.get(0)?.state).toBe('unassigned'));
		expect(master.calls.filter(call => call.startsWith('launch:'))).toHaveLength(1);
		await scaler.stop(false);
	});

	it('re-places after host loss only when explicitly enabled', async () => {
		const master = new FakeMaster();
		master.hostMap.set('a', host('a'));
		master.hostMap.set('b', host('b'));
		const scaler = new SeyfertScaler({
			master,
			workers: [worker],
			createLaunch,
			startupTimeoutMs: 1_000,
			autoRePlaceOnHostLoss: true,
		});
		await scaler.start();
		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6_000);
		master.disconnect('a');
		await vi.waitFor(() => expect(master.calls.filter(call => call.startsWith('launch:'))).toHaveLength(2));
		expect(scaler.assignments.get(0)).toMatchObject({ state: 'routed', placement: { hostId: 'b' } });
		await scaler.stop(false);
	});

	it('assigns an unassigned worker to an explicit target', async () => {
		const master = new FakeMaster();
		master.hostMap.set('a', host('a'));
		master.hostMap.set('b', host('b'));
		const scaler = new SeyfertScaler({ master, workers: [worker], createLaunch, startupTimeoutMs: 1_000 });
		await scaler.start();
		master.disconnect('a');
		await vi.waitFor(() => expect(scaler.assignments.get(0)?.state).toBe('unassigned'));
		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6_000);

		await expect(scaler.assign(0, { hostId: 'b', bootId: 'b-boot' })).resolves.toMatchObject({
			state: 'routed',
			placement: { hostId: 'b', bootId: 'b-boot' },
		});
		await scaler.stop(false);
	});

	it('assigns an unassigned worker with the placement planner', async () => {
		const master = new FakeMaster();
		master.hostMap.set('a', host('a'));
		master.hostMap.set('b', host('b'));
		const scaler = new SeyfertScaler({ master, workers: [worker], createLaunch, startupTimeoutMs: 1_000 });
		await scaler.start();
		master.disconnect('a');
		await vi.waitFor(() => expect(scaler.assignments.get(0)?.state).toBe('unassigned'));
		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6_000);

		await expect(scaler.assign(0)).resolves.toMatchObject({ state: 'routed', placement: { hostId: 'b' } });
		await scaler.stop(false);
	});

	it('does not re-adopt a late local respawn after manual assignment', async () => {
		const master = new FakeMaster();
		master.hostMap.set('a', host('a'));
		master.hostMap.set('b', host('b'));
		const scaler = new SeyfertScaler({ master, workers: [worker], createLaunch, startupTimeoutMs: 1_000 });
		await scaler.start();
		const original = scaler.assignments.get(0)!;
		if (original.state !== 'routed') throw new Error('Expected routed worker');
		master.disconnect('a');
		await vi.waitFor(() => expect(scaler.assignments.get(0)?.state).toBe('unassigned'));
		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6_000);
		await scaler.assign(0, { hostId: 'b', bootId: 'b-boot' });

		master.hostMap.set('a', host('a'));
		const lateRespawn = { slot: original.identity.slot, token: 'late-respawn-token' };
		master.workerReady('a', 0, lateRespawn, worker);
		const reconnected = master.hostMap.get('a')!;
		master.emit('hostSnapshot', reconnected.descriptor, reconnected.observed);

		await vi.waitFor(() => expect(master.calls).toContain(`stop:0:a:${lateRespawn.slot}`));
		expect(scaler.assignments.get(0)).toMatchObject({ state: 'routed', placement: { hostId: 'b' } });
		await scaler.stop(false);
	});

	it('rejects assign for a routed worker and directs callers to handoff', async () => {
		const master = new FakeMaster();
		master.hostMap.set('a', host('a'));
		const scaler = new SeyfertScaler({ master, workers: [worker], createLaunch, startupTimeoutMs: 1_000 });
		await scaler.start();

		await expect(scaler.assign(0)).rejects.toThrow('use handoff() to move it');
		await scaler.stop(false);
	});

	it('reconciles every worker that fits and aggregates insufficient-capacity failures', async () => {
		let now = Date.now();
		vi.spyOn(Date, 'now').mockImplementation(() => (now += 6_000));
		const workers: LogicalWorker[] = [
			{ workerId: 0, shardStart: 0, shardEnd: 1, totalShards: 2 },
			{ workerId: 1, shardStart: 1, shardEnd: 2, totalShards: 2 },
		];

		const fullMaster = new FakeMaster();
		fullMaster.hostMap.set('a', host('a', [], 2));
		fullMaster.hostMap.set('b', host('b', [], 2));
		const fullScaler = new SeyfertScaler({
			master: fullMaster,
			workers,
			createLaunch,
			placementStrategy: 'fill-first',
			startupTimeoutMs: 1_000,
		});
		await fullScaler.start();
		fullMaster.disconnect('a');
		await vi.waitFor(() =>
			expect([...fullScaler.assignments.values()].every(assignment => assignment.state === 'unassigned')).toBe(true),
		);

		await fullScaler.reconcile();
		expect([...fullScaler.assignments.values()]).toEqual([
			expect.objectContaining({ state: 'routed', placement: expect.objectContaining({ hostId: 'b' }) }),
			expect.objectContaining({ state: 'routed', placement: expect.objectContaining({ hostId: 'b' }) }),
		]);
		await fullScaler.stop(false);

		const partialMaster = new FakeMaster();
		partialMaster.hostMap.set('a', host('a', [], 2));
		partialMaster.hostMap.set('b', host('b'));
		const partialScaler = new SeyfertScaler({
			master: partialMaster,
			workers,
			createLaunch,
			placementStrategy: 'fill-first',
			startupTimeoutMs: 1_000,
		});
		await partialScaler.start();
		partialMaster.disconnect('a');
		await vi.waitFor(() =>
			expect([...partialScaler.assignments.values()].every(assignment => assignment.state === 'unassigned')).toBe(true),
		);

		const error = await partialScaler.reconcile().catch(error => error);
		expect(error).toBeInstanceOf(AggregateError);
		expect(error.errors).toHaveLength(1);
		expect([...partialScaler.assignments.values()].filter(assignment => assignment.state === 'routed')).toHaveLength(1);
		await partialScaler.stop(false);
	});

	it('replans after a failed reconcile launch and reuses the released capacity', async () => {
		let now = Date.now();
		vi.spyOn(Date, 'now').mockImplementation(() => (now += 6_000));
		const workers: LogicalWorker[] = [
			{ workerId: 0, shardStart: 0, shardEnd: 1, totalShards: 2 },
			{ workerId: 1, shardStart: 1, shardEnd: 2, totalShards: 2 },
		];
		const master = new RejectingNextLaunchMaster();
		master.hostMap.set('a', host('a', [], 2));
		master.hostMap.set('b', host('b'));
		const scaler = new SeyfertScaler({
			master,
			workers,
			createLaunch,
			placementStrategy: 'fill-first',
			startupTimeoutMs: 1_000,
		});
		await scaler.start();
		master.disconnect('a');
		await vi.waitFor(() =>
			expect([...scaler.assignments.values()].every(assignment => assignment.state === 'unassigned')).toBe(true),
		);
		master.failNextLaunch();

		const error = await scaler.reconcile().catch(error => error);
		expect(error).toBeInstanceOf(AggregateError);
		expect(error.errors).toHaveLength(1);
		expect(scaler.assignments.get(0)?.state).toBe('unassigned');
		expect(scaler.assignments.get(1)).toMatchObject({ state: 'routed', placement: { hostId: 'b' } });
		await scaler.stop(false);
	});

	it('stops a stale snapshot queued during a rejected assign and preserves exact recovery adoption', async () => {
		const master = new RejectingNextLaunchMaster();
		master.hostMap.set('a', host('a'));
		master.hostMap.set('b', host('b'));
		const scaler = new SeyfertScaler({ master, workers: [worker], createLaunch, startupTimeoutMs: 1_000 });
		await scaler.start();
		const original = scaler.assignments.get(0)!;
		if (original.state !== 'routed') throw new Error('Expected routed worker');
		master.disconnect('a');
		await vi.waitFor(() => expect(scaler.assignments.get(0)?.state).toBe('unassigned'));
		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6_000);

		const staleIdentity = { slot: original.identity.slot, token: 'stale-respawn-token' };
		const reconnected = host('a', [{ workerId: 0, identity: staleIdentity, topology: { ...worker }, ready: true }]);
		master.hostMap.set('a', reconnected);
		master.failNextLaunch();
		const assignment = scaler.assign(0, { hostId: 'b', bootId: 'b-boot' });
		master.emit('hostSnapshot', reconnected.descriptor, reconnected.observed);

		await expect(assignment).rejects.toThrow('launch rejected');
		await vi.waitFor(() => expect(master.calls).toContain(`stop:0:a:${staleIdentity.slot}`));
		expect(scaler.assignments.get(0)?.state).toBe('unassigned');

		const failedLaunch = master.calls.findLast(call => call.startsWith('launch:0:b:'))!;
		const recoveryIdentity = { slot: slotOf(failedLaunch), token: 'valid-recovery-token' };
		const target = master.hostMap.get('b')!;
		(target.observed as ObservedWorker[]).push({
			workerId: 0,
			identity: recoveryIdentity,
			topology: { ...worker },
			ready: true,
		});
		master.emit('hostSnapshot', target.descriptor, target.observed);

		await vi.waitFor(() =>
			expect(scaler.assignments.get(0)).toMatchObject({
				state: 'routed',
				placement: { hostId: 'b' },
				identity: recoveryIdentity,
			}),
		);
		await scaler.stop(false);
	});

	it('accepts a local respawn only when the allocation slot and host still match', async () => {
		const master = new FakeMaster();
		master.hostMap.set('a', host('a'));
		const scaler = new SeyfertScaler({ master, workers: [worker], createLaunch, startupTimeoutMs: 1_000 });
		await scaler.start();
		const current = scaler.assignments.get(0)!;
		if (current.state !== 'routed') throw new Error('Expected routed worker');
		master.workerExit('a', 0, current.identity);
		await vi.waitFor(() => expect(scaler.assignments.get(0)?.state).toBe('unassigned'));
		const replacement = { slot: current.identity.slot, token: 'replacement-token' };
		master.workerReady('a', 0, replacement, worker);
		await vi.waitFor(() => expect(scaler.assignments.get(0)).toMatchObject({ state: 'routed', identity: replacement }));
		await scaler.stop(false);
	});

	it('stops promptly while a launch is waiting for readiness', async () => {
		const master = new HangingLaunchMaster();
		master.hostMap.set('a', host('a'));
		const scaler = new SeyfertScaler({
			master,
			workers: [worker],
			createLaunch,
			startupTimeoutMs: 1_000,
			readinessTimeoutMs: 60_000,
		});
		const startTask = scaler.start();
		await vi.waitFor(() => expect(master.calls.some(call => call.startsWith('launch:'))).toBe(true));

		const startedAt = performance.now();
		await expect(scaler.stop(false)).resolves.toBeUndefined();
		expect(performance.now() - startedAt).toBeLessThan(1_000);
		expect(master.calls.some(call => call.startsWith('stop:'))).toBe(true);
		await expect(startTask).rejects.toThrow('Scaler stopped');
		expect(scaler.state).toBe('stopped');
	});

	it('removes the lifecycle listener when readiness times out', async () => {
		const master = new HangingAfterFirstLaunchMaster();
		master.hostMap.set('a', host('a'));
		const scaler = new SeyfertScaler({
			master,
			workers: [worker],
			createLaunch,
			startupTimeoutMs: 1_000,
			readinessTimeoutMs: 20,
		});
		await scaler.start();
		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6_000);
		const addListener = vi.spyOn(AbortSignal.prototype, 'addEventListener');
		const removeListener = vi.spyOn(AbortSignal.prototype, 'removeEventListener');

		await expect(scaler.handoff(0, { hostId: 'a', bootId: 'a-boot' })).rejects.toThrow('Worker 0 readiness timed out');
		const added = addListener.mock.calls.filter(([type]) => type === 'abort').map(([, listener]) => listener);
		const removed = new Set(
			removeListener.mock.calls.filter(([type]) => type === 'abort').map(([, listener]) => listener),
		);
		expect(added.length).toBeGreaterThan(0);
		expect(added.every(listener => removed.has(listener))).toBe(true);
		await scaler.stop(false);
	});

	it('clears the pending launch-gate timer when stopped', async () => {
		const master = new FakeMaster();
		master.hostMap.set('a', host('a'));
		const scaler = new SeyfertScaler({ master, workers: [worker], createLaunch, startupTimeoutMs: 1_000 });
		await scaler.start();
		vi.useFakeTimers();

		const handoffTask = scaler.handoff(0, { hostId: 'a', bootId: 'a-boot' });
		for (let index = 0; index < 5; index++) await Promise.resolve();
		expect(vi.getTimerCount()).toBe(1);

		const stopTask = scaler.stop(false);
		await expect(handoffTask).rejects.toThrow('Scaler stopped');
		await expect(stopTask).resolves.toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('observes a late launch rejection when lifecycle was already aborted', async () => {
		const master = new LateRejectingLaunchMaster();
		master.hostMap.set('a', host('a'));
		let enterCreateLaunch!: () => void;
		let releaseCreateLaunch!: () => void;
		const createLaunchStarted = new Promise<void>(resolve => (enterCreateLaunch = resolve));
		const createLaunchBarrier = new Promise<void>(resolve => (releaseCreateLaunch = resolve));
		const scaler = new SeyfertScaler({
			master,
			workers: [worker],
			startupTimeoutMs: 1_000,
			readinessTimeoutMs: 60_000,
			createLaunch: async input => {
				enterCreateLaunch();
				await createLaunchBarrier;
				return createLaunch(input);
			},
		});
		const unhandled = vi.fn();
		process.on('unhandledRejection', unhandled);
		try {
			const startTask = scaler.start();
			await createLaunchStarted;
			const stopTask = scaler.stop(false);
			releaseCreateLaunch();
			await master.launchStarted;
			await expect(startTask).rejects.toThrow('Scaler stopped');
			await stopTask;

			master.failLaunch();
			await new Promise(resolve => setImmediate(resolve));
			expect(unhandled).not.toHaveBeenCalled();
		} finally {
			process.off('unhandledRejection', unhandled);
		}
	});
});

function slotOf(call: string) {
	return call.split(':').slice(3).join(':');
}
