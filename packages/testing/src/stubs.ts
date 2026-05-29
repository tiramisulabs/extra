export type MockLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface MockLogEntry {
	level: MockLogLevel | 'add';
	args: unknown[];
}

export interface MockLogger {
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
	payload: TPayload;
	options?: Record<string, unknown>;
}

export interface MockQueue<TPayload = unknown> {
	name: string;
	jobs: MockQueueJob<TPayload>[];
	add(payload: TPayload, options?: Record<string, unknown>): Promise<MockQueueJob<TPayload>>;
}

export interface MockQueues {
	queues: Map<string, MockQueue>;
	get<TPayload = unknown>(name: string): MockQueue<TPayload>;
}

export interface MockScheduledTask {
	name: string;
	schedule: string;
	run: () => unknown;
}

export interface MockScheduler {
	tasks: MockScheduledTask[];
	add(name: string, schedule: string, run: () => unknown): MockScheduledTask;
}

export function mockLogger(): MockLogger {
	const entries: MockLogEntry[] = [];
	const write =
		(level: MockLogLevel) =>
		(...args: unknown[]) => {
			entries.push({ level, args });
		};

	return {
		entries,
		add(data) {
			entries.push({ level: 'add', args: [data] });
		},
		trace: write('trace'),
		debug: write('debug'),
		info: write('info'),
		warn: write('warn'),
		error: write('error'),
		fatal: write('fatal'),
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
		get<TPayload = unknown>(name: string) {
			let queue = queues.get(name) as MockQueue<TPayload> | undefined;
			if (!queue) {
				queue = {
					name,
					jobs: [],
					async add(payload: TPayload, options?: Record<string, unknown>) {
						const job = { payload, options };
						this.jobs.push(job);
						return job;
					},
				};
				queues.set(name, queue as MockQueue);
			}
			return queue;
		},
	};
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
