import type {
	LoggerLike,
	QueueEventMapLike,
	QueueJobLike,
	QueueLike,
	QueuesLike,
	SchedulerEventMapLike,
	SchedulerLike,
} from '@slipher/types';
import { mockId } from './id';

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
}

const AMBIGUOUS_QUEUE_ADD_MESSAGE = [
	'Ambiguous queue.add() call: a string first argument plus an options-shaped second argument can be either data/options or name/data.',
	'Use add(name, data, options) for named jobs, or pass non-string data to add(data, options).',
].join(' ');
const QUEUE_JOB_OPTION_KEYS = ['id', 'delay', 'attempts', 'priority', 'retryDelay'] as const;
const QUEUE_JOB_OPTION_KEY_SET = new Set<string>(QUEUE_JOB_OPTION_KEYS);

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
					 * isJobOptionsLike. The two-argument form add('send', { delay: '5s' })
					 * is ambiguous, so it throws instead of guessing. Use
					 * add('send', { payload: true }, { delay: '5s' }) to force
					 * name="send".
					 */
					async add(nameOrPayload: unknown, payloadOrOptions?: unknown, maybeOptions?: Record<string, unknown>) {
						if (isAmbiguousQueueAddArgs(nameOrPayload, payloadOrOptions, maybeOptions)) {
							throw new TypeError(AMBIGUOUS_QUEUE_ADD_MESSAGE);
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

function isAmbiguousQueueAddArgs(nameOrPayload: unknown, payloadOrOptions: unknown, maybeOptions: unknown): boolean {
	return (
		typeof nameOrPayload === 'string' &&
		payloadOrOptions !== undefined &&
		maybeOptions === undefined &&
		isJobOptionsLike(payloadOrOptions)
	);
}

// isJobOptionsLike owns the overload-disambiguation whitelist. If job options
// grow, update QUEUE_JOB_OPTION_KEYS here too. Kept local to avoid making
// @slipher/testing depend on @slipher/queues at runtime.
function isJobOptionsLike(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const keys = Object.keys(value);
	if (!keys.length) return false;
	return keys.every(key => QUEUE_JOB_OPTION_KEY_SET.has(key));
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
		...options.extra,
	};
}
