export type Awaitable<T> = T | PromiseLike<T>;
export type DurationInputLike = number | string;
export type DataLike = Record<string, unknown>;

export type LoggerLevelMethod = (...args: readonly unknown[]) => Awaitable<void>;

export interface LoggerLike {
	readonly currentContext: Readonly<DataLike>;
	add(data: DataLike): void;
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
	readonly data?: TData;
	readonly payload?: TData;
	readonly result?: TResult;
	readonly options?: QueueJobOptionsLike;
}

export interface QueueEventMapLike<TData, TResult, TJob extends QueueJobLike<TData, TResult>> {
	added: { job: TJob };
	active: { job: TJob };
	completed: { job: TJob; result: TResult };
	failed: { job: TJob; error: unknown };
	retrying: { job: TJob; error: unknown; delay: number };
	idle: {};
}

export type QueueListenerLike<TPayload> = (payload: TPayload) => Awaitable<void>;

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
	once<TEvent extends keyof QueueEventMapLike<TData, TResult, TJob>>(
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

export interface SchedulerLike<TTask = unknown> {
	add(id: string, schedule: DurationInputLike, runner: SchedulerRunnerLike<TTask>, options?: DataLike): TTask;
}
