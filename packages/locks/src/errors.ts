export type LockAcquireFailure = 'unavailable' | 'timeout';

export class LockAcquireError extends Error {
	readonly key: string;
	readonly reason: LockAcquireFailure;

	constructor(key: string, reason: LockAcquireFailure) {
		super(`Unable to acquire lock "${key}": ${reason}.`);
		this.name = 'LockAcquireError';
		this.key = key;
		this.reason = reason;
	}
}

export class LockAbortError extends Error {
	constructor(message = 'Lock acquisition aborted.') {
		super(message);
		this.name = 'LockAbortError';
	}
}
