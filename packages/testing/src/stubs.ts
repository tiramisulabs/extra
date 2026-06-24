import { isAmbiguousQueueAddArgs, queueAddAmbiguityMessage } from '@slipher/internal';
import { mockId } from './id';

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

export type MockLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface MockLogEntry {
	level: MockLogLevel | 'add';
	args: unknown[];
}

export interface MockLogger extends LoggerLike {
	readonly currentContext: Readonly<Record<string, unknown>>;
	entries: MockLogEntry[];
	add(data: Record<string, unknown>): void;
	trace(...args: unknown[]): void;
	debug(...args: unknown[]): void;
	info(...args: unknown[]): void;
	warn(...args: unknown[]): void;
	error(...args: unknown[]): void;
	fatal(...args: unknown[]): void;
	child(): MockLogger;
	flush(): Promise<void>;
}

export interface MockQueueJob<TPayload = unknown, TResult = unknown, TName extends string = string>
	extends QueueJobLike<TPayload, TResult, TName> {
	id: string;
	name: TName;
	data: TPayload;
	payload: TPayload;
	options?: Record<string, unknown>;
}

export interface MockQueueEventMap<TPayload = unknown, TResult = unknown> {
	added: QueueEventMapLike<TPayload, TResult, MockQueueJob<TPayload, TResult>>['added'];
	active: QueueEventMapLike<TPayload, TResult, MockQueueJob<TPayload, TResult>>['active'];
	completed: QueueEventMapLike<TPayload, TResult, MockQueueJob<TPayload, TResult>>['completed'];
	failed: QueueEventMapLike<TPayload, TResult, MockQueueJob<TPayload, TResult>>['failed'];
	retrying: QueueEventMapLike<TPayload, TResult, MockQueueJob<TPayload, TResult>>['retrying'];
	idle: QueueEventMapLike<TPayload, TResult, MockQueueJob<TPayload, TResult>>['idle'];
}

export interface MockQueue<TPayload = unknown, TResult = unknown>
	extends QueueLike<TPayload, TResult, MockQueueJob<TPayload, TResult>> {
	name: string;
	jobs: MockQueueJob<TPayload, TResult>[];
	add<TJobPayload = unknown>(
		name: string,
		payload: TJobPayload,
		options?: Record<string, unknown>,
	): Promise<MockQueueJob<TJobPayload, TResult>>;
	add(payload: TPayload, options?: Record<string, unknown>): Promise<MockQueueJob<TPayload, TResult>>;
	on<TEvent extends keyof MockQueueEventMap<TPayload, TResult>>(
		event: TEvent,
		listener: (payload: MockQueueEventMap<TPayload, TResult>[TEvent]) => unknown,
	): () => void;
	once<TEvent extends keyof MockQueueEventMap<TPayload, TResult>>(
		event: TEvent,
		listener: (payload: MockQueueEventMap<TPayload, TResult>[TEvent]) => unknown,
	): () => void;
	off<TEvent extends keyof MockQueueEventMap<TPayload, TResult>>(
		event: TEvent,
		listener: (payload: MockQueueEventMap<TPayload, TResult>[TEvent]) => unknown,
	): void;
}

export interface MockQueues extends QueuesLike {
	queues: Map<string, MockQueue>;
	get<TPayload = unknown, TResult = unknown>(name: string, options?: unknown): MockQueue<TPayload, TResult>;
}

export interface MockScheduledTask {
	id: string;
	name: string;
	schedule: number | string;
	run: (task: MockScheduledTask) => unknown;
}

export interface MockScheduler extends SchedulerLike<MockScheduledTask> {
	tasks: MockScheduledTask[];
	add(name: string, schedule: number | string, run: (task: MockScheduledTask) => unknown): MockScheduledTask;
	interval(name: string, schedule: number | string, run: (task: MockScheduledTask) => unknown): MockScheduledTask;
	cron(name: string, schedule: string, run: (task: MockScheduledTask) => unknown): MockScheduledTask;
	on<TEvent extends keyof SchedulerEventMapLike<MockScheduledTask>>(
		event: TEvent,
		listener: (payload: SchedulerEventMapLike<MockScheduledTask>[TEvent]) => unknown,
	): () => void;
	once<TEvent extends keyof SchedulerEventMapLike<MockScheduledTask>>(
		event: TEvent,
		listener: (payload: SchedulerEventMapLike<MockScheduledTask>[TEvent]) => unknown,
	): () => void;
	off<TEvent extends keyof SchedulerEventMapLike<MockScheduledTask>>(
		event: TEvent,
		listener: (payload: SchedulerEventMapLike<MockScheduledTask>[TEvent]) => unknown,
	): void;
}

export interface MockClientOptions {
	logger?: MockLogger;
	queues?: MockQueues;
	scheduler?: MockScheduler;
	botId?: string;
	applicationId?: string;
	extra?: Record<string, unknown>;
}

export interface MockClient extends Record<string, unknown> {
	logger: MockLogger;
	queues: MockQueues;
	scheduler: MockScheduler;
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

export function mockLogger(): MockLogger {
	const entries: MockLogEntry[] = [];
	const context: Record<string, unknown> = {};
	const write =
		(level: MockLogLevel) =>
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

export function mockQueues(): MockQueues {
	const queues = new Map<string, MockQueue>();

	return {
		queues,
		get<TPayload = unknown, TResult = unknown>(name: string): MockQueue<TPayload, TResult> {
			let queue = queues.get(name) as MockQueue<TPayload, TResult> | undefined;
			if (!queue) {
				queue = {
					name,
					jobs: [],
					/**
					 * Runtime overload disambiguation for add uses maybeOptions plus
					 * @slipher/internal's isJobOptionsLike. The two-argument form
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
				queues.set(name, queue as MockQueue);
			}
			return queue;
		},
	};
}

export function mockScheduler(): MockScheduler {
	const tasks: MockScheduledTask[] = [];
	const add = (name: string, schedule: number | string, run: (task: MockScheduledTask) => unknown) => {
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

export function mockClient(options: MockClientOptions = {}): MockClient {
	return {
		logger: options.logger ?? mockLogger(),
		queues: options.queues ?? mockQueues(),
		scheduler: options.scheduler ?? mockScheduler(),
		botId: options.botId ?? 'slipher-test-bot',
		applicationId: options.applicationId ?? 'slipher-test-application',
		guilds: unavailableManager('guilds'),
		channels: unavailableManager('channels'),
		users: unavailableManager('users'),
		...options.extra,
	};
}
