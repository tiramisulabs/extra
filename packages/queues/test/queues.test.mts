import { parseDuration as parseInternalDuration } from '@slipher/internal';
import { assert, describe, test } from 'vitest';
import {
	createQueues,
	memory,
	OnQueueEvent,
	OnWorkerEvent,
	Process,
	Processor,
	persistent,
	type QueueJob,
	type QueueJobOf,
	type QueueRegistration,
	type QueuesRegistry,
	queues,
} from '../src';

type MailJob = { job: 'send'; email: string } | { job: 'digest'; email: string; window: 'daily' | 'weekly' };

interface WelcomePayload {
	userId: string;
}

declare module '../src' {
	interface RegisteredQueues {
		mail: QueueRegistration<MailJob, string>;
		priority: QueueRegistration<string, string>;
		welcome: QueueRegistration<WelcomePayload, string>;
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

describe('memory queues', () => {
	test('shares the internal duration parser', () => {
		assert.equal(parseInternalDuration('1s 5ms'), 1005);
	});

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
		const job = await queue.add({ userId: 'user-1' }, { delay: '25ms', id: 'welcome-1' });

		assert.equal(job.status, 'delayed');
		assert.equal(queue.counts().delayed, 1);

		const [retryJob, retryError, retryDelay] = await retrying;
		const [completedJob, result] = await completed;

		assert.equal(retryJob, job);
		assert.instanceOf(retryError, Error);
		assert.equal(retryDelay, 0);
		assert.equal(completedJob, job);
		assert.equal(result, 'hello:user-1');
		assert.equal(job.name, 'default');
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

	test('isolates listener errors from completed job state and later listeners', async () => {
		const reported: { event: string; error: unknown }[] = [];
		const registry = createQueues({
			driver: memory({
				reportListenerError: (event, error) => reported.push({ event, error }),
			}),
		});
		const queue = registry.get('welcome');
		const events: string[] = [];

		queue.process(job => `welcome:${job.data.userId}`);
		queue.on('completed', () => {
			throw new Error('listener failed');
		});
		queue.on('completed', () => events.push('second'));

		const completed = waitForEvent(queue, 'completed');
		const job = await queue.add({ userId: 'user-1' });
		await completed;

		assert.equal(job.status, 'completed');
		assert.equal(job.attemptsMade, 1);
		assert.deepEqual(events, ['second']);
		assert.equal(reported[0].event, 'completed');
		assert.instanceOf(reported[0].error, Error);

		await registry.close();
	});
});

describe('decorated queues', () => {
	test('registers one handler per queue and positional named jobs', async () => {
		const processed: string[] = [];
		const events: string[] = [];
		const workerEvents: string[] = [];

		class MailProcessor {
			handle(job: QueueJobOf<'mail'>) {
				processed.push(`${job.name}:${job.data.email}`);
				switch (job.name) {
					case 'send':
						return `sent:${job.data.email}`;
					case 'digest':
						return `digest:${job.data.window}:${job.data.email}`;
				}
			}

			completed(_job: QueueJobOf<'mail'>, result: string) {
				events.push(result);
			}

			active(job: QueueJobOf<'mail'>) {
				workerEvents.push(job.name);
			}
		}

		Processor('mail')(MailProcessor);
		Process()(MailProcessor.prototype, 'handle');
		OnQueueEvent('completed')(MailProcessor.prototype, 'completed');
		OnWorkerEvent('active')(MailProcessor.prototype, 'active');

		const registry = createQueues({ driver: memory() });
		registry.register({ processors: [MailProcessor] });
		const completed = waitForEvent(registry.get('mail'), 'completed');

		const job = await registry.add('mail', 'send', { email: 'hi@example.com' });
		const [completedJob, result] = await completed;

		assert.equal(completedJob, job);
		assert.equal(result, 'sent:hi@example.com');
		assert.deepEqual(processed, ['send:hi@example.com']);
		assert.deepEqual(events, ['sent:hi@example.com']);
		assert.deepEqual(workerEvents, ['send']);

		await registry.close();
	});

	test('rejects multiple process handlers on the same processor', () => {
		class BadProcessor {
			one() {}
			two() {}
		}

		Processor('welcome')(BadProcessor);
		Process()(BadProcessor.prototype, 'one');
		Process()(BadProcessor.prototype, 'two');

		assert.throws(
			() => createQueues({ driver: memory(), processors: [BadProcessor] }),
			/declare exactly one @Process\(\) handler/,
		);
	});

	test('get(name) without options reuses an optioned queue without fingerprint conflict', () => {
		const registry = createQueues({ driver: memory() });

		const optioned = registry.get('welcome', { attempts: 3 });

		assert.equal(registry.get('welcome'), optioned);
		assert.equal(registry.get('welcome', { attempts: 3 }), optioned);
		assert.throws(() => registry.get('welcome', { attempts: 4 }), /different options/);

		const dynamic = registry.get('dynamic');
		assert.equal(registry.get('dynamic', { attempts: 2 }), dynamic);
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
		await plugin.teardown?.(client);
	});
});

describe('persistent queues', () => {
	test('defers BullMQ construction to setup and closes queue resources during teardown', async () => {
		const fake = createFakeBullMQ();
		const registry = createQueues({
			driver: persistent({
				bullmq: fake.module,
				connection: { host: '127.0.0.1', port: 6379 },
				prefix: 'slipher-test',
			}),
		});
		const queue = registry.get('mail', { concurrency: 2 });

		queue.process(job => `sent:${job.data.email}`);

		assert.equal(fake.queues.length, 0);
		await assertRejects(() => queue.add('send', { email: 'hi@example.com' }), /not initialized/);

		await registry.setup({ initialized: true });

		assert.equal(fake.queues.length, 1);
		assert.equal(fake.workers.length, 1);
		assert.equal(fake.queueEvents.length, 1);
		assert.equal(fake.workers[0].options.concurrency, 2);

		await registry.close();

		assert.equal(fake.workers[0].closed, true);
		assert.equal(fake.queueEvents[0].closed, true);
		assert.equal(fake.queues[0].closed, true);
	});

	test('sends queue options to the queue constructor and job defaults to add options', async () => {
		const fake = createFakeBullMQ();
		const registry = createQueues({
			driver: persistent({
				bullmq: fake.module,
				connection: { host: '127.0.0.1', port: 6379 },
				defaultJobOptions: { removeOnComplete: true },
				prefix: 'slipher-test',
				queueOptions: { settings: { stalledInterval: 1_000 } },
			}),
		});
		const queue = registry.get('mail', {
			attempts: 3,
			retryDelay: '5s',
		});
		queue.process(job => `sent:${job.data.email}`);

		await registry.setup({ initialized: true });
		const job = await queue.add('send', { email: 'hi@example.com' }, { attempts: 4, delay: '1s', id: 'job-1' });
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
		assert.deepEqual(fake.queues[0].options, {
			connection: { host: '127.0.0.1', port: 6379 },
			defaultJobOptions: { removeOnComplete: true },
			prefix: 'slipher-test',
			settings: { stalledInterval: 1_000 },
		});
		assert.deepEqual(fake.queues[0].adds[0], {
			data: { email: 'hi@example.com' },
			name: 'send',
			options: {
				attempts: 4,
				backoff: { delay: 5000, type: 'fixed' },
				delay: 1000,
				jobId: 'job-1',
				removeOnComplete: true,
			},
		});
		assert.equal(result, 'sent:hi@example.com');

		await registry.close();
	});

	test('rejects function retryDelay on the persistent driver during setup', async () => {
		const fake = createFakeBullMQ();
		const registry = createQueues({
			driver: persistent({ bullmq: fake.module }),
		});

		registry.get('mail', {
			retryDelay: () => 100,
		});

		await assertRejects(() => registry.setup({ initialized: true }), /does not support function-form retryDelay/);
	});
});

async function assertRejects(run: () => Promise<unknown>, expected: RegExp) {
	let thrown: unknown;
	try {
		await run();
	} catch (error) {
		thrown = error;
	}

	assert.instanceOf(thrown, Error);
	assert.match((thrown as Error).message, expected);
}

function createFakeBullMQ() {
	const queues: FakeBullQueue[] = [];
	const workers: FakeBullWorker[] = [];
	const queueEvents: FakeBullQueueEvents[] = [];

	return {
		queueEvents,
		queues,
		workers,
		module: {
			Queue: class extends FakeBullQueue {
				constructor(name: string, options: Record<string, unknown>) {
					super(name, options);
					queues.push(this);
				}
			},
			QueueEvents: class extends FakeBullQueueEvents {
				constructor(name: string, options: Record<string, unknown>) {
					super(name, options);
					queueEvents.push(this);
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

class FakeBullQueueEvents {
	closed = false;

	constructor(
		readonly name: string,
		readonly options: Record<string, unknown>,
	) {}

	on() {
		return this;
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
