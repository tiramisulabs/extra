import { assert, describe, test } from 'vitest';
import {
	createQueues,
	InjectQueue,
	memory,
	OnQueueEvent,
	Process,
	Processor,
	parseDuration,
	persistent,
	type QueueJob,
	type QueueOf,
	type QueuesRegistry,
	queues,
} from '../src';

interface MailPayload {
	email: string;
}

interface WelcomePayload {
	userId: string;
}

declare module '../src' {
	interface RegisteredQueues {
		mail: {
			data: MailPayload;
			result: string;
		};
		priority: {
			data: string;
			result: string;
		};
		welcome: {
			data: WelcomePayload;
			result: string;
		};
	}
}

function waitForEvent<TArgs extends readonly unknown[]>(
	queue: { on(event: string, listener: (...args: TArgs) => void): () => void },
	event: string,
): Promise<TArgs> {
	return new Promise(resolve => {
		const off = queue.on(event, (...args: TArgs) => {
			off();
			resolve(args);
		});
	});
}

function wait(milliseconds: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}

describe('memory queues', () => {
	test('processes delayed jobs, retries failures, and records the completed result', async () => {
		const registry = createQueues({ driver: memory() });
		const queue = registry.get('welcome', {
			attempts: 2,
			retryDelay: 0,
		});
		let attempts = 0;

		queue.process(job => {
			attempts++;
			if (attempts === 1) throw new Error('try again');
			return `hello:${job.data.userId}`;
		});
		const retrying = waitForEvent(queue, 'retrying');
		const completed = waitForEvent(queue, 'completed');
		const job = await queue.add({ userId: 'user-1' }, { delay: '25ms', id: 'welcome-1', name: 'greet' });

		assert.equal(job.status, 'delayed');
		assert.equal(queue.counts().delayed, 1);

		const [retryJob, retryError, retryDelay] = await retrying;
		const [completedJob, result] = await completed;

		assert.equal(retryJob, job);
		assert.instanceOf(retryError, Error);
		assert.equal(retryDelay, 0);
		assert.equal(completedJob, job);
		assert.equal(result, 'hello:user-1');
		assert.equal(job.name, 'greet');
		assert.equal(job.attemptsMade, 2);
		assert.equal(job.status, 'completed');
		assert.equal(job.result, 'hello:user-1');
		assert.equal(queue.getJob('welcome-1'), job);
		assert.equal(queue.counts().completed, 1);

		await registry.close();
	});

	test('runs higher priority ready jobs before lower priority jobs', async () => {
		const processed: string[] = [];
		let now = 1_000;
		const registry = createQueues({ driver: memory({ now: () => now++ }) });
		const queue = registry.get('priority', { autostart: false });
		const idle = waitForEvent(queue, 'idle');

		await queue.add('low', { priority: 0 });
		await queue.add('high', { priority: 10 });
		queue.process(job => {
			processed.push(job.data);
			return job.data;
		});

		await idle;

		assert.deepEqual(processed, ['high', 'low']);
		await registry.close();
	});
});

describe('decorated queues', () => {
	test('registers processors, queue events, and injected producers without an external DI container', async () => {
		const processed: string[] = [];
		const events: string[] = [];

		class WelcomeProcessor {
			greet(job: QueueJob<WelcomePayload, string>) {
				processed.push(job.data.userId);
				return `welcome:${job.data.userId}`;
			}

			completed(_job: QueueJob<WelcomePayload, string>, result: string) {
				events.push(result);
			}
		}

		class WelcomeProducer {
			constructor(readonly welcome: QueueOf<'welcome'>) {}
		}

		Processor('welcome')(WelcomeProcessor);
		Process('greet')(WelcomeProcessor.prototype, 'greet');
		OnQueueEvent('completed')(WelcomeProcessor.prototype, 'completed');
		InjectQueue('welcome')(WelcomeProducer, undefined, 0);

		const registry = createQueues({ driver: memory() });
		registry.register({ processors: [WelcomeProcessor], producers: [WelcomeProducer] });
		const producer = registry.getProducer(WelcomeProducer);
		const completed = waitForEvent(registry.get('welcome'), 'completed');

		const job = await producer?.welcome.add({ userId: 'user-1' }, { name: 'greet' });
		const [completedJob, result] = await completed;

		assert.equal(completedJob, job);
		assert.equal(result, 'welcome:user-1');
		assert.deepEqual(processed, ['user-1']);
		assert.deepEqual(events, ['welcome:user-1']);
		assert.equal(producer?.welcome, registry.get('welcome'));

		await registry.close();
	});
});

