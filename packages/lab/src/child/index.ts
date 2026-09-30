import { type ChildProcess, fork } from 'node:child_process';
import { resolve } from 'node:path';
import type { JsonValue, Preset, Session } from '../index';
import {
	type BridgeRequest,
	isBridgeMessage,
	PROTOCOL_VERSION,
	type ProjectDescription,
	validateLabAction,
	validateProjectDescription,
} from '../protocol';
import { createObservers, errorText } from '../shared';

const DEFAULT_START_TIMEOUT_MS = 10000;
const DEFAULT_DISPOSE_TIMEOUT_MS = 5000;
const DEFAULT_RPC_TIMEOUT_MS = 30000;
const DESCRIBE_EXIT_TIMEOUT_MS = 1000;
const SIGKILL_EXIT_TIMEOUT_MS = 1000;
// The worker closes the bot and then disposes resources, each under its own dispose deadline.
const disposeRpcTimeout = (disposeTimeoutMs: number) => 2 * disposeTimeoutMs + 250;
/** Variables a child without the inherited environment still receives. */
const BASE_CHILD_ENV = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TZ', 'NODE_ENV'];

export interface ChildSessionOptions {
	projectModule: string;
	preset: Preset;
	cwd?: string;
	execArgv?: string[];
	env?: Record<string, string>;
	inheritEnv?: boolean;
	childEnv?: string[];
	startTimeoutMs?: number;
	disposeTimeoutMs?: number;
	rpcTimeoutMs?: number;
}
type ProcessOptions = Omit<ChildSessionOptions, 'preset'>;

function workerPath(): string {
	try {
		return require.resolve('./worker');
	} catch {
		// Running from sources (tests): use the compiled worker.
		return require.resolve('../../lib/child/worker.js');
	}
}

function forkWorker(options: ProcessOptions, args: string[], stdin: 'ignore' | 'inherit'): ChildProcess {
	return fork(workerPath(), [resolve(options.projectModule), ...args], {
		cwd: options.cwd,
		execArgv: options.execArgv ?? process.execArgv,
		env: childEnvironment(options),
		stdio: [stdin, 'inherit', 'inherit', 'ipc'],
	});
}

function childEnvironment(options: ProcessOptions): NodeJS.ProcessEnv {
	if (options.inheritEnv !== false) return { ...process.env, ...options.env };
	const env: NodeJS.ProcessEnv = {};
	for (const name of new Set([...BASE_CHILD_ENV, ...(options.childEnv ?? [])]))
		if (process.env[name] !== undefined) env[name] = process.env[name];
	return { ...env, ...options.env };
}

function childError(message: string): Error {
	return new Error(
		message.includes('No seyfert.config file found.')
			? `${message} Run the CLI from the bot directory or pass --cwd <dir>.`
			: message,
	);
}

