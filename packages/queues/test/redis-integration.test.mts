import { randomUUID } from 'node:crypto';
import { assert, describe, test } from 'vitest';
import { createQueues, persistent } from '../src';

const redisPort = process.env.SLIPHER_REDIS_PORT ?? (process.env.CI ? '6379' : undefined);

describe.runIf(redisPort)('BullMQ Redis integration', () => {
	test('waits for readiness, honors autostart, and reports removed global jobs without fabricating data', async () => {
		const queueName = `slipher-integration-${randomUUID()}`;
		const registry = createQueues({
			driver: persistent({
				connection: {
					host: '127.0.0.1',
					maxRetriesPerRequest: null,
					port: Number(redisPort),
				},
				defaultJobOptions: { removeOnComplete: true },
				prefix: `slipher-test-${randomUUID()}`,
			}),
		});
		const queue = registry.get<{ value: number }, number>(queueName, { autostart: false });
		let processed = 0;
		queue.process(job => {
			processed++;
			return job.data.value * 2;
		});

		try {
			await registry.setup({ initialized: true });
			const completed = new Promise<{
				job: undefined | { id: string };
				jobId: string;
				result: number;
			}>(resolve => queue.once('completed', resolve));
			const job = await queue.add({ value: 21 }, { id: randomUUID(), priority: 10 });
			assert.deepEqual(await queue.counts(), {
				active: 0,
				completed: 0,
				delayed: 0,
				failed: 0,
				total: 1,
				waiting: 1,
			});
			await delay(100);
			assert.equal(processed, 0);

			await queue.start();
			const event = await Promise.race([
				completed,
				delay(5_000).then(() => {
					throw new Error('Timed out waiting for BullMQ completion.');
				}),
			]);
			assert.equal(processed, 1);
			assert.equal(event.jobId, job.id);
			assert.equal(event.job, undefined);
			assert.equal(event.result, 42);
			assert.equal(await queue.getJob(job.id), undefined);
		} finally {
			await registry.close();
		}
	}, 10_000);

	test('reads the exact delayed retry timestamp from Redis', async () => {
		const queueName = `slipher-retry-${randomUUID()}`;
		const registry = createQueues({
			driver: persistent({
				connection: {
					host: '127.0.0.1',
					maxRetriesPerRequest: null,
					port: Number(redisPort),
				},
				prefix: `slipher-retry-test-${randomUUID()}`,
			}),
		});
		const queue = registry.get<{ value: number }, number>(queueName, { attempts: 2, retryDelay: 300 });
		const attemptsStarted: number[] = [];
		queue.process(job => {
			attemptsStarted.push(Date.now());
			if (attemptsStarted.length === 1) throw new Error('retry once');
			return job.data.value * 2;
		});

		try {
			await registry.setup({ initialized: true });
			const retrying = new Promise<{
				delay: number;
				job: { id: string; runAt?: Date; status: string };
			}>(resolve => queue.once('retrying', resolve));
			const completed = new Promise<void>(resolve => queue.once('completed', () => resolve()));
			const job = await queue.add({ value: 21 }, { id: randomUUID() });
			const retry = await retrying;
			const lookup = await queue.getJob(job.id);

			assert.equal(retry.delay, 300);
			assert.equal(retry.job.status, 'delayed');
			assert.equal(lookup?.status, 'delayed');
			assert.ok(retry.job.runAt);
			assert.ok(lookup?.runAt);
			assert.equal(lookup.runAt.getTime(), retry.job.runAt.getTime());

			await completed;
			assert.equal(attemptsStarted.length, 2);
			assert.isAtLeast(lookup.runAt.getTime() - attemptsStarted[0], 250);
			assert.isBelow(Math.abs(attemptsStarted[1] - lookup.runAt.getTime()), 200);
		} finally {
			await registry.close();
		}
	}, 10_000);
});

function delay(milliseconds: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}
