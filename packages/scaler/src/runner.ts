import { type ChildProcess, type ForkOptions, fork, type Serializable } from 'node:child_process';
import { delay, nonNegativeMs, positiveMs } from './internal';
import type { AllocationIdentity, RemoteWorkerLaunch, ShardTopology } from './types';

export interface WorkerLaunchRequest {
	workerId: number;
	identity: AllocationIdentity;
	topology: ShardTopology;
	launch: RemoteWorkerLaunch;
}

export interface WorkerRunnerHooks {
	onMessage(message: unknown): void;
	onError(error: Error): void;
	onExit(code: number | null, signal: NodeJS.Signals | null): void;
}

export interface RunningWorker {
	readonly pid?: number;
	readonly exited: boolean;
	postMessage(message: unknown): Promise<void>;
	/** Close shards, allow in-flight handlers to settle, then terminate the process. */
	stop(graceful?: boolean): Promise<void>;
}

export interface WorkerRunner {
	spawn(request: WorkerLaunchRequest, hooks: WorkerRunnerHooks, signal?: AbortSignal): Promise<RunningWorker>;
}

/** @internal */
export type RunnerDisconnectAllShardsPayload = { type: 'DISCONNECT_ALL_SHARDS_RESHARDING' };

export interface ProcessWorkerRunnerOptions {
	modulePath?: string;
	resolveModulePath?: (request: WorkerLaunchRequest) => string;
	cwd?: string;
	execArgv?: string[];
	stdio?: 'ignore' | 'inherit' | 'pipe';
	/**
	 * Post-shard-close grace for microtasks and in-flight replies. Defaults to 1 second.
	 * Workers that need a longer drain must install a SIGTERM handler; the runner waits `killGraceMs` before SIGKILL.
	 */
	terminationGraceMs?: number;
	/** Time given to SIGTERM before SIGKILL. Defaults to 5 seconds. */
	killGraceMs?: number;
	/** Time allowed for Seyfert to acknowledge shard closure. Defaults to 5 seconds. */
	disconnectTimeoutMs?: number;
	/** @internal */
	fork?: typeof fork;
}

class ChildRunningWorker implements RunningWorker {
	private didExit = false;
	private stopping?: Promise<void>;
	private resolveExit!: () => void;
	private readonly exitPromise = new Promise<void>(resolve => (this.resolveExit = resolve));
	private resolveDisconnected?: () => void;

	constructor(
		private readonly child: ChildProcess,
		hooks: WorkerRunnerHooks,
		private readonly terminationGraceMs: number,
		private readonly killGraceMs: number,
		private readonly disconnectTimeoutMs: number,
	) {
		child.on('message', message => {
			if (isMessage(message, 'DISCONNECTED_ALL_SHARDS_RESHARDING')) this.resolveDisconnected?.();
			hooks.onMessage(message);
		});
	}

	get pid() {
		return this.child.pid;
	}

	get exited() {
		return this.didExit;
	}

	markExited() {
		if (this.didExit) return;
		this.didExit = true;
		this.resolveDisconnected?.();
		this.resolveExit();
	}

	async postMessage(message: unknown) {
		if (this.didExit || !this.child.connected) throw new Error('Worker IPC channel is closed');
		await new Promise<void>((resolve, reject) => {
			this.child.send(message as Serializable, error => (error ? reject(error) : resolve()));
		});
	}

	stop(graceful = true) {
		return (this.stopping ??= this.stopInternal(graceful));
	}

	private async stopInternal(graceful: boolean) {
		if (this.didExit) return;
		if (graceful && this.child.connected) {
			const disconnected = new Promise<void>(resolve => (this.resolveDisconnected = resolve));
			try {
				const disconnectAllShards: RunnerDisconnectAllShardsPayload = {
					type: 'DISCONNECT_ALL_SHARDS_RESHARDING',
				};
				await this.postMessage(disconnectAllShards);
				await waitFor(disconnected, this.disconnectTimeoutMs);
			} catch {
				// The process may have exited or closed IPC while disconnecting.
			}
			if (!this.didExit && this.terminationGraceMs > 0) await delay(this.terminationGraceMs);
		}
		if (this.didExit) return;
		this.child.kill('SIGTERM');
		if (await waitFor(this.exitPromise, this.killGraceMs)) return;
		this.child.kill('SIGKILL');
		if (!(await waitFor(this.exitPromise, this.killGraceMs))) {
			throw new Error(`Worker process ${this.child.pid ?? 'unknown'} did not exit after SIGKILL`);
		}
	}
}

export class ProcessWorkerRunner implements WorkerRunner {
	private readonly forkProcess: typeof fork;
	private readonly terminationGraceMs: number;
	private readonly killGraceMs: number;
	private readonly disconnectTimeoutMs: number;

