import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { delay, positiveMs, toError } from './internal';
import { planPlacement } from './placement';
import { sameIdentity, sameTopology } from './protocol';
import type {
	AllocationIdentity,
	HostDescriptor,
	LogicalWorker,
	ObservedWorker,
	PlacementLocation,
	PlacementStrategy,
	RemoteWorkerLaunch,
	SeyfertScalerOptions,
	SeyfertScalerState,
} from './types';

export type {
	ConnectedScalerHost,
	LogicalWorkerResolver,
	PlacementStrategy,
	RemoteWorkerLaunch,
	ScalerMasterPort,
	SeyfertScalerOptions,
	SeyfertScalerState,
} from './types';

export interface ScalerAssignmentEndpoint {
	placement: PlacementLocation;
	identity: AllocationIdentity;
}

/** @internal */
export type ScalerBotReadyPayload = { type: 'BOT_READY' };

interface AssignmentBase {
	worker: LogicalWorker;
}

export type ScalerAssignment =
	| (AssignmentBase & { state: 'unassigned' })
	| (AssignmentBase & ScalerAssignmentEndpoint & { state: 'launching' | 'routed' | 'stopping' });

interface AssignmentRow extends AssignmentBase {
	state: ScalerAssignment['state'];
	placement?: PlacementLocation;
	identity?: AllocationIdentity;
	recovery?: ScalerAssignmentEndpoint;
	adopted?: boolean;
}

const LAUNCH_GATE_MS = 5_500;

