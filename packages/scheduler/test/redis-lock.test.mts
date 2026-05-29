import { LockManager, RedisLockStore } from '@slipher/locks';
import { assert, describe, test } from 'vitest';
import { Scheduler } from '../src';

const redisUrl = process.env.REDIS_URL;

function waitForSchedulerOutcome(scheduler: Scheduler): Promise<'completed' | 'skipped'> {
	return new Promise(resolve => {
		scheduler.on('completed', () => resolve('completed'));
		scheduler.on('skipped', () => resolve('skipped'));
	});
}

function wait(milliseconds: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}

if (!redisUrl) {
	describe.skip('Scheduler Redis locks', () => {
		test('requires REDIS_URL to run integration tests', () => {});
	});
} else {
	describe('Scheduler Redis locks', () => {
		test('skips duplicate shard execution when another scheduler holds the Redis lock', async () => {
			const namespace = `slipher-scheduler-lock-test:${process.pid}:${Date.now()}`;
			const storeA = new RedisLockStore({ redisOptions: { url: redisUrl }, namespace });
			const storeB = new RedisLockStore({ redisOptions: { url: redisUrl }, namespace });
			await Promise.all([storeA.start(), storeB.start()]);
			await storeA.clear();

			const runs: string[] = [];
			const schedulerA = new Scheduler({ lock: new LockManager({ store: storeA }) });
			const schedulerB = new Scheduler({ lock: new LockManager({ store: storeB }) });

			try {
				const outcomeA = waitForSchedulerOutcome(schedulerA);
				const outcomeB = waitForSchedulerOutcome(schedulerB);

				schedulerA.every(
					'1h',
					async () => {
						runs.push('a');
						await wait(35);
					},
					{ id: 'daily-sync', runImmediately: true, lockOptions: { ttl: '200ms' } },
				);
				schedulerB.every(
					'1h',
					async () => {
						runs.push('b');
						await wait(35);
					},
					{ id: 'daily-sync', runImmediately: true, lockOptions: { ttl: '200ms' } },
				);

				const outcomes = await Promise.all([outcomeA, outcomeB]);

				assert.equal(runs.length, 1);
				assert.deepEqual(outcomes.sort(), ['completed', 'skipped']);
			} finally {
				schedulerA.clear();
				schedulerB.clear();
				await storeA.clear();
				await Promise.all([storeA.quit(), storeB.quit()]);
			}
		});
	});
}
