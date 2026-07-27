import { mockId } from './id';
import { isAmbiguousQueueAddArgs, queueAddAmbiguityMessage } from './queue-options';

type Awaitable<T> = T | PromiseLike<T>;
type DurationInputLike = number | string;
type DataLike = Record<string, unknown>;

type LoggerLevelMethod = (...args: readonly unknown[]) => Awaitable<void>;

interface LoggerLike {
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

interface QueueJobOptionsLike extends DataLike {}

interface QueueJobLike<TData = unknown, TResult = unknown, TName extends string = string> {
	readonly id?: string | number;
	readonly name: TName;
	readonly data?: TData;
	readonly payload?: TData;
	readonly result?: TResult;
	readonly options?: QueueJobOptionsLike;
}

interface QueueEventMapLike<TData, TResult, TJob extends QueueJobLike<TData, TResult>> {
	added: { job: TJob };
	active: { job: TJob };
	completed: { job: TJob; result: TResult };
	failed: { job: TJob; error: unknown };
	retrying: { job: TJob; error: unknown; delay: number };
	idle: {};
}

type QueueListenerLike<TPayload> = (payload: TPayload) => Awaitable<void>;

interface QueueLike<
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

interface QueuesLike {
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

type SchedulerRunnerLike<TTask = unknown> = (task: TTask) => Awaitable<unknown>;

interface SchedulerEventMapLike<TTask = unknown> {
	scheduled: { task: TTask };
	started: { task: TTask };
	completed: { task: TTask; result: unknown };
	failed: { task: TTask; error: unknown };
	paused: { task: TTask };
	resumed: { task: TTask };
	removed: { task: TTask };
}

interface SchedulerLike<TTask = unknown> {
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

export type StubLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface StubLogEntry {
	level: StubLogLevel | 'add';
	args: unknown[];
}

export interface StubLogger extends LoggerLike {
	readonly currentContext: Readonly<Record<string, unknown>>;
	entries: StubLogEntry[];
	add(data: Record<string, unknown>): void;
	trace(...args: unknown[]): void;
	debug(...args: unknown[]): void;
	info(...args: unknown[]): void;
	warn(...args: unknown[]): void;
	error(...args: unknown[]): void;
	fatal(...args: unknown[]): void;
	child(): StubLogger;
	flush(): Promise<void>;
}

export interface StubQueueJob<TPayload = unknown, TResult = unknown, TName extends string = string>
	extends QueueJobLike<TPayload, TResult, TName> {
	id: string;
	name: TName;
	data: TPayload;
	payload: TPayload;
	options?: Record<string, unknown>;
}

export interface StubQueueEventMap<TPayload = unknown, TResult = unknown> {
	added: QueueEventMapLike<TPayload, TResult, StubQueueJob<TPayload, TResult>>['added'];
	active: QueueEventMapLike<TPayload, TResult, StubQueueJob<TPayload, TResult>>['active'];
	completed: QueueEventMapLike<TPayload, TResult, StubQueueJob<TPayload, TResult>>['completed'];
	failed: QueueEventMapLike<TPayload, TResult, StubQueueJob<TPayload, TResult>>['failed'];
	retrying: QueueEventMapLike<TPayload, TResult, StubQueueJob<TPayload, TResult>>['retrying'];
	idle: QueueEventMapLike<TPayload, TResult, StubQueueJob<TPayload, TResult>>['idle'];
}

export interface StubQueue<TPayload = unknown, TResult = unknown>
	extends QueueLike<TPayload, TResult, StubQueueJob<TPayload, TResult>> {
	name: string;
	jobs: StubQueueJob<TPayload, TResult>[];
	add<TJobPayload = unknown>(
		name: string,
		payload: TJobPayload,
		options?: Record<string, unknown>,
	): Promise<StubQueueJob<TJobPayload, TResult>>;
	add(payload: TPayload, options?: Record<string, unknown>): Promise<StubQueueJob<TPayload, TResult>>;
	on<TEvent extends keyof StubQueueEventMap<TPayload, TResult>>(
		event: TEvent,
		listener: (payload: StubQueueEventMap<TPayload, TResult>[TEvent]) => unknown,
	): () => void;
	once<TEvent extends keyof StubQueueEventMap<TPayload, TResult>>(
		event: TEvent,
		listener: (payload: StubQueueEventMap<TPayload, TResult>[TEvent]) => unknown,
	): () => void;
	off<TEvent extends keyof StubQueueEventMap<TPayload, TResult>>(
		event: TEvent,
		listener: (payload: StubQueueEventMap<TPayload, TResult>[TEvent]) => unknown,
	): void;
}

export interface StubQueues extends QueuesLike {
	queues: Map<string, StubQueue>;
	get<TPayload = unknown, TResult = unknown>(name: string, options?: unknown): StubQueue<TPayload, TResult>;
}

export interface StubScheduledTask {
	id: string;
	name: string;
	schedule: number | string;
	run: (task: StubScheduledTask) => unknown;
}

export interface StubScheduler extends SchedulerLike<StubScheduledTask> {
	tasks: StubScheduledTask[];
	add(name: string, schedule: number | string, run: (task: StubScheduledTask) => unknown): StubScheduledTask;
	interval(name: string, schedule: number | string, run: (task: StubScheduledTask) => unknown): StubScheduledTask;
	cron(name: string, schedule: string, run: (task: StubScheduledTask) => unknown): StubScheduledTask;
	on<TEvent extends keyof SchedulerEventMapLike<StubScheduledTask>>(
		event: TEvent,
		listener: (payload: SchedulerEventMapLike<StubScheduledTask>[TEvent]) => unknown,
	): () => void;
	once<TEvent extends keyof SchedulerEventMapLike<StubScheduledTask>>(
		event: TEvent,
		listener: (payload: SchedulerEventMapLike<StubScheduledTask>[TEvent]) => unknown,
	): () => void;
	off<TEvent extends keyof SchedulerEventMapLike<StubScheduledTask>>(
		event: TEvent,
		listener: (payload: SchedulerEventMapLike<StubScheduledTask>[TEvent]) => unknown,
	): void;
}

export interface StubClientOptions {
	logger?: StubLogger;
	queues?: StubQueues;
	scheduler?: StubScheduler;
	botId?: string;
	applicationId?: string;
	extra?: Record<string, unknown>;
}

export interface StubClient extends Record<string, unknown> {
	logger: StubLogger;
	queues: StubQueues;
	scheduler: StubScheduler;
	botId: string;
	applicationId: string;
	/** Entity managers that direct fetch flows to the bot harness (the light client resolves no entities). */
	guilds: { fetch(...args: unknown[]): never };
	channels: { fetch(...args: unknown[]): never };
	users: { fetch(...args: unknown[]): never };
}

/** A light-client manager whose calls fail loud with guidance instead of crashing on `undefined.fetch`. */
function unavailableManager(path: string): { fetch(...args: unknown[]): never } {
	const fail = (): never => {
		throw new TypeError(
			`ctx.client.${path} is not available on mockCommandContext (the light unit harness resolves no entities). ` +
				'For commands that fetch guilds/users/channels (or kick/ban), use createMockBot({ world, commands: [...] }).',
		);
	};
	return { fetch: fail };
}

export function stubLogger(): StubLogger {
	const entries: StubLogEntry[] = [];
	const context: Record<string, unknown> = {};
	const write =
		(level: StubLogLevel) =>
		(...args: unknown[]) => {
			entries.push({ level, args });
		};

	return {
		get currentContext() {
			return Object.freeze({ ...context });
		},
		entries,
		add(data) {
			Object.assign(context, data);
			entries.push({ level: 'add', args: [data] });
		},
		trace: write('trace'),
		debug: write('debug'),
		info: write('info'),
		warn: write('warn'),
		error: write('error'),
		fatal: write('fatal'),
		/**
		 * Returns this so child loggers share the parent entries array, keeping
		 * tests simple when code writes through parent and child loggers.
		 */
		child() {
			return this;
		},
		async flush() {},
	};
}

export function stubQueues(): StubQueues {
	const queues = new Map<string, StubQueue>();

	return {
		queues,
		get<TPayload = unknown, TResult = unknown>(name: string): StubQueue<TPayload, TResult> {
			let queue = queues.get(name) as StubQueue<TPayload, TResult> | undefined;
			if (!queue) {
				queue = {
					name,
					jobs: [],
					/**
					 * Runtime overload disambiguation for add uses maybeOptions plus
					 * isJobOptionsLike. The two-argument form
					 * add('send', { delay: '5s' }) is ambiguous, so it throws instead
					 * of guessing. Use add('send', { payload: true }, { delay: '5s' })
					 * to force name="send".
					 */
					async add(nameOrPayload: unknown, payloadOrOptions?: unknown, maybeOptions?: Record<string, unknown>) {
						if (isAmbiguousQueueAddArgs(nameOrPayload, payloadOrOptions, maybeOptions)) {
							throw new TypeError(queueAddAmbiguityMessage);
						}

						const hasJobName = typeof nameOrPayload === 'string' && payloadOrOptions !== undefined;
						const payload = (hasJobName ? payloadOrOptions : nameOrPayload) as TPayload;
						const job = {
							id: mockId(),
							data: payload,
							name: hasJobName ? nameOrPayload : 'default',
							options: (hasJobName ? maybeOptions : payloadOrOptions) as Record<string, unknown> | undefined,
							payload,
						};
						this.jobs.push(job);
						return job;
					},
					on() {
						return () => undefined;
					},
					once() {
						return () => undefined;
					},
					off() {},
				};
				queues.set(name, queue as StubQueue);
			}
			return queue;
		},
	};
}

export function stubScheduler(): StubScheduler {
	const tasks: StubScheduledTask[] = [];
	const add = (name: string, schedule: number | string, run: (task: StubScheduledTask) => unknown) => {
		const task = { id: mockId(), name, schedule, run };
		tasks.push(task);
		return task;
	};

	return {
		tasks,
		add,
		interval: add,
		cron: add,
		on() {
			return () => undefined;
		},
		once() {
			return () => undefined;
		},
		off() {},
	};
}

export function stubClient(options: StubClientOptions = {}): StubClient {
	return {
		logger: options.logger ?? stubLogger(),
		queues: options.queues ?? stubQueues(),
		scheduler: options.scheduler ?? stubScheduler(),
		botId: options.botId ?? 'slipher-test-bot',
		applicationId: options.applicationId ?? 'slipher-test-application',
		guilds: unavailableManager('guilds'),
		channels: unavailableManager('channels'),
		users: unavailableManager('users'),
		...options.extra,
	};
}
