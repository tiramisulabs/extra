import { AsyncLocalStorage } from 'node:async_hooks';
import { isThenable } from './task-local-scope';

interface ExecutionLease {
	active: boolean;
	parent?: ExecutionLease;
}

type MutationResult<T> = T | Promise<T>;

function uniqueSorted(values: readonly string[]): string[] {
	return [...new Set(values)].sort();
}

/** Per-adapter sync/async mutation serialization. @internal */
export class LocalMutationBoundary {
	#active = new Set<Promise<void>>();
	#barrierTail = Promise.resolve();
	#epoch = 0;
	#execution = new AsyncLocalStorage<ExecutionLease>();
	#syncExecuting = false;
	#tails = new Map<string, Promise<void>>();

	constructor(private readonly async: boolean) {}

	preflight(): void {
		this.assertNotReentrant();
	}

	run<T>(tokens: readonly string[], operation: () => T | PromiseLike<T>): MutationResult<T> {
		this.assertNotReentrant();
		this.#epoch++;
		if (!this.async) {
			this.#syncExecuting = true;
			try {
				const result = operation();
				if (isThenable(result)) {
					void Promise.resolve(result).then(
						() => undefined,
						() => undefined,
					);
					throw new TypeError('A synchronous cache adapter returned a thenable from a mutation method.');
				}
				return result;
			} finally {
				this.#syncExecuting = false;
			}
		}

		const locks = uniqueSorted(tokens);
		const prior = Promise.all([this.#barrierTail, ...locks.map(lock => this.#tails.get(lock) ?? Promise.resolve())]);
		let release!: () => void;
		const tail = new Promise<void>(resolve => {
			release = resolve;
		});
		for (const lock of locks) this.#tails.set(lock, tail);

		const result = prior.then(() => this.executeAsync(operation));
		const settled = result.then(
			() => undefined,
			() => undefined,
		);
		this.#active.add(settled);
		void settled.then(() => {
			release();
			for (const lock of locks) {
				if (this.#tails.get(lock) === tail) this.#tails.delete(lock);
			}
			this.#active.delete(settled);
		});
		return result;
	}

	flush<T>(operation: () => T | PromiseLike<T>): MutationResult<T> {
		if (!this.async) return this.run([], operation);
		this.assertNotReentrant();
		this.#epoch++;

		const prior = Promise.all([this.#barrierTail, ...this.#active]);
		let release!: () => void;
		const tail = new Promise<void>(resolve => {
			release = resolve;
		});
		this.#barrierTail = tail;
		const result = prior.then(() => this.executeAsync(operation));
		const settled = result.then(
			() => undefined,
			() => undefined,
		);
		this.#active.add(settled);
		void settled.then(() => {
			release();
			this.#active.delete(settled);
		});
		return result;
	}

	async waitForIdle(): Promise<void> {
		for (;;) {
			const epoch = this.#epoch;
			await Promise.all([...this.#active]);
			await Promise.resolve();
			if (this.#active.size === 0 && this.#epoch === epoch) return;
		}
	}

	private assertNotReentrant(): void {
		if (this.#syncExecuting) throw new Error('Reentrant cache adapter mutations are not supported.');
		let lease = this.#execution.getStore();
		while (lease) {
			if (lease.active) throw new Error('Reentrant cache adapter mutations are not supported.');
			lease = lease.parent;
		}
	}

	private executeAsync<T>(operation: () => T | PromiseLike<T>): Promise<T> {
		const lease: ExecutionLease = { active: true, parent: this.#execution.getStore() };
		return this.#execution.run(lease, async () => {
			try {
				return await operation();
			} finally {
				lease.active = false;
			}
		});
	}
}
