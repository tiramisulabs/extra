import { CronExpression } from './cron';
import { type DurationInput, parseDuration } from './duration';
import { SchedulerEmitter } from './events';
import { ScheduledTask, type ScheduledTaskOptions, type ScheduledTaskStatus, type TaskRunner } from './task';

export interface SchedulerOptions {
	autostart?: boolean;
	now?: () => number;
	idGenerator?: () => string;
}

export class Scheduler extends SchedulerEmitter {
	private readonly tasks = new Map<string, ScheduledTask>();
	private readonly now: () => number;
	private readonly idGenerator: () => string;
	private running: boolean;

	constructor(options: SchedulerOptions = {}) {
		super();
		this.running = options.autostart ?? true;
		this.now = options.now ?? Date.now;
		this.idGenerator = options.idGenerator ?? createTaskIdGenerator();
	}

	every(interval: DurationInput, runner: TaskRunner, options: ScheduledTaskOptions = {}): ScheduledTask {
		const task = new ScheduledTask(options.id ?? this.idGenerator(), 'interval', runner, parseDuration(interval));
		this.addTask(task, options.runImmediately ?? false);
		return task;
	}

	cron(expression: string | CronExpression, runner: TaskRunner, options: ScheduledTaskOptions = {}): ScheduledTask {
		const cron = typeof expression === 'string' ? new CronExpression(expression) : expression;
		const task = new ScheduledTask(options.id ?? this.idGenerator(), 'cron', runner, cron);
		this.addTask(task, options.runImmediately ?? false);
		return task;
	}

	start(id?: string): this {
		if (id) {
			const task = this.requireTask(id);
			task.status = 'scheduled';
			this.schedule(task, false);
			return this;
		}

		this.running = true;
		for (const task of this.tasks.values()) this.schedule(task, false);
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
		} finally {
			if (this.tasks.has(task.id) && this.running && !isPaused(task.status)) this.schedule(task, false);
		}
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
