import { type ChildProcess, fork } from 'node:child_process';
import { resolve } from 'node:path';
import type {
	ActionOutcome,
	InspectorSnapshot,
	JsonValue,
	LabAction,
	Preset,
	Session,
	SessionEvent,
	SessionLog,
	VisibleConversation,
} from '../index';
import {
	type BridgeRequest,
	isBridgeMessage,
	PROTOCOL_VERSION,
	type ProjectDescription,
	validateLabAction,
	validateProjectDescription,
} from '../protocol';

function workerPath(): string {
	try {
		return require.resolve('./worker');
	} catch {
		return require.resolve('../../lib/child/worker.js');
	}
}

function childError(message: string): Error {
	return new Error(
		message.includes('No seyfert.config file found.')
			? `${message} Run the CLI from the bot directory or pass --cwd <dir>.`
			: message,
	);
}

function childEnvironment(options: Omit<ChildSessionOptions, 'preset'>): NodeJS.ProcessEnv {
	if (options.inheritEnv !== false) return { ...process.env, ...options.env };
	const env: NodeJS.ProcessEnv = {};
	for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TZ', 'NODE_ENV', ...new Set(options.childEnv ?? [])]) {
		if (process.env[name] !== undefined) env[name] = process.env[name];
	}
	return { ...env, ...options.env };
}