	constructor(readonly options: ProcessWorkerRunnerOptions = {}) {
		this.forkProcess = options.fork ?? fork;
		this.terminationGraceMs = nonNegativeMs(options.terminationGraceMs ?? 1_000, 'terminationGraceMs');
		this.killGraceMs = positiveMs(options.killGraceMs ?? 5_000, 'killGraceMs');
		this.disconnectTimeoutMs = nonNegativeMs(options.disconnectTimeoutMs ?? 5_000, 'disconnectTimeoutMs');
	}

	async spawn(request: WorkerLaunchRequest, hooks: WorkerRunnerHooks, signal?: AbortSignal): Promise<RunningWorker> {
		if (signal?.aborted) throw abortError(signal);
		assertRequest(request);
		const stdio = this.options.stdio ?? 'inherit';
		const forkOptions: ForkOptions = {
			cwd: this.options.cwd,
			env: createEnvironment(request),
			execArgv: this.options.execArgv,
			serialization: 'advanced',
			stdio: [stdio, stdio, stdio, 'ipc'],
		};
		const child = this.forkProcess(this.resolveWorkerPath(request), [], forkOptions);
		if (stdio === 'pipe') {
			child.stdout?.resume();
			child.stderr?.resume();
		}
		const running = new ChildRunningWorker(
			child,
			hooks,
			this.terminationGraceMs,
			this.killGraceMs,
			this.disconnectTimeoutMs,
		);
		let reportedExit = false;
		const exited = (code: number | null, exitSignal: NodeJS.Signals | null) => {
			running.markExited();
			if (reportedExit) return;
			reportedExit = true;
			hooks.onExit(code, exitSignal);
		};
		child.once('exit', exited);
		child.once('close', exited);
		child.on('error', error => hooks.onError(error));

		const spawned = new Promise<void>((resolve, reject) => {
			child.once('spawn', resolve);
			child.once('error', reject);
		});
		const aborted = signal
			? new Promise<never>((_resolve, reject) => {
					const onAbort = () => {
						void running.stop(false).finally(() => reject(abortError(signal)));
					};
					signal.addEventListener('abort', onAbort, { once: true });
					spawned.finally(() => signal.removeEventListener('abort', onAbort)).catch(() => undefined);
				})
			: undefined;
		try {
			await Promise.race([spawned, ...(aborted ? [aborted] : [])]);
			if (signal?.aborted) throw abortError(signal);
			return running;
		} catch (error) {
			await running.stop(false).catch(killError => {
				throw new AggregateError([error, killError], 'Worker spawn failed and the child could not be stopped');
			});
			throw error;
		}
	}

	private resolveWorkerPath(request: WorkerLaunchRequest) {
		const path = this.options.resolveModulePath?.(request) ?? this.options.modulePath ?? request.launch.workerData.path;
		if (!path) throw new Error('ProcessWorkerRunner requires a worker module path');
		return path;
	}
}

function createEnvironment(request: WorkerLaunchRequest): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(request.launch.env ?? {})) {
		if (value !== undefined) environment[key] = encodeEnvironmentValue(value);
	}
	for (const [key, value] of Object.entries(request.launch.workerData)) {
		if (value !== undefined) environment[`SEYFERT_WORKER_${key.toUpperCase()}`] = encodeEnvironmentValue(value);
	}
	environment.SEYFERT_SPAWNING = 'true';
	environment.SEYFERT_WORKER_MODE = 'clusters';
	environment.SEYFERT_WORKER_WORKERID = String(request.workerId);
	environment.SEYFERT_WORKER_TOTALSHARDS = String(request.topology.totalShards);
	return environment;
}

function assertRequest(request: WorkerLaunchRequest) {
	if (!Number.isSafeInteger(request.workerId) || request.workerId < 0)
		throw new RangeError('workerId must be non-negative');
	if (!request.identity.slot || !request.identity.token) throw new TypeError('Worker identity cannot be empty');
	const expectedShards = Array.from(
		{ length: request.topology.shardEnd - request.topology.shardStart },
		(_, index) => request.topology.shardStart + index,
	);
	if (
		request.launch.workerData.workerId !== request.workerId ||
		request.launch.workerData.totalShards !== request.topology.totalShards ||
		request.launch.workerData.shards.length !== expectedShards.length ||
		request.launch.workerData.shards.some((shard, index) => shard !== expectedShards[index])
	) {
		throw new Error('WorkerData must match the assigned worker id and shard topology');
	}
}

function encodeEnvironmentValue(value: unknown) {
	return typeof value === 'string' ? value : JSON.stringify(value);
}

async function waitFor(promise: Promise<void>, timeoutMs: number) {
	if (timeoutMs === 0) return false;
	let timeout: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise.then(() => true),
			new Promise<false>(resolve => (timeout = setTimeout(() => resolve(false), timeoutMs))),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

function isMessage(value: unknown, type: string) {
	return typeof value === 'object' && value !== null && 'type' in value && value.type === type;
}

function abortError(signal: AbortSignal) {
	const error = new Error('Worker spawn aborted', { cause: signal.reason });
	error.name = 'AbortError';
	return error;
}
