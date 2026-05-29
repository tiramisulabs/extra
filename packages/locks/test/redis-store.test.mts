import { afterAll, assert, beforeAll, describe, test } from 'vitest';
import { LockAcquireError, LockManager } from '../src';
import { RedisLockStore } from '../src/redis';

const redisUrl = process.env.REDIS_URL;

function wait(milliseconds: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function expectRejects(action: () => Promise<unknown>, validate: (error: unknown) => void): Promise<void> {
	let didReject = false;
	let thrown: unknown;

	try {
		await action();
	} catch (error) {
		didReject = true;
		thrown = error;
	}

	if (!didReject) throw new Error('Expected promise to reject.');
	validate(thrown);
}

if (!redisUrl) {
	describe.skip('RedisLockStore', () => {
		test('requires REDIS_URL to run integration tests', () => {});
	});
} else {
	describe('RedisLockStore', () => {
		const namespace = `slipher-locks-test:${process.pid}:${Date.now()}`;
		const storeA = new RedisLockStore({ redisOptions: { url: redisUrl }, namespace });
		const storeB = new RedisLockStore({ redisOptions: { url: redisUrl }, namespace });
		const locksA = new LockManager({ store: storeA, tokenGenerator: () => 'token-a' });
		const locksB = new LockManager({ store: storeB, tokenGenerator: () => 'token-b' });

		beforeAll(async () => {
			await Promise.all([storeA.start(), storeB.start()]);
			await storeA.clear();
		});

		afterAll(async () => {
			await storeA.clear();
			await Promise.all([storeA.quit(), storeB.quit()]);
		});

		test('coordinates acquisition across separate managers', async () => {
			const first = await locksA.acquire('shared', { ttl: '200ms' });

			await expectRejects(
				() => locksB.acquire('shared'),
				error => {
					assert.instanceOf(error, LockAcquireError);
				},
			);

			assert.equal(await locksA.release(first), true);
			const second = await locksB.acquire('shared', { ttl: '200ms' });

			assert.equal(second.token, 'token-b');
			assert.equal(await locksB.release(second), true);
		});

		test('only the owner token can release or extend a Redis lock', async () => {
			const lock = await locksA.acquire('owned', { ttl: '200ms' });

			assert.equal(await locksB.release({ ...lock, token: 'wrong-token' }), false);
			assert.equal(await locksB.extend({ ...lock, token: 'wrong-token' }, '200ms'), false);
			await expectRejects(
				() => locksB.acquire('owned'),
				error => {
					assert.instanceOf(error, LockAcquireError);
				},
			);

			assert.equal(await locksA.extend(lock, '200ms'), true);
			assert.equal(await locksA.release(lock), true);
		});

		test('allows another manager to acquire after Redis TTL expiration', async () => {
			const lock = await locksA.acquire('expires', { ttl: '20ms' });

			await wait(35);
			const next = await locksB.acquire('expires', { ttl: '200ms' });

			assert.equal(next.token, 'token-b');
			assert.equal(await locksA.release(lock), false);
			assert.equal(await locksB.release(next), true);
		});
	});
}
