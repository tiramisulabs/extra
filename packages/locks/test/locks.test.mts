import { assert, describe, test } from 'vitest';
import { LockAcquireError, LockManager, MemoryLockStore, parseDuration } from '../src';

function wait(milliseconds: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function expectRejects(action: () => Promise<unknown>, validate: (error: unknown) => void): Promise<void> {
	let thrown: unknown;

	try {
		await action();
	} catch (error) {
		thrown = error;
	}

	if (!thrown) throw new Error('Expected promise to reject.');
	validate(thrown);
}

describe('parseDuration', () => {
	test('parses positive lock durations', () => {
		assert.equal(parseDuration(100), 100);
		assert.equal(parseDuration('100ms'), 100);
		assert.equal(parseDuration('2s 50ms'), 2050);
		assert.equal(parseDuration('1m'), 60_000);
	});

	test('rejects malformed or zero durations', () => {
		assert.throws(() => parseDuration(0), RangeError);
		assert.throws(() => parseDuration('0ms'), RangeError);
		assert.throws(() => parseDuration('later'), RangeError);
		assert.throws(() => parseDuration('1s later'), RangeError);
	});
});

describe('LockManager', () => {
	test('acquires a free lock with ownership and expiry metadata', async () => {
		const locks = new LockManager({ now: () => 1000, tokenGenerator: () => 'token-1' });

		const lock = await locks.acquire('jobs:daily-report', { ttl: '30s' });

		assert.equal(lock.key, 'jobs:daily-report');
		assert.equal(lock.token, 'token-1');
		assert.equal(lock.acquiredAt.getTime(), 1000);
		assert.equal(lock.expiresAt.getTime(), 31_000);
	});

	test('denies immediate acquisition while a lock is held', async () => {
		const locks = new LockManager();

		await locks.acquire('guild:1:sync', { ttl: '1s' });

		await expectRejects(
			() => locks.acquire('guild:1:sync'),
			error => {
				assert.instanceOf(error, LockAcquireError);
			},
		);
	});

	test('waits for a held lock to be released', async () => {
		const locks = new LockManager();
		const first = await locks.acquire('guild:2:sync', { ttl: '1s' });
		const second = locks.acquire('guild:2:sync', { wait: '50ms', retryInterval: '1ms' });

		await wait(5);
		assert.equal(await locks.release(first), true);
		const acquired = await second;

		assert.equal(acquired.key, 'guild:2:sync');
		assert.notEqual(acquired.token, first.token);
		await locks.release(acquired);
	});

	test('only releases when the ownership token matches', async () => {
		const locks = new LockManager();
		const lock = await locks.acquire('jobs:exclusive', { ttl: '1s' });

		const releasedWrongOwner = await locks.release({ ...lock, token: 'other-token' });

		assert.equal(releasedWrongOwner, false);
		await expectRejects(
			() => locks.acquire('jobs:exclusive'),
			error => {
				assert.instanceOf(error, LockAcquireError);
			},
		);
		assert.equal(await locks.release(lock), true);
		assert.ok(await locks.acquire('jobs:exclusive'));
	});

	test('allows acquisition after TTL expiration', async () => {
		let now = 0;
		const locks = new LockManager({ now: () => now, tokenGenerator: () => `token-${now}` });
		const first = await locks.acquire('stale', { ttl: '10ms' });

		now = 11;
		const second = await locks.acquire('stale', { ttl: '10ms' });

		assert.equal(first.token, 'token-0');
		assert.equal(second.token, 'token-11');
		assert.equal(await locks.release(first), false);
		assert.equal(await locks.release(second), true);
	});

	test('extends a lock only for the current owner', async () => {
		let now = 0;
		const locks = new LockManager({ now: () => now });
		const lock = await locks.acquire('extendable', { ttl: '10ms' });

		now = 5;
		assert.equal(await locks.extend(lock, '20ms'), true);
		assert.equal(lock.expiresAt.getTime(), 25);

		now = 15;
		await expectRejects(
			() => locks.acquire('extendable'),
			error => {
				assert.instanceOf(error, LockAcquireError);
			},
		);
		assert.equal(await locks.extend({ ...lock, token: 'other-token' }, '20ms'), false);

		now = 26;
		const next = await locks.acquire('extendable', { ttl: '10ms' });
		assert.notEqual(next.token, lock.token);
	});

	test('withLock releases on success', async () => {
		const locks = new LockManager();

		const result = await locks.withLock('with-success', async lock => {
			assert.equal(lock.key, 'with-success');
			return 'ok';
		});
		const next = await locks.acquire('with-success');

		assert.equal(result, 'ok');
		assert.equal(next.key, 'with-success');
		await locks.release(next);
	});

	test('withLock releases on throw', async () => {
		const locks = new LockManager();
		const error = new Error('boom');

		await expectRejects(
			() =>
				locks.withLock('with-throw', async () => {
					throw error;
				}),
			thrown => {
				assert.equal(thrown, error);
			},
		);

		const next = await locks.acquire('with-throw');
		assert.equal(next.key, 'with-throw');
		await locks.release(next);
	});

	test('fails predictably when wait timeout expires', async () => {
		const locks = new LockManager();
		const lock = await locks.acquire('timeout', { ttl: '1s' });

		await expectRejects(
			() => locks.acquire('timeout', { wait: '5ms', retryInterval: '1ms' }),
			error => {
				assert.instanceOf(error, LockAcquireError);
				assert.include((error as Error).message, 'timeout');
			},
		);
		await locks.release(lock);
	});

	test('wait timeout uses elapsed time when lock time is controlled', async () => {
		const controller = new AbortController();
		const safety = setTimeout(() => controller.abort(new Error('timeout test safety abort')), 20);
		const locks = new LockManager({ now: () => 0 });

		await locks.acquire('controlled-timeout', { ttl: '1s' });

		try {
			await expectRejects(
				() => locks.acquire('controlled-timeout', { wait: '5ms', retryInterval: '1ms', signal: controller.signal }),
				error => {
					assert.instanceOf(error, LockAcquireError);
					assert.include((error as Error).message, 'timeout');
				},
			);
		} finally {
			clearTimeout(safety);
		}
	});

	test('aborts a waiting acquisition when the signal aborts', async () => {
		const locks = new LockManager();
		const lock = await locks.acquire('abort', { ttl: '1s' });
		const controller = new AbortController();
		const waiting = locks.acquire('abort', { wait: '1s', retryInterval: '5ms', signal: controller.signal });
		const rejected = expectRejects(
			() => waiting,
			error => {
				assert.instanceOf(error, Error);
				assert.include((error as Error).message, 'stop waiting');
			},
		);

		controller.abort(new Error('stop waiting'));

		await rejected;
		await locks.release(lock);
	});
});

describe('MemoryLockStore', () => {
	test('can clear all local locks', async () => {
		const store = new MemoryLockStore();
		const locks = new LockManager({ store });

		await locks.acquire('a');
		await locks.acquire('b');
		store.clear();

		assert.equal(store.size, 0);
	});
});