export class SeyfertScaler extends EventEmitter<{
	assignment: [assignment: ScalerAssignment];
	downtime: [workerId: number, error: Error];
	error: [error: Error];
	state: [state: SeyfertScalerState, previous: SeyfertScalerState];
	stale: [workerId: number, identity: AllocationIdentity];
	workerMessage: [workerId: number, body: unknown, identity: AllocationIdentity];
}> {
	private readonly assignmentTable = new Map<number, AssignmentRow>();
	private readonly placementStrategy: PlacementStrategy;
	private readonly readinessTimeoutMs: number;
	private readonly startupTimeoutMs: number;
	private readonly autoRePlaceOnHostLoss: boolean;
	private stateValue: SeyfertScalerState = 'idle';
	private startPromise?: Promise<ReadonlyMap<number, ScalerAssignment>>;
	private operation = Promise.resolve<unknown>(undefined);
	private lifecycleAbort?: AbortController;
	private eventsAttached = false;
	private identitySequence = 0;
	private nextLaunchAt = 0;

	constructor(readonly options: SeyfertScalerOptions) {
		super();
		this.on('error', () => undefined);
		this.placementStrategy = options.placementStrategy ?? 'spread';
		if (!['spread', 'fill-first'].includes(this.placementStrategy)) throw new RangeError('Unknown placement strategy');
		this.readinessTimeoutMs = positiveMs(options.readinessTimeoutMs ?? 300_000, 'readinessTimeoutMs');
		this.startupTimeoutMs = positiveMs(options.startupTimeoutMs ?? 300_000, 'startupTimeoutMs');
		this.autoRePlaceOnHostLoss = options.autoRePlaceOnHostLoss ?? false;
	}

	get state() {
		return this.stateValue;
	}

	get assignments(): ReadonlyMap<number, ScalerAssignment> {
		return new Map([...this.assignmentTable].map(([workerId, row]) => [workerId, snapshot(row)]));
	}

	async start() {
		if (this.stateValue === 'running') return this.assignments;
		if (this.stateValue === 'starting') return this.startPromise!;
		if (this.stateValue === 'stopping' || this.stateValue === 'stopped') {
			throw new Error('A stopped SeyfertScaler cannot be restarted');
		}
		this.attachEvents();
		this.lifecycleAbort = new AbortController();
		this.transition('starting');
		this.startPromise = this.enqueue(() => this.startInternal());
		try {
			return await this.startPromise;
		} catch (error) {
			this.lifecycleAbort.abort(error);
			const cleanupFailures = await this.enqueue(() => this.cleanupFailedStartup());
			if (this.state !== 'stopping' && this.state !== 'stopped') this.transition('idle');
			if (cleanupFailures.length) {
				throw new AggregateError([error, ...cleanupFailures], 'Scaler startup and cleanup failed');
			}
			throw error;
		} finally {
			this.startPromise = undefined;
		}
	}

	async handoff(workerId: number, target: PlacementLocation) {
		return this.enqueueRunning(async () => {
			const row = this.requireRow(workerId);
			if (!row.placement || !row.identity || row.state !== 'routed') {
				throw new Error(`Worker ${workerId} is not routed`);
			}
			this.requireHostWithCapacity(target, row.placement.hostId);
			await this.stopRow(row);
			await this.launchRow(row, target);
			return snapshot(row);
		});
	}

	/**
	 * Places an unassigned logical worker on a host.
	 *
	 * Assigning after host loss while the previous host is partitioned may run
	 * two gateway sessions for the same shards, processing events and commands
	 * twice until that host reconnects and its stale worker is stopped. Use
	 * {@link handoff} to move a routed worker.
	 */
	async assign(workerId: number, target?: PlacementLocation) {
		return this.enqueueRunning(async () => {
			const row = this.requireRow(workerId);
			if (row.state === 'routed') {
				throw new Error(`Worker ${workerId} is routed; use handoff() to move it`);
			}
			if (row.state !== 'unassigned') throw new Error(`Worker ${workerId} is not unassigned`);
			const placement = target ?? this.chooseTarget(row.worker);
			if (!placement) throw new Error(`No host capacity is available for worker ${workerId}`);
			if (target) this.requireHostWithCapacity(target);
			row.recovery = undefined;
			await this.launchRow(row, placement);
			return snapshot(row);
		});
	}

	/**
	 * Attempts to place every currently unassigned logical worker.
	 *
	 * Reconciling after host loss while the previous host is partitioned may run
	 * two gateway sessions for the same shards, processing events and commands
	 * twice until that host reconnects and its stale workers are stopped.
	 * Failures are collected after all workers have been attempted.
	 */
	async reconcile() {
		return this.enqueueRunning(async () => {
			const unassigned = [...this.assignmentTable.values()].filter(row => row.state === 'unassigned');
			await this.reconcileUnassigned(unassigned);
			return this.assignments;
		});
	}

	postMessage(workerId: number, body: unknown) {
		return this.enqueueRunning(async () => {
			const row = this.requireRow(workerId);
			if (row.state !== 'routed' || !row.placement || !row.identity) {
				throw new Error(`Worker ${workerId} is not routed`);
			}
			await this.options.master.postMessage(row.placement, workerId, row.identity, body);
		});
	}

	async stop(closeMaster = true) {
		if (this.stateValue === 'stopped') return;
		if (this.stateValue === 'idle') {
			try {
				if (closeMaster) await this.options.master.close();
			} finally {
				this.detachEvents();
				this.transition('stopped');
			}
			return;
		}
		this.lifecycleAbort?.abort(new Error('Scaler stopped'));
		this.transition('stopping');
		try {
			await this.enqueue(async () => {
				const failures: unknown[] = [];
				for (const row of this.assignmentTable.values()) {
					if (!row.placement || !row.identity) continue;
					try {
						await this.stopRow(row);
					} catch (error) {
						failures.push(error);
					}
				}
				if (closeMaster) await this.options.master.close();
				if (failures.length) throw new AggregateError(failures, 'Failed to stop every scaler worker');
			});
		} finally {
			this.detachEvents();
			this.transition('stopped');
		}
	}

	private async startInternal() {
		await this.options.master.listen();
		const workers = await this.resolveWorkers(this.lifecycleAbort!.signal);
		this.assignmentTable.clear();
		for (const worker of workers) this.assignmentTable.set(worker.workerId, { worker, state: 'unassigned' });
		await this.waitForCapacity(Date.now() + this.startupTimeoutMs);
		const unassigned = [...this.assignmentTable.values()].filter(row => row.state === 'unassigned');
		await this.placeUnassigned(unassigned);
		const first = [...this.assignmentTable.values()].find(row => row.state === 'routed');
		if (first?.placement && first.identity) {
			const botReady: ScalerBotReadyPayload = { type: 'BOT_READY' };
			await this.options.master.postMessage(first.placement, first.worker.workerId, first.identity, botReady);
		}
		this.transition('running');
		return this.assignments;
	}

	private async adoptAndClean() {
		const candidates = new Map<number, { target: PlacementLocation; observed: ObservedWorker }[]>();
		for (const host of this.options.master.hosts.values()) {
			const target = location(host.descriptor);
			for (const observed of host.observed) {
				const row = this.assignmentTable.get(observed.workerId);
				if (!row || !sameTopology(row.worker, observed.topology)) {
					await this.stopObserved(target, observed);
					continue;
				}
				const values = candidates.get(observed.workerId) ?? [];
				values.push({ target, observed });
				candidates.set(observed.workerId, values);
			}
		}
		for (const row of this.assignmentTable.values()) {
			const matches = candidates.get(row.worker.workerId) ?? [];
			if (matches.length !== 1) {
				for (const match of matches) await this.stopObserved(match.target, match.observed);
				continue;
			}
			const match = matches[0]!;
			if (
				row.placement &&
				row.identity &&
				sameLocation(row.placement, match.target) &&
				sameIdentity(row.identity, match.observed.identity)
			) {
				continue;
			}
			row.state = match.observed.ready ? 'routed' : 'launching';
			row.placement = { ...match.target };
			row.identity = { ...match.observed.identity };
			row.recovery = undefined;
			row.adopted = true;
			this.emitAssignment(row);
			if (!match.observed.ready) {
				try {
					await this.waitForObservedReady(match.target, match.observed);
					row.state = 'routed';
					this.emitAssignment(row);
				} catch (error) {
					await this.stopObserved(match.target, match.observed);
					row.state = 'unassigned';
					row.placement = undefined;
					row.identity = undefined;
					this.emitAssignment(row);
					if (this.lifecycleAbort?.signal.aborted) throw this.lifecycleAbort.signal.reason;
					this.emit('error', toError(error));
				}
			}
		}
	}

	private async waitForObservedReady(target: PlacementLocation, observed: ObservedWorker) {
		const deadline = Date.now() + this.readinessTimeoutMs;
		while (Date.now() < deadline) {
			if (this.lifecycleAbort?.signal.aborted) throw this.lifecycleAbort.signal.reason;
			const current = this.options.master.hosts
				.get(target.hostId)
				?.observed.find(
					worker => worker.workerId === observed.workerId && sameIdentity(worker.identity, observed.identity),
				);
			if (current?.ready) return;
			if (!current) throw new Error(`Adopted worker ${observed.workerId} disappeared before ready`);
			await delay(50);
		}
		throw new Error(`Adopted worker ${observed.workerId} readiness timed out`);
	}

	private async stopObserved(target: PlacementLocation, observed: ObservedWorker) {
		try {
			await this.options.master.stop(target, observed.workerId, observed.identity);
		} catch (error) {
			this.emit('error', toError(error));
		}
	}

	private async launchRow(row: AssignmentRow, target: PlacementLocation) {
		this.requireHost(target);
		await this.waitForLaunchGate();
		const identity = { slot: `${row.worker.workerId}:${++this.identitySequence}`, token: randomUUID() };
		const launch = await this.options.createLaunch({
			worker: { ...row.worker },
			target: { ...target },
			identity: { ...identity },
			signal: this.lifecycleAbort?.signal ?? new AbortController().signal,
		});
		assertLaunch(row.worker, launch);
		row.state = 'launching';
		row.placement = { ...target };
		row.identity = identity;
		row.recovery = undefined;
		row.adopted = false;
		this.emitAssignment(row);
		const launchTask = this.options.master.launch(target, row.worker.workerId, identity, row.worker, launch);
		try {
			await withTimeout(
				launchTask,
				this.readinessTimeoutMs,
				`Worker ${row.worker.workerId} readiness`,
				this.lifecycleAbort?.signal,
			);
			row.state = 'routed';
			this.emitAssignment(row);
		} catch (error) {
			await this.options.master.stop(target, row.worker.workerId, identity).catch(() => undefined);
			void launchTask.catch(() => undefined);
			row.recovery = { placement: { ...target }, identity: { ...identity } };
			row.state = 'unassigned';
			row.placement = undefined;
			row.identity = undefined;
			this.emitAssignment(row);
			throw error;
		}
	}

	private async cleanupFailedStartup() {
		const failures: unknown[] = [];
		for (const row of this.assignmentTable.values()) {
			if (row.adopted || !row.placement || !row.identity) continue;
			try {
				await this.stopRow(row);
			} catch (error) {
				failures.push(error);
			}
		}
		return failures;
	}

	private async stopRow(row: AssignmentRow) {
		if (!row.placement || !row.identity) return;
		const placement = { ...row.placement };
		const identity = { ...row.identity };
		row.state = 'stopping';
		this.emitAssignment(row);
		await this.options.master.stop(placement, row.worker.workerId, identity);
		row.state = 'unassigned';
		row.placement = undefined;
		row.identity = undefined;
		row.recovery = undefined;
		this.emitAssignment(row);
	}

	private workerReady = (
		workerId: number,
		identity: AllocationIdentity,
		topology: LogicalWorker,
		target: PlacementLocation,
		restarted: boolean,
	) => {
		void this.enqueue(async () => {
			const row = this.assignmentTable.get(workerId);
			if (!row) return;
			if (!sameTopology(row.worker, topology)) {
				this.emit('stale', workerId, { ...identity });
				return;
			}
			if (row.placement && row.identity && sameIdentity(row.identity, identity)) return;
			if (
				row.recovery &&
				row.recovery.identity.slot === identity.slot &&
				sameLocation(row.recovery.placement, target)
			) {
				row.state = 'routed';
				row.placement = { ...target };
				row.identity = { ...identity };
				row.recovery = undefined;
				this.emitAssignment(row);
				return;
			}
			if (restarted) this.emit('stale', workerId, { ...identity });
		});
	};

	private workerExit = (
		workerId: number,
		identity: AllocationIdentity,
		_code: number | null,
		_signal: NodeJS.Signals | null,
		target: PlacementLocation,
	) => {
		void this.enqueue(async () => {
			const row = this.assignmentTable.get(workerId);
			if (!row?.identity || !sameIdentity(row.identity, identity) || !row.placement) return;
			row.recovery = { placement: { ...target }, identity: { ...identity } };
			row.state = 'unassigned';
			row.placement = undefined;
			row.identity = undefined;
			this.emitAssignment(row);
			this.emit('downtime', workerId, new Error(`Worker ${workerId} exited and is awaiting local respawn`));
		});
	};

	private workerMessage = (
		workerId: number,
		identity: AllocationIdentity,
		body: unknown,
		_target: PlacementLocation,
	) => {
		const row = this.assignmentTable.get(workerId);
		if (!row?.identity || !sameIdentity(row.identity, identity) || row.state !== 'routed') {
			this.emit('stale', workerId, { ...identity });
			return;
		}
		this.emit('workerMessage', workerId, body, { ...identity });
	};

	private hostDisconnected = (host: HostDescriptor) => {
		void this.enqueue(async () => {
			const lost: AssignmentRow[] = [];
			for (const row of this.assignmentTable.values()) {
				if (!row.placement || row.placement.hostId !== host.hostId || row.placement.bootId !== host.bootId) continue;
				row.recovery = { placement: { ...row.placement }, identity: { ...row.identity! } };
				row.state = 'unassigned';
				row.placement = undefined;
				row.identity = undefined;
				lost.push(row);
				this.emitAssignment(row);
				this.emit('downtime', row.worker.workerId, new Error(`Host ${host.hostId} is unreachable`));
			}
			if (!this.autoRePlaceOnHostLoss || this.stateValue !== 'running') return;
			for (const row of lost) {
				const target = this.chooseTarget(row.worker);
				if (!target) continue;
				try {
					await this.launchRow(row, target);
				} catch (error) {
					this.emit('error', toError(error));
				}
			}
		});
	};

	private hostSnapshot = (host: HostDescriptor, workers: readonly ObservedWorker[]) => {
		void this.enqueue(async () => {
			const target = location(host);
			for (const observed of workers) {
				if (!observed.ready) continue;
				const row = this.assignmentTable.get(observed.workerId);
				if (!row || !sameTopology(row.worker, observed.topology)) {
					await this.stopObserved(target, observed);
					continue;
				}
				const current =
					row.placement &&
					row.identity &&
					sameLocation(row.placement, target) &&
					sameIdentity(row.identity, observed.identity);
				if (current) continue;
				const recoverable =
					row.state === 'unassigned' &&
					row.recovery?.identity.slot === observed.identity.slot &&
					sameLocation(row.recovery.placement, target);
				if (recoverable) {
					row.state = 'routed';
					row.placement = { ...target };
					row.identity = { ...observed.identity };
					row.recovery = undefined;
					this.emitAssignment(row);
				} else {
					await this.stopObserved(target, observed);
				}
			}
		});
	};

	private async resolveWorkers(signal: AbortSignal) {
		const source = this.options.workers;
		const workers = 'resolveLogicalWorkers' in source ? await source.resolveLogicalWorkers(signal) : source;
		if (!workers.length) throw new Error('Scaler requires at least one logical worker');
		const ids = new Set<number>();
		for (const worker of workers) {
			if (ids.has(worker.workerId)) throw new Error(`Duplicate logical worker ${worker.workerId}`);
			if (
				!Number.isSafeInteger(worker.workerId) ||
				worker.workerId < 0 ||
				!Number.isSafeInteger(worker.shardStart) ||
				worker.shardStart < 0 ||
				!Number.isSafeInteger(worker.shardEnd) ||
				worker.shardEnd <= worker.shardStart ||
				!Number.isSafeInteger(worker.totalShards) ||
				worker.shardEnd > worker.totalShards
			) {
				throw new Error(`Logical worker ${worker.workerId} has invalid topology`);
			}
			ids.add(worker.workerId);
		}
		return [...workers].sort((left, right) => left.workerId - right.workerId);
	}

	private async waitForCapacity(deadline: number) {
		while (true) {
			await this.adoptAndClean();
			const unassigned = [...this.assignmentTable.values()].filter(row => row.state === 'unassigned').length;
			if (this.availableCapacity() >= unassigned) return;
			if (this.lifecycleAbort?.signal.aborted) throw this.lifecycleAbort.signal.reason;
			if (Date.now() >= deadline) throw new Error('Scaler startup timed out waiting for host capacity');
			await delay(50);
		}
	}

	private availableCapacity() {
		return [...this.options.master.hosts.values()].reduce(
			(total, host) => total + Math.max(0, host.descriptor.maxWorkers - host.observed.length),
			0,
		);
	}

	private planUnassigned(workers: readonly LogicalWorker[]) {
		return planPlacement({
			workers,
			hosts: [...this.options.master.hosts.values()],
			strategy: this.placementStrategy,
		});
	}

	private chooseTarget(worker: LogicalWorker): PlacementLocation | undefined {
		try {
			return this.planUnassigned([worker])[0];
		} catch {
			return undefined;
		}
	}

	private async placeUnassigned(rows: readonly AssignmentRow[]) {
		if (!rows.length) return;
		const placements = this.planUnassigned(rows.map(row => row.worker));
		const targets = new Map(placements.map(placement => [placement.workerId, placement]));
		for (const row of rows) {
			const target = targets.get(row.worker.workerId);
			if (!target) throw new Error(`No planned target is available for worker ${row.worker.workerId}`);
			row.recovery = undefined;
			await this.launchRow(row, target);
		}
	}

	private async reconcileUnassigned(rows: readonly AssignmentRow[]) {
		const failures: unknown[] = [];
		for (const row of rows) {
			const target = this.chooseTarget(row.worker);
			if (!target) {
				failures.push(new Error(`No host capacity is available for worker ${row.worker.workerId}`));
				continue;
			}
			row.recovery = undefined;
			try {
				await this.launchRow(row, target);
			} catch (error) {
				failures.push(error);
			}
		}
		if (failures.length) throw new AggregateError(failures, 'Failed to place every unassigned worker');
	}

	private requireHost(target: PlacementLocation) {
		const host = this.options.master.hosts.get(target.hostId);
		if (!host || host.descriptor.bootId !== target.bootId)
			throw new Error(`Host ${target.hostId}/${target.bootId} is unavailable`);
		return host;
	}

	private requireHostWithCapacity(target: PlacementLocation, exemptHostId?: string) {
		const host = this.requireHost(target);
		if (target.hostId !== exemptHostId && host.observed.length >= host.descriptor.maxWorkers) {
			throw new Error(`Host ${target.hostId} is at capacity`);
		}
		return host;
	}

	private requireRow(workerId: number) {
		const row = this.assignmentTable.get(workerId);
		if (!row) throw new Error(`Unknown logical worker ${workerId}`);
		return row;
	}

	private async waitForLaunchGate() {
		const signal = this.lifecycleAbort?.signal ?? new AbortController().signal;
		if (signal.aborted) throw signal.reason;
		const now = Date.now();
		if (this.nextLaunchAt > now) {
			await delay(this.nextLaunchAt - now, signal);
		}
		this.nextLaunchAt = Date.now() + LAUNCH_GATE_MS;
	}

	private enqueue<T>(task: () => Promise<T> | T): Promise<T> {
		const next = this.operation.then(task, task);
		this.operation = next.catch(() => undefined);
		return next;
	}

	private enqueueRunning<T>(task: () => Promise<T>) {
		if (this.stateValue !== 'running') return Promise.reject(new Error(`Scaler is ${this.stateValue}`));
		return this.enqueue(task);
	}

	private attachEvents() {
		if (this.eventsAttached) return;
		this.eventsAttached = true;
		this.options.master.on('workerReady', this.workerReady);
		this.options.master.on('workerExit', this.workerExit);
		this.options.master.on('workerMessage', this.workerMessage);
		this.options.master.on('hostDisconnected', this.hostDisconnected);
		this.options.master.on('hostSnapshot', this.hostSnapshot);
	}

	private detachEvents() {
		if (!this.eventsAttached) return;
		this.eventsAttached = false;
		this.options.master.off('workerReady', this.workerReady);
		this.options.master.off('workerExit', this.workerExit);
		this.options.master.off('workerMessage', this.workerMessage);
		this.options.master.off('hostDisconnected', this.hostDisconnected);
		this.options.master.off('hostSnapshot', this.hostSnapshot);
	}

	private transition(state: SeyfertScalerState) {
		if (this.stateValue === state) return;
		const previous = this.stateValue;
		this.stateValue = state;
		this.emit('state', state, previous);
	}

	private emitAssignment(row: AssignmentRow) {
		this.emit('assignment', snapshot(row));
	}
}

