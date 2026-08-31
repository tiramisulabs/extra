import { AsyncLocalStorage } from 'node:async_hooks';

interface TaskLease<T> {
	active: boolean;
	parent?: TaskLease<T>;
	value: T;
}

export function isThenable<T = unknown>(value: unknown): value is PromiseLike<T> {
	return (
		value !== null &&
		(typeof value === 'object' || typeof value === 'function') &&
		typeof (value as PromiseLike<T>).then === 'function'
	);
}

/** A reentrant task-local value whose detached descendants lose access. @internal */
export class TaskLocalScope<T> {
	#storage = new AsyncLocalStorage<TaskLease<T>>();

	run<R>(value: T, callback: () => R): R {
		const lease: TaskLease<T> = { active: true, parent: this.#storage.getStore(), value };
		let result: R;
		try {
			result = this.#storage.run(lease, callback);
		} catch (error) {
			lease.active = false;
			throw error;
		}
		if (isThenable(result)) {
			void Promise.resolve(result).then(
				() => {
					lease.active = false;
				},
				() => {
					lease.active = false;
				},
			);
		} else {
			lease.active = false;
		}
		return result;
	}

	get(): T | undefined {
		let lease = this.#storage.getStore();
		const current = lease;
		while (lease) {
			if (!lease.active) return;
			lease = lease.parent;
		}
		return current?.value;
	}
}
