import IORedis from 'ioredis';
import { assert, test } from 'vitest';
import { type BullMQModule, createScheduler, persistent, type SchedulerEventPayloads } from '../src';

const redisUrl = process.env.SLIPHER_SCHEDULER_REDIS_URL;
const redisTest = redisUrl ? test : test.skip;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
	return new Promise<T>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error('Timed out waiting for BullMQ worker')), timeoutMs);
		promise.then(
			value => {
				clearTimeout(timeout);
				resolve(value);
			},
			error => {
				clearTimeout(timeout);
				reject(error);
			},
		);
	});
}

const bullmqVersions = [
	['5.79.3', () => import('bullmq-v5')],
	['6.1.2', () => import('bullmq')],
] as const;

for (const [version, loadBullMQ] of bullmqVersions) {
	redisTest(`runs through real BullMQ ${version}, ioredis, and Redis`, async () => {
		const bullmq = await loadBullMQ();
		const Queue = bullmq.Queue as unknown as typeof import('bullmq').Queue;
		const QueueEvents = bullmq.QueueEvents as unknown as typeof import('bullmq').QueueEvents;
		const connection = new IORedis(redisUrl!, { maxRetriesPerRequest: null });
		const prefix = `slipher-scheduler-smoke-${version}-${process.pid}-${Date.now()}`;
		const queueName = 'slipher-scheduler';
		const schedulerErrors: unknown[] = [];
		const registry = createScheduler({
			driver: persistent({
				bullmq: bullmq as unknown as BullMQModule,
				connection,
				prefix,
			}),
			logger: {
				error: (...args: unknown[]) => schedulerErrors.push(args),
			},
		});
		const queue = new Queue(queueName, { connection, prefix });
		const queueEvents = new QueueEvents(queueName, { connection, prefix });
		queue.on('error', () => undefined);
		queueEvents.on('error', () => undefined);
		connection.on('error', () => undefined);

		let resolveCompleted: ((payload: SchedulerEventPayloads['completed']) => void) | undefined;
		const completed = new Promise<SchedulerEventPayloads['completed']>(resolve => {
			resolveCompleted = resolve;
		});
		registry.once('completed', payload => resolveCompleted?.(payload));
		registry.interval('redis-smoke', '30s', () => 'redis-ok');

		try {
			await Promise.all([queue.waitUntilReady(), queueEvents.waitUntilReady()]);
			await registry.setup({ initialized: true });

			let resolveQueueEvent: (() => void) | undefined;
			const queueEvent = new Promise<void>(resolve => {
				resolveQueueEvent = resolve;
			});
			queueEvents.on('completed', ({ jobId }) => {
				if (typeof jobId === 'string') resolveQueueEvent?.();
			});
			await queue.add('redis-smoke', { taskId: 'redis-smoke' });

			const [payload] = await Promise.all([withTimeout(completed, 10_000), withTimeout(queueEvent, 10_000)]);
			assert.equal(payload.task.id, 'redis-smoke');
			assert.equal(payload.result, 'redis-ok');
			await registry.close();
			assert.deepEqual(schedulerErrors, []);
		} finally {
			await registry.close().catch(() => undefined);
			await queueEvents.close();
			await queue.obliterate({ force: true });
			await queue.close();
			await connection.quit();
		}
	});
}