function snapshot(row: AssignmentRow): ScalerAssignment {
	const worker = { ...row.worker };
	if (row.state === 'unassigned' || !row.placement || !row.identity) return { state: 'unassigned', worker };
	return {
		state: row.state,
		worker,
		placement: { ...row.placement },
		identity: { ...row.identity },
	};
}

function assertLaunch(worker: LogicalWorker, launch: RemoteWorkerLaunch) {
	if (launch.workerData.resharding === true) {
		throw new Error('@slipher/scaler does not support workerData.resharding=true');
	}
	const expected = Array.from({ length: worker.shardEnd - worker.shardStart }, (_, index) => worker.shardStart + index);
	if (
		launch.workerData.workerId !== worker.workerId ||
		launch.workerData.totalShards !== worker.totalShards ||
		launch.workerData.mode !== 'clusters' ||
		launch.workerData.shards.length !== expected.length ||
		launch.workerData.shards.some((shard, index) => shard !== expected[index])
	) {
		throw new Error(`createLaunch returned WorkerData that does not match logical worker ${worker.workerId}`);
	}
}

function location(host: HostDescriptor): PlacementLocation {
	return { hostId: host.hostId, bootId: host.bootId };
}

function sameLocation(left: PlacementLocation, right: PlacementLocation) {
	return left.hostId === right.hostId && left.bootId === right.bootId;
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, label: string, signal?: AbortSignal) {
	if (signal?.aborted) {
		void promise.catch(() => undefined);
		throw signal.reason;
	}
	let timeout: NodeJS.Timeout | undefined;
	try {
		const timed = Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
			}),
		]);
		return await (signal ? raceSignal(timed, signal) : timed);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

function raceSignal<T>(promise: Promise<T>, signal: AbortSignal) {
	if (signal.aborted) return Promise.reject<T>(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const cleanup = () => signal.removeEventListener('abort', onAbort);
		const onAbort = () => {
			cleanup();
			reject(signal.reason);
		};
		signal.addEventListener('abort', onAbort, { once: true });
		promise.then(
			value => {
				cleanup();
				resolve(value);
			},
			error => {
				cleanup();
				reject(error);
			},
		);
	});
}
