export type JobStatus = 'waiting' | 'delayed' | 'active' | 'completed' | 'failed';

export interface JobOptions {
	id?: string;
	delay?: number | string;
	attempts?: number;
	priority?: number;
}

export interface JobSnapshot<TData, TResult = unknown> {
	id: string;
	data: TData;
	status: JobStatus;
	priority: number;
	attemptsMade: number;
	maxAttempts: number;
	createdAt: Date;
	updatedAt: Date;
	runAt: Date;
	result?: TResult;
	error?: unknown;
}

export class Job<TData, TResult = unknown> {
	status: JobStatus;
	attemptsMade = 0;
	updatedAt: Date;
	runAt: Date;
	result?: TResult;
	error?: unknown;

	constructor(
		readonly id: string,
		readonly data: TData,
		readonly maxAttempts: number,
		readonly priority: number,
		readonly createdAt: Date,
		runAt: Date,
	) {
		this.runAt = runAt;
		this.updatedAt = createdAt;
		this.status = runAt.getTime() > createdAt.getTime() ? 'delayed' : 'waiting';
	}

	snapshot(): JobSnapshot<TData, TResult> {
		return {
			id: this.id,
			data: this.data,
			status: this.status,
			priority: this.priority,
			attemptsMade: this.attemptsMade,
			maxAttempts: this.maxAttempts,
			createdAt: this.createdAt,
			updatedAt: this.updatedAt,
			runAt: this.runAt,
			result: this.result,
			error: this.error,
		};
	}
}
