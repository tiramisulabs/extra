import { Client, definePlugins } from 'seyfert';
import { assert, describe, expect, test } from 'vitest';
import {
	createQueues,
	InvalidDurationError,
	memory,
	OnQueueEvent,
	OnWorkerEvent,
	Process,
	Processor,
	type Queue,
	type QueueEventMap,
	type QueueJobOf,
	type QueueRegistration,
	queues,
} from '../src';
import { flushQueueEvents } from './fake-bullmq';

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

function waitForEvent<TData, TResult, TEvent extends keyof QueueEventMap<TData, TResult>>(
	queue: Pick<Queue<TData, TResult>, 'on'>,
	event: TEvent,
): Promise<QueueEventMap<TData, TResult>[TEvent]> {
	return new Promise(resolve => {
		const off = queue.on(event, payload => {
			off();
			resolve(payload);
		});
	});
}

describe('memory queues', () => {
	test('parses compound duration strings for delayed jobs', async () => {
		const now = 1_000;
		const registry = createQueues({ driver: memory({ autostart: false, now: () => now }) });
		const queue = registry.get('welcome');

		const job = await queue.add({ userId: 'user-1' }, { delay: '1s 5ms' });

		assert.equal(job.runAt.getTime() - job.createdAt.getTime(), 1005);
		assert.equal(queue.counts().delayed, 1);

		await registry.close();
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

		const retry = await retrying;
		const completedPayload = await completed;

		assert.equal(retry.job, job);
		assert.instanceOf(retry.error, Error);
		assert.equal(retry.delay, 0);
		assert.equal(completedPayload.job, job);
		assert.equal(completedPayload.result, 'hello:user-1');
		assert.equal(job.name, 'default');
		assert.equal(job.attemptsMade, 2);
		assert.equal(job.status, 'completed');
		assert.equal(job.result, 'hello:user-1');
		assert.equal(queue.getJob('welcome-1'), job);
		assert.equal(queue.counts().completed, 1);

		await registry.close();
	});

	test('close stops pending memory jobs from processing after active work settles', async () => {
		let releaseFirst!: () => void;
		const firstBlocked = new Promise<void>(resolve => {
			releaseFirst = resolve;
		});
		const processed: string[] = [];
		const registry = createQueues({ driver: memory() });
		const queue = registry.get('welcome', { concurrency: 1 });

		queue.process(async job => {
			processed.push(job.data.userId);
			if (processed.length === 1) await firstBlocked;
			return `done:${job.data.userId}`;
		});

		await queue.add({ userId: 'first' });
		await queue.add({ userId: 'second' });
		await flushQueueEvents();

		queue.close();
		releaseFirst();
		await flushQueueEvents();

		assert.deepEqual(processed, ['first']);
		assert.equal(queue.counts().completed, 1);
		assert.equal(queue.counts().waiting, 1);

		await registry.close();
	});

	test('matches BullMQ priority ordering and honors autostart false', async () => {
		const processed: string[] = [];
		let now = 1_000;
		const registry = createQueues({ driver: memory({ now: () => now++ }) });
		const queue = registry.get('priority', { autostart: false });
		const idle = waitForEvent(queue, 'idle');

		await queue.add({ label: 'low' }, { priority: 0 });
		await queue.add({ label: 'high' }, { priority: 10 });
		queue.process(job => {
			processed.push(job.data.label);
			return job.data.label;
		});
		await flushQueueEvents();
		assert.deepEqual(processed, []);
		queue.start();

		await idle;

		assert.deepEqual(processed, ['low', 'high']);
		await registry.close();
	});

	test('honors a per-job retryDelay over the memory queue default', async () => {
		const registry = createQueues({ driver: memory({ attempts: 2, retryDelay: '1h' }) });
		const queue = registry.get('welcome');
		let attempts = 0;
		queue.process(job => {
			if (++attempts === 1) throw new Error('retry now');
			return `welcome:${job.data.userId}`;
		});
		const retrying = waitForEvent(queue, 'retrying');
		const completed = waitForEvent(queue, 'completed');
		await queue.add({ userId: 'user-1' }, { retryDelay: 0 });

		assert.equal((await retrying).delay, 0);
		await completed;
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

	test('reports rejected async listeners without interrupting later listeners', async () => {
		const reported: unknown[] = [];
		const registry = createQueues({
			driver: memory({ reportListenerError: (_event, error) => reported.push(error) }),
		});
		const queue = registry.get('welcome');
		const events: string[] = [];

		queue.process(job => `welcome:${job.data.userId}`);
		queue.on('completed', async () => {
			throw new Error('async listener failed');
		});
		queue.on('completed', () => events.push('second'));
		const idle = waitForEvent(queue, 'idle');
		await queue.add({ userId: 'user-1' });
		await idle;
		await flushQueueEvents();

		assert.deepEqual(events, ['second']);
		assert.match((reported[0] as Error).message, /async listener failed/);
		await registry.close();
	});

	test('bounds retained completed jobs', async () => {
		const registry = createQueues({ driver: memory({ retention: 2 }) });
		const queue = registry.get('welcome');
		queue.process(job => `welcome:${job.data.userId}`);
		const idle = waitForEvent(queue, 'idle');
		await queue.add({ userId: 'one' }, { id: 'one' });
		await queue.add({ userId: 'two' }, { id: 'two' });
		await queue.add({ userId: 'three' }, { id: 'three' });
		await idle;

		assert.equal(queue.counts().completed, 2);
		assert.equal(queue.getJob('one'), undefined);
		assert.ok(queue.getJob('three'));
		await registry.close();
	});

	test('rejects writes after a memory queue is closed', async () => {
		const queue = memory().get('welcome');
		queue.close();
		assert.throws(() => queue.add({ userId: 'user-1' }), /closed/);
		assert.throws(() => queue.start(), /closed/);
	});

	test('supports once listeners with object payloads', async () => {
		const registry = createQueues({ driver: memory() });
		const queue = registry.get('welcome');
		const completed: string[] = [];
		const idle = waitForEvent(queue, 'idle');

		queue.process(job => `welcome:${job.data.userId}`);
		queue.once('completed', payload => {
			completed.push(payload.result);
		});

		await queue.add({ userId: 'user-1' });
		await queue.add({ userId: 'user-2' });
		await idle;

		assert.deepEqual(completed, ['welcome:user-1']);

		await registry.close();
	});

	test('warns when retryDelay cannot schedule retries', async () => {
		const originalEmitWarning = process.emitWarning;
		const warnings: { warning: string | Error; options?: ErrorOptions & { code?: string } }[] = [];
		process.emitWarning = ((warning: string | Error, options?: ErrorOptions & { code?: string }) => {
			warnings.push({ options, warning });
			return true;
		}) as typeof process.emitWarning;

		try {
			const registry = createQueues({ driver: memory() });
			const queue = registry.get('welcome', { retryDelay: '5s' });
			await queue.add({ userId: 'user-1' }, { retryDelay: '1s' });
			await registry.close();
		} finally {
			process.emitWarning = originalEmitWarning;
		}

		assert.deepEqual(
			warnings.map(entry => entry.options?.code),
			['SLIPHER_QUEUE_RETRY_DELAY_NO_RETRIES', 'SLIPHER_QUEUE_RETRY_DELAY_NO_RETRIES'],
		);
	});

	test('exports InvalidDurationError for consumer instanceof checks', () => {
		let thrown: unknown;

		try {
			memory({ now: () => 0 })
				.get('welcome')
				.add({ userId: 'user-1' }, { delay: 'soon' });
		} catch (error) {
			thrown = error;
		}

		assert.instanceOf(thrown, InvalidDurationError);
	});

	test('rejects ambiguous string payload plus options-shaped data', async () => {
		const registry = createQueues({ driver: memory() });
		const queue = registry.get('outbox');

		assert.throws(() => queue.add('send', { delay: '5s' }), /Ambiguous queue\.add\(\) call/);

		const named = await queue.add('send', { delay: '5s' }, {});

		assert.equal(named.name, 'send');
		assert.deepEqual(named.data, { delay: '5s' });

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

			completed(payload: { job: QueueJobOf<'mail'>; result: string }) {
				events.push(payload.result);
			}

			active(payload: { job: QueueJobOf<'mail'> }) {
				workerEvents.push(payload.job.name);
			}
		}

		Processor('mail')(MailProcessor);
		Process()(MailProcessor.prototype, 'handle');
		OnQueueEvent('completed')(MailProcessor.prototype, 'completed');
		OnWorkerEvent('active')(MailProcessor.prototype, 'active');

		const registry = createQueues({ driver: memory() });
		registry.register({ processors: [MailProcessor] });
		const completed = waitForEvent(registry.get('mail'), 'completed');

		const job = await registry.get('mail').add('send', { email: 'hi@example.com' });
		const completedPayload = await completed;

		assert.equal(completedPayload.job, job);
		assert.equal(completedPayload.result, 'sent:hi@example.com');
		assert.deepEqual(processed, ['send:hi@example.com']);
		assert.deepEqual(events, ['sent:hi@example.com']);
		assert.deepEqual(workerEvents, ['send']);

		await registry.close();
	});

	test('@Process handlers run with the processor instance as this', async () => {
		class MailProcessor {
			prefix = 'sent';

			handle(job: QueueJobOf<'mail'>) {
				return `${this.prefix}:${job.data.email}`;
			}
		}

		Processor('mail')(MailProcessor);
		Process()(MailProcessor.prototype, 'handle');

		const registry = createQueues({ driver: memory(), processors: [MailProcessor] });
		const queue = registry.get('mail');
		const outcome = Promise.race([
			waitForEvent(queue, 'completed').then(payload => ({ result: payload.result, type: 'completed' as const })),
			waitForEvent(queue, 'failed').then(payload => ({ error: payload.error, type: 'failed' as const })),
		]);

		await queue.add('send', { email: 'hi@example.com' });
		const result = await outcome;

		if (result.type === 'failed') assert.fail(`Expected completed job, got failed: ${String(result.error)}`);
		assert.equal(result.result, 'sent:hi@example.com');

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

		registry.get('dynamic');
		assert.throws(() => registry.get('dynamic', { attempts: 2 }), /different options/);
	});
});

describe('queues plugin', () => {
	test('lets Seyfert install the registry as a read-only client extension', async () => {
		const plugin = queues({ driver: memory() });
		const plugins = definePlugins(plugin);
		const client = new Client({ plugins });
		const extension = { queues: plugin.ctx?.queues({}, client) };

		assert.equal(plugin.name, '@slipher/queues');
		assert.equal(typeof plugin.client?.queues, 'function');
		assert.equal(extension.queues, plugin.registry);
		assert.equal(client.queues, plugin.registry);
		assert.equal(Object.getOwnPropertyDescriptor(client, 'queues')?.writable, false);
		await plugin.setup?.(client);
		await plugin.teardown?.(client);
	});

	test('teardown closes captured registry access without mutating Seyfert-owned client properties', async () => {
		const plugin = queues({ driver: memory() });
		const client = new Client({ plugins: definePlugins(plugin) });

		await plugin.setup?.(client);
		await plugin.teardown?.(client);

		assert.equal(client.queues, plugin.registry);
		assert.throws(() => plugin.registry.get('welcome'), /closed/);
	});
});
