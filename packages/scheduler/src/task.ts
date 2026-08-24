import type { ScheduledTaskDefinition, ScheduledTaskSnapshot, ScheduledTaskStatus, SchedulerHost } from './types';

export class ScheduledTask {
	readonly createdAt = new Date();
	readonly data?: Record<string, unknown>;
	lastError?: unknown;
	lastRunAt?: Date;
	nextRunAt?: Date;
	runCount = 0;
	status: ScheduledTaskStatus = 'scheduled';

	constructor(readonly definition: ScheduledTaskDefinition) {
		this.data = definition.data;
	}

	get id() {
		return this.definition.id;
	}

	get kind() {
		return this.definition.kind;
	}

	get expression() {
		return this.definition.expression;
	}

	get intervalMs() {
		return this.definition.intervalMs;
	}

	get overlap() {
		return this.definition.overlap ?? 'allow';
	}

	get runner() {
		return this.definition.runner;
	}

	get runImmediately() {
		return this.definition.runImmediately === true;
	}

	get timezone() {
		return this.definition.timezone;
	}

	snapshot(): ScheduledTaskSnapshot {
		return {
			id: this.id,
			kind: this.kind,
			status: this.status,
			expression: this.expression,
			intervalMs: this.intervalMs,
			overlap: this.overlap,
			timezone: this.timezone,
			runCount: this.runCount,
			createdAt: this.createdAt,
			lastRunAt: this.lastRunAt,
			nextRunAt: this.nextRunAt,
			lastError: this.lastError,
			data: this.data,
		};
	}
}

export async function runTask(
	task: ScheduledTask,
	host?: SchedulerHost,
	nextRun?: () => Date | null | undefined,
	options: { alreadyStarted?: boolean } = {},
) {
	if (!options.alreadyStarted) {
		task.status = 'running';
		task.runCount += 1;
		task.lastRunAt = new Date();
		task.lastError = undefined;
		host?.emit('started', { task });
	}

	try {
		const result = await task.runner(task);
		task.status = 'completed';
		task.nextRunAt = nextRun?.() ?? undefined;
		host?.emit('completed', { task, result });

		return result;
	} catch (error) {
		task.status = 'failed';
		task.lastError = error;
		task.nextRunAt = nextRun?.() ?? undefined;
		host?.emit('failed', { task, error });
		throw error;
	}
}
