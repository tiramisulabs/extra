import { LockAcquireError, type LockManager, type LockOptions } from '@slipher/locks';
import { CronExpression } from './cron';
import { type DurationInput, parseDuration } from './duration';
import { SchedulerEmitter } from './events';
import {
	ScheduledTask,
	type ScheduledTaskOptions,
	type ScheduledTaskStatus,
	type TaskLockKeyResolver,
	type TaskLockOptionsResolver,
	type TaskRunner,
} from './task';

export interface SchedulerOptions {
	autostart?: boolean;
	lock?: LockManager;
	lockKey?: TaskLockKeyResolver;
	lockOptions?: TaskLockOptionsResolver;
	now?: () => number;
	idGenerator?: () => string;
}

export class Scheduler extends SchedulerEmitter {
	private readonly tasks = new Map<string, ScheduledTask>();
	private readonly lock?: LockManager;
	private readonly lockKey?: TaskLockKeyResolver;
	private readonly lockOptions?: TaskLockOptionsResolver;
	private readonly now: () => number;
	private readonly idGenerator: () => string;
	private running: boolean;

	constructor(options: SchedulerOptions = {}) {
		super();
		this.running = options.autostart ?? true;
		this.lock = options.lock;
		this.lockKey = options.lockKey;
		this.lockOptions = options.lockOptions;
		this.now = options.now ?? Date.now;
		this.idGenerator = options.idGenerator ?? createTaskIdGenerator();
	}

	every(interval: DurationInput, runner: TaskRunner, options: ScheduledTaskOptions = {}): ScheduledTask {
		const task = new ScheduledTask(
			options.id ?? this.idGenerator(),
			'interval',
			runner,
			parseDuration(interval),
			options.lock ?? this.lock,
			options.lockKey ?? this.lockKey,
			options.lockOptions ?? this.lockOptions,
		);
		this.addTask(task, options.runImmediately ?? false);
		return task;
	}

	cron(expression: string | CronExpression, runner: TaskRunner, options: ScheduledTaskOptions = {}): ScheduledTask {
		const cron = typeof expression === 'string' ? new CronExpression(expression) : expression;
		const task = new ScheduledTask(
			options.id ?? this.idGenerator(),
			'cron',
			runner,
			cron,
			options.lock ?? this.lock,
			options.lockKey ?? this.lockKey,
			options.lockOptions ?? this.lockOptions,
		);
		this.addTask(task, options.runImmediately ?? false);
		return task;
	}

	start(id?: string): this {
		this.running = true;

		if (id) {
			const task = this.requireTask(id);
			task.status = 'scheduled';
			this.schedule(task, false);
			return this;
		}

		for (const task of this.tasks.values()) {
			task.status = 'scheduled';
			this.schedule(task, false);
		}
		return this;
	}

	pause(id?: string): this {
		if (id) {
			const task = this.requireTask(id);
			this.clearTimer(task);
			task.status = 'paused';
			return this;
		}

		this.running = false;
		for (const task of this.tasks.values()) {
			this.clearTimer(task);
			task.status = 'paused';
		}
		return this;
	}

	remove(id: string): boolean {
		const task = this.tasks.get(id);
		if (!task) return false;

		this.clearTimer(task);
		this.tasks.delete(id);
		this.emit('removed', task);
		return true;
	}

	clear(): void {
		for (const task of this.tasks.values()) this.clearTimer(task);
		this.tasks.clear();
	}

	get(id: string): ScheduledTask | undefined {
		return this.tasks.get(id);
	}

	list(): ScheduledTask[] {
		return [...this.tasks.values()];
	}

	private addTask(task: ScheduledTask, runImmediately: boolean): void {
		if (this.tasks.has(task.id)) throw new RangeError(`Scheduled task already exists: ${task.id}`);
		this.tasks.set(task.id, task);
		this.emit('scheduled', task);
		this.schedule(task, runImmediately);
	}

	private schedule(task: ScheduledTask, runImmediately: boolean): void {
		this.clearTimer(task);
		if (!this.running || task.status === 'paused') return;

		const delay = runImmediately ? 0 : this.getDelay(task);
		task.nextRunAt = new Date(this.now() + delay);
		task.status = 'scheduled';
		task.timer = setTimeout(() => void this.run(task), delay);
	}

	private async run(task: ScheduledTask): Promise<void> {
		if (!this.tasks.has(task.id)) return;

		try {
			await this.runLocked(task);
		} catch (error) {
			task.status = 'failed';
			task.lastError = error;
			this.emit('failed', task, error);
		} finally {
			if (this.tasks.has(task.id) && this.running && !isPaused(task.status)) this.schedule(task, false);
		}
	}

	private async runLocked(task: ScheduledTask): Promise<void> {
		if (!task.lock) return this.runTask(task);

		try {
			await task.lock.withLock(
				await this.resolveLockKey(task),
				() => this.runTask(task),
				await this.resolveLockOptions(task),
			);
		} catch (error) {
			if (!(error instanceof LockAcquireError)) throw error;
			task.status = 'scheduled';
			this.emit('skipped', task, error);
		}
	}

	private async runTask(task: ScheduledTask): Promise<void> {
		task.status = 'running';
		task.lastRunAt = new Date(this.now());
		task.runCount++;
		this.emit('started', task);

		try {
			await task.runner(task);
			task.status = 'completed';
			task.lastError = undefined;
			this.emit('completed', task);
		} catch (error) {
			task.status = 'failed';
			task.lastError = error;
			this.emit('failed', task, error);
		}
	}

	private async resolveLockKey(task: ScheduledTask): Promise<string> {
		if (typeof task.lockKey === 'function') return task.lockKey(task);
		return task.lockKey ?? `scheduler:${task.id}`;
	}

	private async resolveLockOptions(task: ScheduledTask): Promise<LockOptions> {
		if (typeof task.lockOptions === 'function') return task.lockOptions(task);
		return task.lockOptions ?? {};
	}

	private getDelay(task: ScheduledTask): number {
		if (typeof task.schedule === 'number') return task.schedule;
		return Math.max(task.schedule.next(new Date(this.now())).getTime() - this.now(), 0);
	}

	private clearTimer(task: ScheduledTask): void {
		if (!task.timer) return;
		clearTimeout(task.timer);
		task.timer = undefined;
	}

	private requireTask(id: string): ScheduledTask {
		const task = this.tasks.get(id);
		if (!task) throw new RangeError(`Scheduled task not found: ${id}`);
		return task;
	}
}

function createTaskIdGenerator() {
	let nextId = 0;
	return () => String(++nextId);
}

function isPaused(status: ScheduledTaskStatus): boolean {
	return status === 'paused';
}
