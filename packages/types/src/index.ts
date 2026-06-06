export type Awaitable<T> = T | PromiseLike<T>;
export type DurationInputLike = number | string;
export type DataLike = Record<string, unknown>;

export type LoggerLevelMethod = (...args: readonly unknown[]) => Awaitable<void>;

export interface LoggerLike {
	readonly currentContext: Readonly<DataLike>;
	add(data: DataLike): this;
	trace: LoggerLevelMethod;
	debug: LoggerLevelMethod;
	info: LoggerLevelMethod;
	warn: LoggerLevelMethod;
	error: LoggerLevelMethod;
	fatal: LoggerLevelMethod;
	flush?(): Awaitable<void>;
}

export interface QueueJobOptionsLike extends DataLike {}

export interface QueueJobLike<TData = unknown, TResult = unknown, TName extends string = string> {
	readonly id?: string | number;
	readonly name: TName;
	/**
	 * Canonical job payload field. Consumers should read this first.
	 */
	readonly data?: TData;
	/**
	 * Compatibility alias for queue libraries that expose payload instead of data.
	 * When both are present, data takes precedence.
	 */
	readonly payload?: TData;
	readonly result?: TResult;
	readonly options?: QueueJobOptionsLike;
}

export interface QueueEventMapLike<TData, TResult, TJob extends QueueJobLike<TData, TResult>> {
	added: [job: TJob];
	active: [job: TJob];
	completed: [job: TJob, result: TResult];
	failed: [job: TJob, error: unknown];
	retrying: [job: TJob, error: unknown, delay: number];
	idle: [];
}

export type QueueListenerLike<TArgs extends readonly unknown[]> = (...args: TArgs) => Awaitable<void>;

export interface QueueLike<
	TData = unknown,
	TResult = unknown,
	TJob extends QueueJobLike<TData, TResult> = QueueJobLike<TData, TResult>,
> {
	readonly name: string;
	add<TJobData = TData>(
		name: string,
		data: TJobData,
		options?: QueueJobOptionsLike,
	): Awaitable<QueueJobLike<TJobData, TResult>>;
	add(data: TData, options?: QueueJobOptionsLike): Awaitable<TJob>;
	on<TEvent extends keyof QueueEventMapLike<TData, TResult, TJob>>(
		event: TEvent,
		listener: QueueListenerLike<QueueEventMapLike<TData, TResult, TJob>[TEvent]>,
	): () => void;
	off<TEvent extends keyof QueueEventMapLike<TData, TResult, TJob>>(
		event: TEvent,
		listener: QueueListenerLike<QueueEventMapLike<TData, TResult, TJob>[TEvent]>,
	): void;
}

export interface QueuesLike {
	get<TData = unknown, TResult = unknown>(name: string, options?: unknown): QueueLike<TData, TResult>;
	add?<TData = unknown, TResult = unknown>(
		queueName: string,
		name: string,
		data: TData,
		options?: QueueJobOptionsLike,
	): Awaitable<QueueJobLike<TData, TResult>>;
	add?<TData = unknown, TResult = unknown>(
		queueName: string,
		data: TData,
		options?: QueueJobOptionsLike,
	): Awaitable<QueueJobLike<TData, TResult>>;
	close?(): Awaitable<void>;
}

export type SchedulerRunnerLike<TTask = unknown> = (task: TTask) => Awaitable<unknown>;

export interface SchedulerEventMapLike<TTask = unknown> {
	scheduled: { task: TTask };
	started: { task: TTask };
	completed: { task: TTask; result: unknown };
	failed: { task: TTask; error: unknown };
	paused: { task: TTask };
	resumed: { task: TTask };
	removed: { task: TTask };
}

export interface SchedulerLike<TTask = unknown> {
	add(id: string, schedule: DurationInputLike, runner: SchedulerRunnerLike<TTask>, options?: DataLike): TTask;
	interval(id: string, schedule: DurationInputLike, runner: SchedulerRunnerLike<TTask>, options?: DataLike): TTask;
	cron(id: string, expression: string, runner: SchedulerRunnerLike<TTask>, options?: DataLike): TTask;
	on<TEvent extends keyof SchedulerEventMapLike<TTask>>(
		event: TEvent,
		listener: (payload: SchedulerEventMapLike<TTask>[TEvent]) => Awaitable<void>,
	): () => void;
	once<TEvent extends keyof SchedulerEventMapLike<TTask>>(
		event: TEvent,
		listener: (payload: SchedulerEventMapLike<TTask>[TEvent]) => Awaitable<void>,
	): () => void;
	pause?(id: string): Awaitable<void>;
	resume?(id: string): Awaitable<void>;
	remove?(id: string): Awaitable<void>;
}
