import { Queue } from 'bullmq';
import { assert, test } from 'vitest';
import { createScheduler, persistent, type SchedulerEventPayloads } from '../src';

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

redisTest('runs a persistent scheduled task through real BullMQ and Redis', async () => {
	const url = new URL(redisUrl!);
	const connection = {
		host: url.hostname,
		port: Number(url.port || 6379),
		...(url.password ? { password: url.password } : {}),
	};
	const queueName = `slipher-scheduler-smoke-${process.pid}-${Date.now()}`;
	const registry = createScheduler({
		driver: persistent({ connection, queueName }),
	});
	let resolveCompleted: ((payload: SchedulerEventPayloads['completed']) => void) | undefined;
	const completed = new Promise<SchedulerEventPayloads['completed']>(resolve => {
		resolveCompleted = resolve;
	});
	registry.once('completed', payload => resolveCompleted?.(payload));
	registry.interval('redis-smoke', '30s', () => 'redis-ok', { runImmediately: true });

	try {
		await registry.setup({ initialized: true });
		const payload = await withTimeout(completed, 10_000);
		assert.equal(payload.task.id, 'redis-smoke');
		assert.equal(payload.result, 'redis-ok');
	} finally {
		await registry.close();
		const queue = new Queue(queueName, { connection });
		await queue.obliterate({ force: true });
		await queue.close();
	}
});
