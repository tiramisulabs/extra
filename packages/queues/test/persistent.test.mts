import { assert, describe, test } from 'vitest';
import {
	createQueues,
	OnQueueEvent,
	OnWorkerEvent,
	Process,
	Processor,
	persistent,
	type QueueJob,
	type QueueJobOf,
	type QueueRegistration,
} from '../src';
import { assertRejects, createFakeBullMQ, flushQueueEvents, waitForEvent } from './fake-bullmq';

type MailJob = { job: 'send'; email: string } | { job: 'digest'; email: string; window: 'daily' | 'weekly' };

declare module '../src' {
	interface RegisteredQueues {
		mail: QueueRegistration<MailJob, string>;
	}
}

describe('persistent queues', () => {
	test('does not become ready until every BullMQ resource is ready', async () => {
		let releaseReadiness!: () => void;
		const readiness = new Promise<void>(resolve => {
			releaseReadiness = resolve;
		});
		const fake = createFakeBullMQ({ readiness });
		const registry = createQueues({ driver: persistent({ bullmq: fake.module }) });
		const queue = registry.get('mail');
		queue.process(job => `sent:${job.data.email}`);

		const setup = registry.setup({ initialized: true });
		await flushQueueEvents();
		let addSettled = false;
		const add = queue.add('send', { email: 'while-starting@example.com' }).then(job => {
			addSettled = true;
			return job;
		});
		await flushQueueEvents();
		assert.equal(addSettled, false);
		assert.equal(fake.queues[0].waitedUntilReady, true);
		assert.equal(fake.queueEvents[0].waitedUntilReady, true);
		assert.equal(fake.workers[0].waitedUntilReady, true);

		releaseReadiness();
		await setup;
		await add;
		await registry.close();
	});

	test('initializes late queues and awaits late workers and processor registration', async () => {
		let releaseReadiness!: () => void;
		const readiness = new Promise<void>(resolve => {
			releaseReadiness = resolve;
		});
		const fake = createFakeBullMQ({ workerReadiness: readiness });
		const registry = createQueues({ driver: persistent({ bullmq: fake.module }) });
		await registry.setup({ initialized: true });

		const lateQueue = registry.get<{ value: number }, number>('late');
		assert.equal(fake.queues.length, 0);
		await lateQueue.add({ value: 21 });
		assert.equal(fake.queues.length, 1);
		assert.equal(fake.queues[0].waitedUntilReady, true);
		let processorReady = false;
		const process = Promise.resolve(lateQueue.process(job => job.data.value * 2)).then(() => {
			processorReady = true;
		});
		const start = lateQueue.start();
		await flushQueueEvents();
		assert.equal(fake.workers.length, 1);
		assert.equal(fake.workers[0].waitedUntilReady, true);
		assert.equal(processorReady, false);

		releaseReadiness();
		await Promise.all([process, start]);

		class LateProcessor {
			handle() {
				return 'done';
			}
		}
		Processor('registered-late')(LateProcessor);
		Process()(LateProcessor.prototype, 'handle');
		await registry.register({ processors: [LateProcessor] });
		assert.equal(fake.workers.length, 2);
		assert.equal(fake.workers[1].waitedUntilReady, true);

		await registry.close();
	});

	test('rolls back every BullMQ resource when readiness fails', async () => {
		let rejectReadiness!: (error: Error) => void;
		const readiness = new Promise<void>((_resolve, reject) => {
			rejectReadiness = reject;
		});
		const fake = createFakeBullMQ({ readiness });
		const registry = createQueues({ driver: persistent({ bullmq: fake.module }) });
		registry.get('mail').process(() => 'sent');
		const setup = registry.setup({ initialized: true });
		await flushQueueEvents();

		rejectReadiness(new Error('redis unavailable'));
		await assertRejects(() => setup, /redis unavailable/);
		assert.equal(fake.queues[0].closed, true);
		assert.equal(fake.queueEvents[0].closed, true);
		assert.equal(fake.workers[0].closed, true);
		assert.throws(() => registry.get('mail'), /closed/);
	});

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

	test('maps autostart false to BullMQ autorun and starts explicitly', async () => {
		const fake = createFakeBullMQ();
		const registry = createQueues({ driver: persistent({ bullmq: fake.module }) });
		const queue = registry.get('mail', { autostart: false });
		queue.process(job => `sent:${job.data.email}`);
		await registry.setup({ initialized: true });

		assert.equal(fake.workers[0].options.autorun, false);
		assert.equal(fake.workers[0].runCalled, false);
		await queue.start();
		await flushQueueEvents();
		assert.equal(fake.workers[0].runCalled, true);

		await queue.pause();
		assert.equal(fake.workers[0].paused, true);
		await registry.close();
	});

	test('sends queue options to the queue constructor and job defaults to add options', async () => {
		const fake = createFakeBullMQ();
		const registry = createQueues({
			driver: persistent({
				bullmq: fake.module,
				connection: { host: '127.0.0.1', port: 6379 },
				defaultJobOptions: { delay: 250, priority: 7, removeOnComplete: true },
				prefix: 'slipher-test',
				queueOptions: { settings: { stalledInterval: 1_000 } },
				queueEventsOptions: { blockingTimeout: 1_000 },
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
			defaultJobOptions: { delay: 250, priority: 7, removeOnComplete: true },
			prefix: 'slipher-test',
			settings: { stalledInterval: 1_000 },
		});
		assert.deepEqual(fake.queueEvents[0].options, {
			blockingTimeout: 1_000,
			connection: { host: '127.0.0.1', port: 6379 },
			prefix: 'slipher-test',
		});
		assert.deepEqual(fake.queues[0].adds[0], {
			data: { email: 'hi@example.com' },
			name: 'send',
			options: {
				attempts: 4,
				backoff: { delay: 5000, type: 'fixed' },
				delay: 1000,
				jobId: 'job-1',
				priority: 7,
				removeOnComplete: true,
			},
		});
		assert.equal(result, 'sent:hi@example.com');

		await registry.close();
	});

	test('preserves defaultJobOptions delay when a job omits delay', async () => {
		const fake = createFakeBullMQ();
		const registry = createQueues({
			driver: persistent({ bullmq: fake.module, defaultJobOptions: { delay: 750 } }),
		});
		const queue = registry.get('mail');
		await registry.setup({ initialized: true });
		await queue.add('send', { email: 'hi@example.com' });

		assert.equal((fake.queues[0].adds[0].options as { delay?: number }).delay, 750);
		await registry.close();
	});

	test('aggregates every BullMQ waiting state and reports a complete total', async () => {
		const fake = createFakeBullMQ();
		const registry = createQueues({ driver: persistent({ bullmq: fake.module }) });
		const queue = registry.get('mail');
		await registry.setup({ initialized: true });
		fake.queues[0].jobCounts = {
			active: 5,
			completed: 6,
			delayed: 4,
			failed: 7,
			paused: 2,
			prioritized: 3,
			waiting: 1,
			'waiting-children': 8,
		};

		assert.deepEqual(await queue.counts(), {
			active: 5,
			completed: 6,
			delayed: 4,
			failed: 7,
			total: 36,
			waiting: 14,
		});
		assert.deepEqual(fake.queues[0].countTypes[0], [
			'waiting',
			'prioritized',
			'paused',
			'waiting-children',
			'delayed',
			'active',
			'completed',
			'failed',
		]);
		await registry.close();
	});

	test('rolls back partially constructed BullMQ resources when setup fails', async () => {
		let queueClosed = false;
		const registry = createQueues({
			driver: persistent({
				bullmq: {
					Queue: class {
						add() {
							throw new Error('not used');
						}
						async close() {
							queueClosed = true;
						}
					},
					QueueEvents: class {
						constructor() {
							throw new Error('queue events failed');
						}
					},
					Worker: class {
						constructor() {
							throw new Error('not used');
						}
					},
				},
			}),
		});
		registry.get('mail');

		await assertRejects(() => registry.setup({ initialized: true }), /queue events failed/);

		assert.equal(queueClosed, true);
		assert.throws(() => registry.get('mail'), /closed/);
	});

	test('does not fabricate typed jobs or queue lookups for removed QueueEvents jobs', async () => {
		const fake = createFakeBullMQ();
		const registry = createQueues({ driver: persistent({ bullmq: fake.module }) });
		const queue = registry.get('mail');
		await registry.setup({ initialized: true });
		let lookups = 0;
		fake.queues[0].getJob = async () => {
			lookups++;
			return undefined;
		};

		const completed = waitForEvent(queue, 'completed');
		fake.queueEvents[0].emit('completed', { jobId: 'job-1', returnvalue: 'sent' });
		const payload = await completed;
		assert.equal(payload.job, undefined);
		assert.equal(payload.jobId, 'job-1');
		assert.equal(payload.result, 'sent');
		assert.equal(lookups, 0);

		await registry.close();
		assert.equal(fake.queues[0].closed, true);
		await assertRejects(() => queue.add('send', { email: 'after-close@example.com' }), /closed|stopped/);
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

	test('emits retrying only when BullMQ will actually retry the job', async () => {
		const fake = createFakeBullMQ();
		const events: string[] = [];
		class MailProcessor {
			handle() {
				return 'sent';
			}
			retrying(payload: { job: QueueJob<unknown, unknown> }) {
				events.push(`retrying:${payload.job.status}`);
			}
			failed() {
				events.push('failed');
			}
		}
		Processor('mail')(MailProcessor);
		Process()(MailProcessor.prototype, 'handle');
		OnWorkerEvent('retrying')(MailProcessor.prototype, 'retrying');
		OnWorkerEvent('failed')(MailProcessor.prototype, 'failed');
		const registry = createQueues({
			driver: persistent({ bullmq: fake.module }),
			processors: [MailProcessor],
		});
		await registry.setup({ initialized: true });
		const retryable = {
			attemptsMade: 1,
			data: {},
			delay: 0,
			getState: async () => 'waiting',
			id: 'retry',
			name: 'send',
			opts: { attempts: 3 },
		};
		fake.workers[0].emit('failed', retryable, new Error('retry'));
		fake.workers[0].emit(
			'failed',
			{ ...retryable, finishedOn: Date.now(), getState: async () => 'failed', id: 'backoff-stop' },
			new Error('stop'),
		);
		const unrecoverable = new Error('unrecoverable');
		unrecoverable.name = 'UnrecoverableError';
		fake.workers[0].emit('failed', { ...retryable, id: 'unrecoverable' }, unrecoverable);
		fake.workers[0].emit('failed', { ...retryable, discarded: true, id: 'discarded' }, new Error('discarded'));
		await flushQueueEvents();

		assert.deepEqual(events, ['retrying:waiting', 'failed', 'failed', 'failed']);
		await registry.close();
	});

	test('uses BullMQ resolved delay and state for custom or jittered retries', async () => {
		const fake = createFakeBullMQ();
		const registry = createQueues({ driver: persistent({ bullmq: fake.module }) });
		const queue = registry.get('mail');
		queue.process(() => 'sent');
		await registry.setup({ initialized: true });
		const retrying = waitForEvent(queue, 'retrying');
		fake.queues[0].setDelayedRunAt('custom-retry', 10_137);

		fake.workers[0].emit(
			'failed',
			{
				attemptsMade: 1,
				data: { email: 'retry@example.com' },
				delay: 137,
				getState: async () => 'delayed',
				id: 'custom-retry',
				name: 'send',
				opts: { attempts: 3, backoff: { delay: 5_000, jitter: 0.5, type: 'custom' } },
			},
			new Error('retry'),
		);

		const payload = await retrying;
		assert.equal(payload.delay, 137);
		assert.equal(payload.job.status, 'delayed');
		assert.equal(payload.job.runAt?.getTime(), 10_137);
		await registry.close();
	});

	test('does not infer completion from BullMQ returnvalue null', async () => {
		const fake = createFakeBullMQ();
		const registry = createQueues({ driver: persistent({ bullmq: fake.module }) });
		const queue = registry.get('mail');
		await registry.setup({ initialized: true });
		fake.queues[0].getJob = async id => {
			if (id === 'completed') return { data: {}, finishedOn: Date.now(), id, name: 'send', returnvalue: null };
			if (id === 'delayed') {
				return { data: {}, delay: 300, getState: async () => 'delayed', id, name: 'send', processedOn: 1_000 };
			}
			return { data: {}, id, name: 'send', returnvalue: null };
		};

		const job = await queue.getJob('waiting');
		const completed = await queue.getJob('completed');
		const delayed = await queue.getJob('delayed');
		assert.equal(job?.status, 'waiting');
		assert.equal(completed?.status, 'completed');
		assert.equal(completed?.result, null);
		assert.equal(delayed?.status, 'delayed');
		assert.equal(delayed?.runAt, undefined);
		await registry.close();
	});

	test('keeps worker handlers separate from QueueEvents lifecycle events', async () => {
		const fake = createFakeBullMQ();
		const queueEvents: string[] = [];
		const workerEvents: string[] = [];

		class MailProcessor {
			handle(job: QueueJobOf<'mail'>) {
				return `worker:${job.name}:${job.data.email}`;
			}

			queueCompleted(payload: { job: QueueJobOf<'mail'> | undefined; jobId: string; result: string }) {
				queueEvents.push(payload.result);
			}

			workerCompleted(payload: { job: QueueJobOf<'mail'>; result: string }) {
				workerEvents.push(payload.result);
			}
		}

		Processor('mail')(MailProcessor);
		Process()(MailProcessor.prototype, 'handle');
		OnQueueEvent('completed')(MailProcessor.prototype, 'queueCompleted');
		OnWorkerEvent('completed')(MailProcessor.prototype, 'workerCompleted');

		const registry = createQueues({
			driver: persistent({ bullmq: fake.module }),
			processors: [MailProcessor],
		});

		await registry.setup({ initialized: true });
		const bullJob = {
			data: { email: 'hi@example.com' },
			id: 'job-1',
			name: 'send',
		};
		const result = await fake.workers[0].processor(bullJob);
		fake.workers[0].emit('completed', bullJob, result);

		assert.deepEqual(queueEvents, []);
		assert.deepEqual(workerEvents, ['worker:send:hi@example.com']);

		fake.queueEvents[0].emit('completed', {
			jobId: 'job-1',
			returnvalue: 'queue:send:hi@example.com',
		});
		await flushQueueEvents();

		assert.deepEqual(queueEvents, ['queue:send:hi@example.com']);
		assert.deepEqual(workerEvents, ['worker:send:hi@example.com']);

		await registry.close();
	});
});