/** Resolves whether `exited` settles within `ms`. */
async function exitsWithin(exited: Promise<void>, ms: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			exited.then(() => true),
			new Promise<boolean>(done => {
				timer = setTimeout(done, ms, false);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** Loads the project in a short-lived child and returns its description; no scenario hook runs. */
export async function describeChildProject(options: ProcessOptions): Promise<ProjectDescription> {
	const target = forkWorker(options, [], 'ignore');
	const exited = new Promise<void>(done => target.once('exit', () => done()));
	const timeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const result = await new Promise<JsonValue>((done, reject) => {
			timer = setTimeout(() => reject(new Error(`project.describe timed out after ${timeoutMs}ms`)), timeoutMs);
			target.once('error', reject);
			target.once('exit', (code, signal) =>
				reject(new Error(`Describe child exited (code ${code}, signal ${signal})`)),
			);
			target.on('message', message => {
				if (!isBridgeMessage(message) || message.type !== 'result' || message.id !== 1) return;
				if (message.ok) done(message.value ?? null);
				else reject(childError(message.error ?? 'Child operation failed'));
			});
			target.send({ version: PROTOCOL_VERSION, id: 1, type: 'project.describe' } satisfies BridgeRequest);
		});
		validateProjectDescription(result);
		return result;
	} finally {
		clearTimeout(timer);
		if (target.exitCode === null && target.signalCode === null) target.kill('SIGTERM');
		if (!(await exitsWithin(exited, options.disposeTimeoutMs ?? DESCRIBE_EXIT_TIMEOUT_MS))) {
			target.kill('SIGKILL');
			await exited;
		}
	}
}

/** One forked worker. `ready` turns true once its session started, and false again when it stops being usable. */
interface Worker {
	process: ChildProcess;
	exited: Promise<void>;
	ready: boolean;
	/** Set when the host asked the worker to stop, so its exit is not reported as a crash. */
	stopping: boolean;
}

interface PendingCall {
	owner: ChildProcess;
	resolve(value: JsonValue): void;
	reject(error: Error): void;
}

/** Runs the Session API in a forked process; see the package README for timeouts and module formats. */
export function createChildSession(options: ChildSessionOptions): Session {
	if (options.rpcTimeoutMs !== undefined && (!Number.isSafeInteger(options.rpcTimeoutMs) || options.rpcTimeoutMs <= 0))
		throw new TypeError('rpcTimeoutMs must be a positive integer');
	const rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
	const disposeTimeoutMs = options.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS;
	const observers = createObservers();
	const { emit } = observers;
	const pending = new Map<number, PendingCall>();
	let worker: Worker | undefined;
	let sequence = 0;
	let stopTask: Promise<void> | undefined;

	const reportChildError = (detail: string) => emit({ type: 'error', origin: 'child', detail });

	const rejectCallsTo = (owner: ChildProcess, error: Error) => {
		for (const [id, call] of pending)
			if (call.owner === owner) {
				pending.delete(id);
				call.reject(error);
			}
	};

	/** A timed-out call leaves the worker in an unknown state: fail everything waiting on it and stop it. */
	const onCallTimeout = (target: ChildProcess, type: BridgeRequest['type'], timeoutMs: number) => {
		const error = new Error(`${type} timed out after ${timeoutMs}ms; external cleanup may be pending`);
		rejectCallsTo(target, error);
		// Start and dispose timeouts are handled by their callers, which already stop the worker.
		if (type === 'session.start' || type === 'session.dispose' || stopTask) return;
		if (worker) worker.ready = false;
		reportChildError(error.message);
		void stop().catch(cleanupError => reportChildError(errorText(cleanupError)));
	};

	const call = (type: BridgeRequest['type'], payload: unknown, timeoutMs: number): Promise<JsonValue> => {
		const target = worker?.process;
		if (!target?.connected) return Promise.reject(new Error('Child session is not running'));
		const id = ++sequence;
		return new Promise<JsonValue>((resolveCall, rejectCall) => {
			const timer = setTimeout(() => {
				if (pending.get(id)?.owner === target) onCallTimeout(target, type, timeoutMs);
			}, timeoutMs);
			pending.set(id, {
				owner: target,
				resolve(value) {
					clearTimeout(timer);
					resolveCall(value);
				},
				reject(error) {
					clearTimeout(timer);
					rejectCall(error);
				},
			});
			// The worker validates every request, so the payload is not re-checked here.
			target.send({ version: PROTOCOL_VERSION, id, type, ...(payload === undefined ? {} : { payload }) }, error => {
				const waiter = pending.get(id);
				if (!error || waiter?.owner !== target) return;
				pending.delete(id);
				waiter.reject(error);
			});
		});
	};

	/** Calls a session method in the worker. Results are produced by the worker's own Session, so they are trusted. */
	const rpc = async <T>(type: BridgeRequest['type'], payload?: unknown): Promise<T> =>
		(await call(type, payload, rpcTimeoutMs)) as T;

	const requireReady = () => {
		if (!worker?.ready) throw new Error('Child session is not started');
	};

	const waitForExit = async (current: Worker): Promise<void> => {
		if (await exitsWithin(current.exited, disposeTimeoutMs)) return;
		current.process.kill('SIGKILL');
		if (!(await exitsWithin(current.exited, SIGKILL_EXIT_TIMEOUT_MS)))
			throw new Error('Child did not exit after SIGKILL; external cleanup may be pending');
		throw new Error(`Child exit timed out after ${disposeTimeoutMs}ms; external cleanup may be pending`);
	};

	const spawn = (): Worker => {
		const target = forkWorker(options, [String(disposeTimeoutMs)], 'inherit');
		const current: Worker = {
			process: target,
			ready: false,
			stopping: false,
			exited: new Promise<void>(done => {
				target.once('exit', (code, signal) => {
					rejectCallsTo(
						target,
						new Error(`Child exited (code ${code}, signal ${signal}); external cleanup may be pending`),
					);
					if (worker === current) {
						worker = undefined;
						if (!current.stopping)
							reportChildError(
								`Child exited unexpectedly (code ${code}, signal ${signal}); external cleanup may be pending`,
							);
					}
					done();
				});
			}),
		};
		target.on('message', message => {
			if (worker !== current) return;
			if (!isBridgeMessage(message)) {
				reportChildError('Invalid child protocol message');
				return;
			}
			if (message.type === 'event') {
				emit(message.event);
				return;
			}
			if (message.type !== 'result') return;
			const waiter = pending.get(message.id);
			if (!waiter || waiter.owner !== target) return;
			pending.delete(message.id);
			if (message.ok) waiter.resolve(message.value ?? null);
			else waiter.reject(childError(message.error ?? 'Child operation failed'));
		});
		target.on('error', error => {
			rejectCallsTo(target, error);
			if (worker === current) reportChildError(error.message);
		});
		return current;
	};

	const start = async () => {
		if (worker) throw new Error('Child session already started');
		const current = spawn();
		worker = current;
		try {
			await call('session.start', options.preset, options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);
			current.ready = true;
		} catch (error) {
			try {
				await stop();
			} catch (cleanupError) {
				throw new AggregateError(
					[error, cleanupError],
					`${errorText(error)}; forced shutdown or cleanup failed; external cleanup may be pending`,
				);
			}
			throw error;
		}
	};

	const stop = (): Promise<void> => {
		if (stopTask) return stopTask;
		const current = worker;
		if (!current) return Promise.resolve();
		current.ready = false;
		current.stopping = true;
		stopTask = (async () => {
			let cleanupError: unknown;
			try {
				await call('session.dispose', undefined, disposeRpcTimeout(disposeTimeoutMs));
			} catch (error) {
				cleanupError = error;
				current.process.kill('SIGKILL');
			}
			try {
				await waitForExit(current);
			} catch (error) {
				cleanupError ??= error;
			}
			if (cleanupError) {
				reportChildError(errorText(cleanupError));
				throw cleanupError;
			}
		})().finally(() => {
			stopTask = undefined;
		});
		return stopTask;
	};

	return {
		start,
		dispose: stop,
		async reset() {
			requireReady();
			await stop();
			await start();
		},
		async act(action) {
			requireReady();
			validateLabAction(action);
			return rpc('session.act', action);
		},
		observe: observers.observe,
		view: (actor, channelRef) => rpc('session.view', { actor, channelRef }),
		async inspect() {
			const snapshot = await rpc<Awaited<ReturnType<Session['inspect']>>>('session.inspect');
			return { ...snapshot, diagnostics: [...snapshot.diagnostics, ...observers.diagnostics] };
		},
		describe: () => rpc('session.describe'),
		commandSchemas: () => rpc('session.commandSchemas'),
		inspectProject: (name, args = null) => rpc('session.inspectProject', { name, args }),
		log: () => rpc('session.log'),
	};
}
