import type { Job } from './job';

export type QueueEventMap<TData, TResult> = {
	added: [job: Job<TData, TResult>];
	active: [job: Job<TData, TResult>];
	completed: [job: Job<TData, TResult>, result: TResult];
	failed: [job: Job<TData, TResult>, error: unknown];
	retrying: [job: Job<TData, TResult>, error: unknown, delay: number];
	idle: [];
};

export type QueueEventName = keyof QueueEventMap<unknown, unknown>;
export type QueueListener<TArgs extends readonly unknown[]> = (...args: TArgs) => void;

export class QueueEmitter<TData, TResult> {
	private readonly listeners = new Map<QueueEventName, Set<QueueListener<readonly unknown[]>>>();

	on<TEvent extends keyof QueueEventMap<TData, TResult>>(
		event: TEvent,
		listener: QueueListener<QueueEventMap<TData, TResult>[TEvent]>,
	): () => void {
		const listeners = this.listeners.get(event) ?? new Set<QueueListener<readonly unknown[]>>();
		listeners.add(listener as QueueListener<readonly unknown[]>);
		this.listeners.set(event, listeners);

		return () => this.off(event, listener);
	}

	off<TEvent extends keyof QueueEventMap<TData, TResult>>(
		event: TEvent,
		listener: QueueListener<QueueEventMap<TData, TResult>[TEvent]>,
	): void {
		this.listeners.get(event)?.delete(listener as QueueListener<readonly unknown[]>);
	}

	emit<TEvent extends keyof QueueEventMap<TData, TResult>>(
		event: TEvent,
		...args: QueueEventMap<TData, TResult>[TEvent]
	): void {
		for (const listener of this.listeners.get(event) ?? []) listener(...args);
	}

	removeAllListeners(): void {
		this.listeners.clear();
	}
}
