import { assert, describe, test } from 'vitest';
import { MemoryRateLimitStore, parseDuration, RateLimiter, serializeRateLimitKey } from '../src';

function wait(milliseconds: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}

describe('parseDuration', () => {
	test('parses numeric milliseconds and human durations', () => {
		assert.equal(parseDuration(1000), 1000);
		assert.equal(parseDuration('1s'), 1000);
		assert.equal(parseDuration('2m 30s'), 150_000);
		assert.equal(parseDuration('1h'), 3_600_000);
	});

	test('rejects malformed durations', () => {
		assert.throws(() => parseDuration('1s later'), RangeError);
		assert.throws(() => parseDuration('0s'), RangeError);
	});
});

describe('serializeRateLimitKey', () => {
	test('serializes nested key segments', () => {
		assert.equal(
			serializeRateLimitKey(['guild', 123n, ['feature', 'ai']]),
			'[["string","guild"],["bigint","123"],[["string","feature"],["string","ai"]]]',
		);
	});

	test('serializes arrays without segment collisions', () => {
		assert.notEqual(serializeRateLimitKey(['a:b', 'c']), serializeRateLimitKey(['a', 'b:c']));
	});
});

describe('RateLimiter', () => {
	test('allows requests until the limit is exhausted', async () => {
		let now = 1000;
		const limiter = new RateLimiter<{ userId: string }>({
			limit: 2,
			window: '10s',
			key: ctx => ['user', ctx.userId],
			now: () => now,
		});

		const first = await limiter.consume({ userId: '1' });
		const second = await limiter.consume({ userId: '1' });
		const third = await limiter.consume({ userId: '1' });

		assert.equal(first.allowed, true);
		assert.equal(first.remaining, 1);
		assert.equal(second.allowed, true);
		assert.equal(second.remaining, 0);
		assert.equal(third.allowed, false);
		assert.equal(third.remaining, 0);
		assert.equal(third.retryAfter, 10_000);

		now += 10_000;
		const afterReset = await limiter.consume({ userId: '1' });

		assert.equal(afterReset.allowed, true);
		assert.equal(afterReset.remaining, 1);
	});

	test('supports variable consume costs', async () => {
		const limiter = new RateLimiter<{ guildId: string }>({
			limit: 10,
			window: '1m',
			key: ctx => ['guild', ctx.guildId, 'ai'],
			now: () => 0,
		});

		const allowed = await limiter.consume({ guildId: '123' }, { cost: 7 });
		const denied = await limiter.consume({ guildId: '123' }, { cost: 4 });

		assert.equal(allowed.allowed, true);
		assert.equal(allowed.used, 7);
		assert.equal(denied.allowed, false);
		assert.equal(denied.used, 7);
	});

	test('supports dynamic limits and shared stores', async () => {
		const store = new MemoryRateLimitStore();
		const options = {
			window: '1d',
			key: (ctx: { guildId: string }) => ['guild', ctx.guildId, 'exports'],
			store,
			now: () => 0,
		};
		const free = new RateLimiter({
			...options,
			limit: 1,
		});
		const premium = new RateLimiter({
			...options,
			limit: 5,
		});

		assert.equal((await free.consume({ guildId: '1' })).allowed, true);
		assert.equal((await free.consume({ guildId: '1' })).allowed, false);
		assert.equal((await premium.consume({ guildId: '1' })).allowed, true);
	});

	test('can peek and reset a key', async () => {
		const limiter = new RateLimiter<{ userId: string }>({
			limit: 2,
			window: '1m',
			key: ctx => ctx.userId,
			now: () => 0,
		});

		await limiter.consume({ userId: '1' });
		const peeked = await limiter.peek({ userId: '1' });
		const reset = await limiter.reset({ userId: '1' });
		const afterReset = await limiter.peek({ userId: '1' });

		assert.equal(peeked.used, 1);
		assert.equal(reset, true);
		assert.equal(afterReset.used, 0);
	});

	test('can abort while waiting for a rate limit window', async () => {
		const limiter = new RateLimiter<{ userId: string }>({
			limit: 1,
			window: '50ms',
			key: ctx => ctx.userId,
		});
		const controller = new AbortController();

		await limiter.consume({ userId: '1' });
		const waiting = limiter.blockUntilAllowed(
			{ userId: '1' },
			{
				signal: controller.signal,
			},
		);
		controller.abort(new Error('stop waiting'));

		const result = await Promise.race([waiting.catch(error => error), wait(20).then(() => new Error('timed out'))]);

		assert.instanceOf(result, Error);
		assert.equal((result as Error).message, 'stop waiting');
	});
});
