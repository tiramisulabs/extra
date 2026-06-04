export type MockLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface MockLogEntry {
	level: MockLogLevel | 'add';
	args: unknown[];
}

export interface MockLogger {
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

export interface MockQueueJob<TPayload = unknown> {
	name: string;
	payload: TPayload;
	options?: Record<string, unknown>;
}

export interface MockQueueEventMap<TPayload = unknown, TResult = unknown> {
	added: [job: MockQueueJob<TPayload>];
	active: [job: MockQueueJob<TPayload>];
	completed: [job: MockQueueJob<TPayload>, result: TResult];
	failed: [job: MockQueueJob<TPayload>, error: unknown];
	retrying: [job: MockQueueJob<TPayload>, error: unknown, delay: number];
	idle: [];
}

export interface MockQueue<TPayload = unknown, TResult = unknown> {
	name: string;
	jobs: MockQueueJob<TPayload>[];
	add<TJobPayload = unknown>(
		name: string,
		payload: TJobPayload,
		options?: Record<string, unknown>,
	): Promise<MockQueueJob<TJobPayload>>;
	add(payload: TPayload, options?: Record<string, unknown>): Promise<MockQueueJob<TPayload>>;
	on<TEvent extends keyof MockQueueEventMap<TPayload, TResult>>(
		event: TEvent,
		listener: (...args: MockQueueEventMap<TPayload, TResult>[TEvent]) => unknown,
	): () => void;
	off<TEvent extends keyof MockQueueEventMap<TPayload, TResult>>(
		event: TEvent,
		listener: (...args: MockQueueEventMap<TPayload, TResult>[TEvent]) => unknown,
	): void;
}

export interface MockQueues {
	queues: Map<string, MockQueue>;
	get<TPayload = unknown, TResult = unknown>(name: string): MockQueue<TPayload, TResult>;
}

export interface MockScheduledTask {
	name: string;
	schedule: string;
	run: (task: MockScheduledTask) => unknown;
}

export interface MockScheduler {
	tasks: MockScheduledTask[];
	add(name: string, schedule: string, run: (task: MockScheduledTask) => unknown): MockScheduledTask;
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
					async add(nameOrPayload: unknown, payloadOrOptions?: unknown, maybeOptions?: Record<string, unknown>) {
						const hasJobName =
							typeof nameOrPayload === 'string' &&
							payloadOrOptions !== undefined &&
							(maybeOptions !== undefined || !isJobOptionsLike(payloadOrOptions));
						const job = {
							name: hasJobName ? nameOrPayload : 'default',
							options: (hasJobName ? maybeOptions : payloadOrOptions) as Record<string, unknown> | undefined,
							payload: (hasJobName ? payloadOrOptions : nameOrPayload) as TPayload,
						};
						this.jobs.push(job);
						return job;
					},
					on() {
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

function isJobOptionsLike(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const keys = Object.keys(value);
	if (!keys.length) return false;
	return keys.every(key => ['id', 'delay', 'attempts', 'priority', 'retryDelay'].includes(key));
}

export function mockScheduler(): MockScheduler {
	const tasks: MockScheduledTask[] = [];

	return {
		tasks,
		add(name, schedule, run) {
			const task = { name, schedule, run };
			tasks.push(task);
			return task;
		},
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
