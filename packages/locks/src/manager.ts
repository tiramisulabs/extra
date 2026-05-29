import { randomUUID } from 'node:crypto';
import { type DurationInput, parseDuration } from './duration';
import { LockAbortError, LockAcquireError } from './errors';
import { type Awaitable, type LockStore, MemoryLockStore } from './store';

export interface LockOptions {
	ttl?: DurationInput;
	wait?: DurationInput;
	retryInterval?: DurationInput;
	signal?: AbortSignal;
}

export interface Lock {
	key: string;
	token: string;
	acquiredAt: Date;
	expiresAt: Date;
}

export interface LockManagerOptions {
	store?: LockStore;
	ttl?: DurationInput;
	retryInterval?: DurationInput;
	now?: () => number;
	tokenGenerator?: () => string;
}

export type LockRunner<TResult> = (lock: Lock) => Awaitable<TResult>;

export class LockManager {
	readonly store: LockStore;
	private readonly defaultTtl: DurationInput;
	private readonly defaultRetryInterval: DurationInput;
	private readonly now: () => number;
	private readonly tokenGenerator: () => string;

	constructor(options: LockManagerOptions = {}) {
		this.store = options.store ?? new MemoryLockStore();
		this.defaultTtl = options.ttl ?? '30s';
		this.defaultRetryInterval = options.retryInterval ?? '50ms';
		this.now = options.now ?? Date.now;
		this.tokenGenerator = options.tokenGenerator ?? randomUUID;
	}

	async acquire(key: string, options: LockOptions = {}): Promise<Lock> {
		const ttl = parseDuration(options.ttl ?? this.defaultTtl);
		const wait = typeof options.wait === 'undefined' ? 0 : parseDuration(options.wait);
		const retryInterval = parseDuration(options.retryInterval ?? this.defaultRetryInterval);
		const waitDeadline = Date.now() + wait;

		for (;;) {
			throwIfAborted(options.signal);

			const now = this.now();
			const token = this.tokenGenerator();
			const result = await this.store.acquire(key, token, ttl, now);

			if (result.acquired) {
				return {
					key,
					token,
					acquiredAt: new Date(now),
					expiresAt: new Date(result.expiresAt),
				};
			}

			const waitNow = Date.now();
			if (wait <= 0 || waitNow >= waitDeadline) {
				throw new LockAcquireError(key, wait > 0 ? 'timeout' : 'unavailable');
			}

			await delay(Math.min(retryInterval, Math.max(waitDeadline - waitNow, 0)), options.signal);
		}
	}

	release(lock: Lock): Promise<boolean> {
		return Promise.resolve(this.store.release(lock.key, lock.token));
	}

	async extend(lock: Lock, ttl: DurationInput = this.defaultTtl): Promise<boolean> {
		const now = this.now();
		const milliseconds = parseDuration(ttl);
		const extended = await this.store.extend(lock.key, lock.token, milliseconds, now);

		if (extended) lock.expiresAt = new Date(now + milliseconds);

		return extended;
	}

	async withLock<TResult>(key: string, runner: LockRunner<TResult>, options: LockOptions = {}): Promise<TResult> {
		const lock = await this.acquire(key, options);

		try {
			return await runner(lock);
		} finally {
			await this.release(lock);
		}
	}
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);

	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			cleanup();
			resolve();
		}, milliseconds);
		const onAbort = () => {
			clearTimeout(timeout);
			cleanup();
			reject(getAbortReason(signal));
		};
		const cleanup = () => {
			signal?.removeEventListener('abort', onAbort);
		};

		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	throw getAbortReason(signal);
}

function getAbortReason(signal?: AbortSignal): unknown {
	if (!signal) return new LockAbortError();
	const reason = signal.reason;
	if (reason instanceof Error) return reason;
	if (typeof reason === 'string') return new LockAbortError(reason);
	return new LockAbortError();
}
