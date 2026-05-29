import type { ScheduledTask } from './task';

export type SchedulerEventMap = {
	scheduled: [task: ScheduledTask];
	started: [task: ScheduledTask];
	completed: [task: ScheduledTask];
	failed: [task: ScheduledTask, error: unknown];
	skipped: [task: ScheduledTask, error: unknown];
	removed: [task: ScheduledTask];
};

export type SchedulerEventName = keyof SchedulerEventMap;
export type SchedulerListener<TArgs extends readonly unknown[]> = (...args: TArgs) => void;

export class SchedulerEmitter {
	private readonly listeners = new Map<SchedulerEventName, Set<SchedulerListener<readonly unknown[]>>>();

	on<TEvent extends SchedulerEventName>(
		event: TEvent,
		listener: SchedulerListener<SchedulerEventMap[TEvent]>,
	): () => void {
		const listeners = this.listeners.get(event) ?? new Set<SchedulerListener<readonly unknown[]>>();
		listeners.add(listener as SchedulerListener<readonly unknown[]>);
		this.listeners.set(event, listeners);

		return () => this.off(event, listener);
	}

	off<TEvent extends SchedulerEventName>(event: TEvent, listener: SchedulerListener<SchedulerEventMap[TEvent]>): void {
		this.listeners.get(event)?.delete(listener as SchedulerListener<readonly unknown[]>);
	}

	emit<TEvent extends SchedulerEventName>(event: TEvent, ...args: SchedulerEventMap[TEvent]): void {
		for (const listener of this.listeners.get(event) ?? []) listener(...args);
	}

	removeAllListeners(): void {
		this.listeners.clear();
	}
}