describe('queues plugin', () => {
	test('exposes the registry on Seyfert context and installs it on the client during setup', async () => {
		const plugin = queues({ driver: memory() });
		const options = plugin.options?.({});
		const extension = options?.context?.({}) as { queues: QueuesRegistry };
		const client = {};

		await plugin.setup?.(client);

		assert.equal(plugin.name, '@slipher/queues');
		assert.equal(extension.queues, plugin.registry);
		assert.equal((client as { queues?: QueuesRegistry }).queues, plugin.registry);
		await plugin.registry.close();
	});
});

describe('persistent queues', () => {
	test('delegates queue operations and processors to a structural BullMQ module', async () => {
		const fake = createFakeBullMQ();
		const registry = createQueues({
			driver: persistent({
				bullmq: fake.module,
				connection: { host: '127.0.0.1', port: 6379 },
				prefix: 'slipher-test',
			}),
		});
		const queue = registry.get('mail', {
			attempts: 3,
			concurrency: 2,
		});
		let processed: QueueJob<MailPayload, string> | undefined;

		const job = await queue.add(
			{ email: 'hi@example.com' },
			{ attempts: 4, delay: '5s', id: 'job-1', name: 'send', priority: 7 },
		);
		queue.process(async nextJob => {
			processed = nextJob;
			return `sent:${nextJob.data.email}`;
		});
		const result = await fake.workers[0].processor({
			attemptsMade: 1,
			data: { email: 'hi@example.com' },
			id: 'bull-job-1',
			name: 'send',
			opts: { attempts: 4 },
			processedOn: Date.parse('2026-05-29T10:00:01.000Z'),
			timestamp: Date.parse('2026-05-29T10:00:00.000Z'),
		});

		assert.equal(job.id, 'job-1');
		assert.deepEqual(fake.queues[0].adds[0], {
			data: { email: 'hi@example.com' },
			name: 'send',
			options: { attempts: 4, delay: 5000, jobId: 'job-1', priority: 7 },
		});
		assert.equal(fake.workers[0].name, 'mail');
		assert.deepEqual(fake.workers[0].options, {
			connection: { host: '127.0.0.1', port: 6379 },
			concurrency: 2,
			prefix: 'slipher-test',
		});
		assert.equal(processed?.id, 'bull-job-1');
		assert.equal(processed?.queueName, 'mail');
		assert.equal(processed?.name, 'send');
		assert.equal(result, 'sent:hi@example.com');
		queue.pause();
		queue.start();
		assert.equal(fake.queues[0].paused, true);
		assert.equal(fake.queues[0].resumed, true);

		await registry.close();
		assert.equal(fake.queues[0].closed, true);
		assert.equal(fake.workers[0].closed, true);
	});
});

describe('parseDuration', () => {
	test('parses queue delay inputs', () => {
		assert.equal(parseDuration(0), 0);
		assert.equal(parseDuration('10ms'), 10);
		assert.equal(parseDuration('1s 5ms'), 1005);
		assert.throws(() => parseDuration('soon'), RangeError);
	});
});

function createFakeBullMQ() {
	const queues: FakeBullQueue[] = [];
	const workers: FakeBullWorker[] = [];

	return {
		queues,
		workers,
		module: {
			Queue: class extends FakeBullQueue {
				constructor(name: string, options: Record<string, unknown>) {
					super(name, options);
					queues.push(this);
				}
			},
			Worker: class extends FakeBullWorker {
				constructor(name: string, processor: (job: FakeBullJob) => unknown, options: Record<string, unknown>) {
					super(name, processor, options);
					workers.push(this);
				}
			},
		},
	};
}

class FakeBullQueue {
	readonly adds: { name: string; data: unknown; options: unknown }[] = [];
	closed = false;
	paused = false;
	resumed = false;

	constructor(
		readonly name: string,
		readonly options: Record<string, unknown>,
	) {}

	async add(name: string, data: unknown, options: unknown) {
		this.adds.push({ name, data, options });
		return { id: (options as { jobId?: string }).jobId ?? `${name}:1`, name, data };
	}

	async getJob(_id: string) {
		return undefined;
	}

	async getJobCounts() {
		return { active: 0, completed: 0, delayed: 0, failed: 0, waiting: 0 };
	}

	async pause() {
		this.paused = true;
	}

	async resume() {
		this.resumed = true;
	}

	async close() {
		this.closed = true;
	}
}

class FakeBullWorker {
	readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>();
	closed = false;

	constructor(
		readonly name: string,
		readonly processor: (job: FakeBullJob) => unknown,
		readonly options: Record<string, unknown>,
	) {}

	on(event: string, listener: (...args: unknown[]) => void) {
		this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
		return this;
	}

	async close() {
		this.closed = true;
	}
}

interface FakeBullJob {
	id: string;
	name: string;
	data: unknown;
	opts?: { attempts?: number };
	attemptsMade?: number;
	timestamp?: number;
	processedOn?: number;
}
