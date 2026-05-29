import { LockManager } from '@slipher/locks';
import { RedisLockStore } from '@slipher/locks/redis';
import { assert, describe, test } from 'vitest';
import { Queue } from '../src';

const redisUrl = process.env.REDIS_URL;

function wait(milliseconds: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function waitForQueueOutcome(queue: Queue): Promise<'completed' | 'skipped'> {
	return new Promise(resolve => {
		queue.on('completed', () => resolve('completed'));
		queue.on('skipped', () => resolve('skipped'));
	});
}

if (!redisUrl) {
	describe.skip('Queue Redis locks', () => {
		test('requires REDIS_URL to run integration tests', () => {});
	});
} else {
	describe('Queue Redis locks', () => {
		test('prevents two shard-local queues from processing the same locked job', async () => {
			const namespace = `slipher-queue-lock-test:${process.pid}:${Date.now()}`;
			const storeA = new RedisLockStore({ redisOptions: { url: redisUrl }, namespace });
			const storeB = new RedisLockStore({ redisOptions: { url: redisUrl }, namespace });
			await Promise.all([storeA.start(), storeB.start()]);
			await storeA.clear();

			const processed: string[] = [];
			const locksA = new LockManager({ store: storeA });
			const locksB = new LockManager({ store: storeB });
			const queueA = new Queue('sync', {
				lock: locksA,
				lockOptions: { ttl: '200ms' },
			});
			const queueB = new Queue('sync', {
				lock: locksB,
				lockOptions: { ttl: '200ms' },
			});

			try {
				const outcomeA = waitForQueueOutcome(queueA);
				const outcomeB = waitForQueueOutcome(queueB);

				queueA.process(async () => {
					processed.push('a');
					await wait(35);
					return 'ok';
				});
				queueB.process(async () => {
					processed.push('b');
					await wait(35);
					return 'ok';
				});

				queueA.add({ guildId: '1' }, { id: 'same-job' });
				queueB.add({ guildId: '1' }, { id: 'same-job' });

				const outcomes = await Promise.all([outcomeA, outcomeB]);

				assert.equal(processed.length, 1);
				assert.deepEqual(outcomes.sort(), ['completed', 'skipped']);
			} finally {
				queueA.clear();
				queueB.clear();
				await storeA.clear();
				await Promise.all([storeA.quit(), storeB.quit()]);
			}
		});
	});
}
