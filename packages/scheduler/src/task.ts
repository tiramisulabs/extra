import type { LockManager, LockOptions } from '@slipher/locks';
import type { CronExpression } from './cron';

export type ScheduledTaskKind = 'interval' | 'cron';
export type ScheduledTaskStatus = 'scheduled' | 'running' | 'paused' | 'completed' | 'failed';

export type TaskRunner = (task: ScheduledTask) => unknown | Promise<unknown>;
export type TaskLockKeyResolver = string | ((task: ScheduledTask) => string | Promise<string>);
export type TaskLockOptionsResolver = LockOptions | ((task: ScheduledTask) => LockOptions | Promise<LockOptions>);

export interface ScheduledTaskOptions {
	id?: string;
	runImmediately?: boolean;
	lock?: LockManager;
	lockKey?: TaskLockKeyResolver;
	lockOptions?: TaskLockOptionsResolver;
}

export interface ScheduledTaskSnapshot {
	id: string;
	kind: ScheduledTaskKind;
	status: ScheduledTaskStatus;
	runCount: number;
	lastRunAt?: Date;
	nextRunAt?: Date;
	lastError?: unknown;
}

export class ScheduledTask {
	status: ScheduledTaskStatus = 'scheduled';
	runCount = 0;
	lastRunAt?: Date;
	nextRunAt?: Date;
	lastError?: unknown;
	timer?: NodeJS.Timeout;

	constructor(
		readonly id: string,
		readonly kind: ScheduledTaskKind,
		readonly runner: TaskRunner,
		readonly schedule: number | CronExpression,
		readonly lock?: LockManager,
		readonly lockKey?: TaskLockKeyResolver,
		readonly lockOptions?: TaskLockOptionsResolver,
	) {}

	snapshot(): ScheduledTaskSnapshot {
		return {
			id: this.id,
			kind: this.kind,
			status: this.status,
			runCount: this.runCount,
			lastRunAt: this.lastRunAt,
			nextRunAt: this.nextRunAt,
			lastError: this.lastError,
		};
	}
}