export async function describeChildProject(options: Omit<ChildSessionOptions, 'preset'>): Promise<ProjectDescription> {
	const target = fork(workerPath(), [resolve(options.projectModule)], {
		cwd: options.cwd,
		execArgv: options.execArgv ?? process.execArgv,
		env: childEnvironment(options),
		stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
	});
	const timeoutMs = options.startTimeoutMs ?? 10000;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const exited = new Promise<void>(done => target.once('exit', () => done()));
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
			target.send({ version: PROTOCOL_VERSION, id: 1, type: 'project.describe' });
		});
		validateProjectDescription(result);
		return result;
	} finally {
		if (timer) clearTimeout(timer);
		if (target.exitCode === null && target.signalCode === null) target.kill('SIGTERM');
		let exitTimer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				exited,
				new Promise<void>(done => {
					exitTimer = setTimeout(done, options.disposeTimeoutMs ?? 1000);
				}),
			]);
		} finally {
			if (exitTimer) clearTimeout(exitTimer);
		}
		if (target.exitCode === null && target.signalCode === null) {
			target.kill('SIGKILL');
			await exited;
		}
	}
}

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
export function createChildSession(options: ChildSessionOptions): Session {
	if (options.rpcTimeoutMs !== undefined && (!Number.isSafeInteger(options.rpcTimeoutMs) || options.rpcTimeoutMs <= 0))
		throw new TypeError('rpcTimeoutMs must be a positive integer');
	let child: ChildProcess | undefined;
	let exitPromise: Promise<void> | undefined;
	let sequence = 0;
	let started = false;
	let intentionalExit = false;
	let stopping = false;
	let stopTask: Promise<void> | undefined;
	const listeners = new Set<(event: SessionEvent) => void>();
	const diagnostics: string[] = [];
	const pending = new Map<
		number,
		{ owner: ChildProcess; resolve(value: JsonValue): void; reject(error: Error): void }
	>();
	const emit = (event: SessionEvent) => {
		for (const listener of listeners) {
			try {
				listener(event);
			} catch (error) {
				const detail = `Observer failed: ${error instanceof Error ? error.message : String(error)}`;
				diagnostics.push(detail);
				if (event.type !== 'error' || event.origin !== 'observer')
					for (const other of listeners) {
						if (other === listener) continue;
						try {
							other({ type: 'error', origin: 'observer', detail });
						} catch (observerError) {
							diagnostics.push(
								`Observer failed: ${observerError instanceof Error ? observerError.message : String(observerError)}`,
							);
						}
					}
			}
		}
	};
	const rejectFor = (owner: ChildProcess, error: Error) => {
		for (const [id, waiter] of pending)
			if (waiter.owner === owner) {
				pending.delete(id);
				waiter.reject(error);
			}
	};
	const call = (type: BridgeRequest['type'], payload?: JsonValue, timeoutMs?: number): Promise<JsonValue> => {
		const target = child;
		if (!target?.connected) return Promise.reject(new Error('Child session is not running'));
		const id = ++sequence;
		const request = { version: PROTOCOL_VERSION, id, type, ...(payload === undefined ? {} : { payload }) };
		return new Promise<JsonValue>((resolveCall, rejectCall) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			pending.set(id, {
				owner: target,
				resolve(value) {
					if (timer) clearTimeout(timer);
					resolveCall(value);
				},
				reject(error) {
					if (timer) clearTimeout(timer);
					rejectCall(error);
				},
			});
			if (timeoutMs)
				timer = setTimeout(() => {
					const waiter = pending.get(id);
					if (waiter?.owner === target) {
						const error = new Error(`${type} timed out after ${timeoutMs}ms; external cleanup may be pending`);
						rejectFor(target, error);
						if (type !== 'session.start' && type !== 'session.dispose' && !stopping) {
							started = false;
							emit({ type: 'error', origin: 'child', detail: error.message });
							void stop().catch(cleanupError =>
								emit({
									type: 'error',
									origin: 'child',
									detail: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
								}),
							);
						}
					}
				}, timeoutMs);
			target.send(request, error => {
				if (error) {
					const waiter = pending.get(id);
					if (waiter?.owner === target) {
						pending.delete(id);
						waiter.reject(error);
					}
				}
			});
		});
	};
	const waitExit = async (target: ChildProcess, ms: number): Promise<void> => {
		const exit = exitPromise;
		if (!exit) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				exit,
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error(`Child exit timed out after ${ms}ms; external cleanup may be pending`)),
						ms,
					);
				}),
			]);
		} catch (error) {
			target.kill('SIGKILL');
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					exit,
					new Promise<never>((_, reject) => {
						killTimer = setTimeout(
							() => reject(new Error('Child did not exit after SIGKILL; external cleanup may be pending')),
							1000,
						);
					}),
				]);
			} finally {
				if (killTimer) clearTimeout(killTimer);
			}
			throw error;
		} finally {
			if (timer) clearTimeout(timer);
		}
	};
	const launch = async () => {
		if (child) throw new Error('Child session already started');
		intentionalExit = false;
		const target = fork(workerPath(), [resolve(options.projectModule), String(options.disposeTimeoutMs ?? 5000)], {
			cwd: options.cwd,
			execArgv: options.execArgv ?? process.execArgv,
			env: childEnvironment(options),
			stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
		});
		child = target;
		exitPromise = new Promise<void>(done => {
			target.once('exit', (code, signal) => {
				rejectFor(target, new Error(`Child exited (code ${code}, signal ${signal}); external cleanup may be pending`));
				if (child === target) {
					child = undefined;
					started = false;
					if (!intentionalExit)
						emit({
							type: 'error',
							origin: 'child',
							detail: `Child exited unexpectedly (code ${code}, signal ${signal}); external cleanup may be pending`,
						});
				}
				done();
			});
		});
		target.on('message', message => {
			if (child !== target) return;
			if (!isBridgeMessage(message)) {
				emit({ type: 'error', origin: 'child', detail: 'Invalid child protocol message' });
				return;
			}
			if (message.type === 'event') {
				emit(message.event as SessionEvent);
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
			rejectFor(target, error);
			if (child === target) emit({ type: 'error', origin: 'child', detail: error.message });
		});
		try {
			await call('session.start', options.preset as unknown as JsonValue, options.startTimeoutMs ?? 10000);
			started = true;
		} catch (error) {
			try {
				await stop();
			} catch (cleanupError) {
				throw new AggregateError(
					[error, cleanupError],
					`${error instanceof Error ? error.message : String(error)}; forced shutdown or cleanup failed; external cleanup may be pending`,
				);
			}
			throw error;
		}
	};
	const stop = (): Promise<void> => {
		if (stopTask) return stopTask;
		const target = child;
		if (!target) return Promise.resolve();
		stopping = true;
		started = false;
		intentionalExit = true;
		stopTask = (async () => {
			let cleanupError: unknown;
			try {
				await call('session.dispose', undefined, options.disposeTimeoutMs ?? 5000);
			} catch (error) {
				cleanupError = error;
				target.kill('SIGKILL');
			}
			try {
				await waitExit(target, options.disposeTimeoutMs ?? 5000);
			} catch (error) {
				cleanupError ??= error;
			}
			if (cleanupError) {
				emit({
					type: 'error',
					origin: 'child',
					detail: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
				});
				throw cleanupError;
			}
		})();
		return stopTask.finally(() => {
			stopTask = undefined;
			stopping = false;
		});
	};
	return {
		start: launch,
		dispose: stop,
		async reset() {
			if (!started) throw new Error('Child session is not started');
			await stop();
			await launch();
		},
		async act(action: LabAction): Promise<ActionOutcome> {
			if (!started) throw new Error('Child session is not started');
			validateLabAction(action);
			return (await call(
				'session.act',
				action as unknown as JsonValue,
				options.rpcTimeoutMs ?? 30000,
			)) as unknown as ActionOutcome;
		},
		observe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		async view(actor: string, channelRef: string): Promise<VisibleConversation> {
			return (await call(
				'session.view',
				{ actor, channelRef },
				options.rpcTimeoutMs ?? 30000,
			)) as unknown as VisibleConversation;
		},
		async inspect(): Promise<InspectorSnapshot> {
			const snapshot = (await call(
				'session.inspect',
				undefined,
				options.rpcTimeoutMs ?? 30000,
			)) as unknown as InspectorSnapshot;
			return { ...snapshot, diagnostics: [...snapshot.diagnostics, ...diagnostics] };
		},
		async describe() {
			return (await call('session.describe', undefined, options.rpcTimeoutMs ?? 30000)) as unknown as Awaited<
				ReturnType<Session['describe']>
			>;
		},
		async commandSchemas() {
			return (await call('session.commandSchemas', undefined, options.rpcTimeoutMs ?? 30000)) as unknown as Awaited<
				ReturnType<Session['commandSchemas']>
			>;
		},
		async inspectProject(name: string, args: JsonValue = null): Promise<JsonValue> {
			return await call('session.inspectProject', { name, args }, options.rpcTimeoutMs ?? 30000);
		},
		async log(): Promise<SessionLog> {
			return (await call('session.log', undefined, options.rpcTimeoutMs ?? 30000)) as unknown as SessionLog;
		},
	};
}
