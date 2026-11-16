import { createClient } from '@redis/client';
import { afterAll, assert, beforeAll, describe, expect, test } from 'vitest';
import { ExpirableRedisAdapter, RedisAdapter } from '../src';

const redisOptions = { url: process.env.SLIPHER_REDIS_URL ?? 'redis://127.0.0.1:6379' };
const adapters: RedisAdapter<boolean>[] = [];
let sequence = 0;

async function start<T extends RedisAdapter<boolean>>(adapter: T): Promise<T> {
	await adapter.start();
	adapters.push(adapter);
	return adapter;
}

function namespace() {
	return `slipher_increment_${process.pid}_${sequence++}`;
}

afterAll(async () => {
	await Promise.all(
		adapters.map(async adapter => {
			await adapter.flush();
			adapter.client.close();
		}),
	);
});

describe.each([
	['RedisAdapter', (namespace: string) => new RedisAdapter({ namespace, redisOptions })],
	[
		'ExpirableRedisAdapter',
		(namespace: string) =>
			new ExpirableRedisAdapter({ namespace, redisOptions }, { default: { expire: 60_000, ondemand: true } }),
	],
] as const)('%s atomic increments', (_name, createAdapter) => {
	let adapter: RedisAdapter<boolean>;
	let peer: RedisAdapter<boolean>;
	beforeAll(async () => {
		const shared = namespace();
		adapter = await start(createAdapter(shared));
		peer = await start(createAdapter(shared));
	});

	test('preserves concurrent deltas from independent clients and unrelated patches', async () => {
		await adapter.set('guild.concurrent', { member_count: 0, name: 'before' }, ['guild', 'concurrent']);
		const results = await Promise.all([
			...Array.from({ length: 100 }, (_, index) =>
				(index % 2 ? peer : adapter).increment('guild.concurrent', 'member_count', 1, { min: 0 }),
			),
			peer.patch('guild.concurrent', { name: 'after' }, ['guild', 'concurrent']),
		]);
		assert.deepEqual(
			results.slice(0, 100).sort((a, b) => a! - b!),
			Array.from({ length: 100 }, (_, i) => i + 1),
		);
		assert.deepEqual(await adapter.get('guild.concurrent'), { member_count: 100, name: 'after' });
		assert.deepEqual(await adapter.keys('guild'), ['guild.concurrent']);
	});

	test.each([
		[0.1, 0.2],
		[1.2345678901234567, 0],
		[Number.MIN_VALUE, Number.MIN_VALUE],
		[Number.MAX_VALUE, 0],
		[2 ** 53, 2],
		[1, -1.5],
	])('round trips finite doubles: %s + %s', async (previous, delta) => {
		await adapter.set('guild.precision', { member_count: previous }, ['guild', 'precision']);
		assert.equal(await adapter.increment('guild.precision', 'member_count', delta), previous + delta);
		assert.equal((await adapter.get('guild.precision')).member_count, previous + delta);
	});

	test('clamps to a minimum, including a negatively overflowing sum', async () => {
		await adapter.set('guild.minimum', { member_count: 1 }, ['guild', 'minimum']);
		assert.equal(await adapter.increment('guild.minimum', 'member_count', -2, { min: 0 }), 0);
		await adapter.patch('guild.minimum', { member_count: -Number.MAX_VALUE }, ['guild', 'minimum']);
		assert.equal(await adapter.increment('guild.minimum', 'member_count', -Number.MAX_VALUE, { min: 0 }), 0);
	});

	test('does not create missing records or fields, coerce nonnumbers, or increment arrays', async () => {
		assert.isUndefined(await adapter.increment('guild.absent', 'member_count', 1));
		assert.isUndefined(await adapter.get('guild.absent'));
		for (const value of [
			{},
			{ member_count: '3' },
			{ member_count: null },
			{ member_count: true },
			{ member_count: Number.NaN },
			{ member_count: Number.POSITIVE_INFINITY },
			[{ member_count: 3 }],
		]) {
			await adapter.set('guild.noop', value, ['guild', 'noop']);
			const before = await adapter.client.hGetAll(`${adapter.namespace}:guild.noop`);
			assert.isUndefined(await adapter.increment('guild.noop', 'member_count', 1));
			assert.deepEqual(await adapter.client.hGetAll(`${adapter.namespace}:guild.noop`), before);
		}
		assert.equal(await adapter.contains('guild', 'absent'), false);
	});

	test('rejects invalid bounds and overflow without modifying the entry', async () => {
		await adapter.set('guild.invalid', { member_count: Number.MAX_VALUE }, ['guild', 'invalid']);
		for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			await expect(adapter.increment('guild.invalid', 'member_count', invalid)).rejects.toThrow('finite');
			await expect(adapter.increment('guild.invalid', 'member_count', 1, { min: invalid })).rejects.toThrow('finite');
		}
		await expect(adapter.increment('guild.invalid', 'member_count', Number.MAX_VALUE)).rejects.toThrow('finite');
		assert.equal((await adapter.get('guild.invalid')).member_count, Number.MAX_VALUE);
	});

	test('uses stored ownership for scoped relationships and accepts prefixed keys', async () => {
		await adapter.set('message.one', { reactions: 3, text: 'keep' }, ['message.channel', 'one']);
		assert.equal(await adapter.increment(`${adapter.namespace}:message.one`, 'reactions', -1), 2);
		assert.deepEqual(await adapter.get('message.one'), { reactions: 2, text: 'keep' });
		assert.deepEqual(await adapter.keys('message.channel'), ['message.one']);
		assert.deepEqual(await adapter.keys('message'), []);
		await adapter.removeToRelationship('message.channel', 'one');
		assert.isUndefined(await adapter.increment('message.one', 'reactions', 1));
		assert.isUndefined(await adapter.get('message.one'));
	});

	test('does not retry an increment after an uncertain transport failure', async () => {
		await adapter.set('guild.reply', { member_count: 1 }, ['guild', 'reply']);
		const originalEvalSha = adapter.client.evalSha.bind(adapter.client);
		const mutableClient = adapter.client as unknown as { evalSha: typeof adapter.client.evalSha };
		mutableClient.evalSha = (async (...args: Parameters<typeof adapter.client.evalSha>) => {
			await originalEvalSha(...args);
			throw new Error('simulated lost reply');
		}) as typeof adapter.client.evalSha;
		try {
			await expect(adapter.increment('guild.reply', 'member_count', 1)).rejects.toThrow('lost reply');
		} finally {
			mutableClient.evalSha = originalEvalSha;
		}
		assert.equal((await adapter.get('guild.reply')).member_count, 2);
	});

	test('preflights relationship types before changing values or deadlines', async () => {
		await adapter.set('message.corrupt', { count: 3 }, ['message.corrupt-channel', 'corrupt']);
		const key = `${adapter.namespace}:message.corrupt`;
		await adapter.client.pExpire(key, 10_000);
		const deadline = await adapter.client.pExpireTime(key);
		const relationshipKey = `${adapter.namespace}:relationships:message.corrupt-channel`;
		await adapter.client.del(relationshipKey);
		await adapter.client.set(relationshipKey, 'wrong type');
		try {
			await expect(adapter.increment('message.corrupt', 'count', 1)).rejects.toThrow('WRONGTYPE');
			assert.equal(await adapter.client.hGet(key, 'N_count'), '3');
			assert.equal(await adapter.client.pExpireTime(key), deadline);
		} finally {
			await adapter.client.del(relationshipKey);
		}
	});
});

describe('increment expiration and local caching', () => {
	async function deadlines(adapter: RedisAdapter<boolean>, key: string) {
		return [
			await adapter.client.pExpireTime(`${adapter.namespace}:guild.${key}`),
			...((await adapter.client.sendCommand([
				'HPEXPIRETIME',
				`${adapter.namespace}:relationships:guild`,
				'FIELDS',
				'1',
				key,
			])) as number[]),
			...((await adapter.client.sendCommand([
				'HPEXPIRETIME',
				`${adapter.namespace}:relationships:owners`,
				'FIELDS',
				'1',
				`guild.${key}`,
			])) as number[]),
		];
	}

	test.each([
		'refresh',
		'preserve',
		'persist',
		'basic',
	] as const)('applies the %s patch policy to every expiration authority', async policy => {
		const shared = namespace();
		const seed = await start(
			new ExpirableRedisAdapter({ namespace: shared, redisOptions }, { guild: { expire: 10_000 } }),
		);
		await seed.set('guild.ttl', { member_count: 3 }, ['guild', 'ttl']);
		const before = await deadlines(seed, 'ttl');
		const adapter = await start(
			policy === 'basic'
				? new RedisAdapter({ namespace: shared, redisOptions })
				: new ExpirableRedisAdapter(
						{ namespace: shared, redisOptions },
						{
							guild: {
								expire: policy === 'refresh' ? 60_000 : policy === 'persist' ? 0 : undefined,
							},
						},
					),
		);
		assert.equal(await adapter.increment('guild.ttl', 'member_count', 1), 4);
		const after = await deadlines(adapter, 'ttl');
		assert.equal(after[0], after[1]);
		assert.equal(after[0], after[2]);
		if (policy === 'refresh') assert.isAbove(after[0]!, before[0]! + 40_000);
		else if (policy === 'preserve') assert.deepEqual(after, before);
		else assert.deepEqual(after, [-1, -1, -1]);
	});

	test('no-ops and invalid results do not refresh TTL, and expired records stay absent', async () => {
		const adapter = await start(
			new ExpirableRedisAdapter({ namespace: namespace(), redisOptions }, { guild: { expire: 60_000 } }),
		);
		await adapter.set('guild.noop', { member_count: Number.MAX_VALUE }, ['guild', 'noop']);
		const before = await deadlines(adapter, 'noop');
		assert.isUndefined(await adapter.increment('guild.noop', 'missing', 1));
		await expect(adapter.increment('guild.noop', 'member_count', Number.MAX_VALUE)).rejects.toThrow('finite');
		assert.deepEqual(await deadlines(adapter, 'noop'), before);
		await adapter.client.pExpireAt(`${adapter.namespace}:guild.noop`, Date.now() - 1);
		assert.isUndefined(await adapter.increment('guild.noop', 'member_count', 1));
		assert.isUndefined(await adapter.get('guild.noop'));
	});

	test('rejects unsupported expiration deadlines before mutating the count', async () => {
		const shared = namespace();
		const seed = await start(new RedisAdapter({ namespace: shared, redisOptions }));
		await seed.set('guild.deadline', { member_count: 2 }, ['guild', 'deadline']);
		const adapter = await start(
			new ExpirableRedisAdapter({ namespace: shared, redisOptions }, { guild: { expire: Number.MAX_SAFE_INTEGER } }),
		);
		await expect(adapter.increment('guild.deadline', 'member_count', 1)).rejects.toThrow('deadline');
		assert.equal((await seed.get('guild.deadline')).member_count, 2);
		assert.deepEqual(await deadlines(seed, 'deadline'), [-1, -1, -1]);
	});

	test('invalidates RESP3 native client-side caching on increment', async () => {
		const adapter = await start(
			new ExpirableRedisAdapter(
				{
					namespace: namespace(),
					client: createClient({
						...redisOptions,
						RESP: 3,
						clientSideCache: { ttl: 0, maxEntries: 100, evictPolicy: 'LRU' },
					}),
				},
				{ guild: { native: true } },
			),
		);
		await adapter.set('guild.native', { member_count: 1 }, ['guild', 'native']);
		assert.equal((await adapter.get('guild.native')).member_count, 1);
		assert.equal(await adapter.increment('guild.native', 'member_count', 1), 2);
		assert.equal((await adapter.get('guild.native')).member_count, 2);
	});

	test('does not republish an older write snapshot after increment completes', async () => {
		const adapter = await start(
			new ExpirableRedisAdapter({ namespace: namespace(), redisOptions }, { guild: { ondemand: true } }),
		);
		const originalEvalSha = adapter.client.evalSha.bind(adapter.client);
		const mutableClient = adapter.client as unknown as { evalSha: typeof adapter.client.evalSha };
		const { promise: written, resolve: markWritten } = Promise.withResolvers<void>();
		const { promise: gate, resolve: release } = Promise.withResolvers<void>();
		mutableClient.evalSha = (async (...args: Parameters<typeof adapter.client.evalSha>) => {
			const result = await originalEvalSha(...args);
			markWritten();
			await gate;
			return result;
		}) as typeof adapter.client.evalSha;
		const write = adapter.set('guild.delayed', { member_count: 1 }, ['guild', 'delayed']);
		try {
			await written;
			mutableClient.evalSha = originalEvalSha;
			assert.equal(await adapter.increment('guild.delayed', 'member_count', 1), 2);
		} finally {
			release();
			await write;
			mutableClient.evalSha = originalEvalSha;
		}
		assert.equal((await adapter.get('guild.delayed')).member_count, 2);
	});

	test('invalidates on-demand snapshots and stale reads that settle after an increment', async () => {
		const adapter = await start(
			new ExpirableRedisAdapter({ namespace: namespace(), redisOptions }, { guild: { ondemand: true } }),
		);
		await adapter.set('guild.local', { member_count: 1, name: 'keep' }, ['guild', 'local']);
		assert.equal((await adapter.get('guild.local')).member_count, 1);
		assert.equal(await adapter.increment('guild.local', 'member_count', 1), 2);
		assert.equal((await adapter.get('guild.local')).member_count, 2);

		// Evict the snapshot to begin a Redis read, then delay only its reply.
		assert.isUndefined(await adapter.increment('guild.local', 'absent', 1));
		const originalMulti = adapter.client.multi.bind(adapter.client);
		const { promise: readStarted, resolve: markReadStarted } = Promise.withResolvers<void>();
		const { promise: gate, resolve: release } = Promise.withResolvers<void>();
		adapter.client.multi = ((...args: Parameters<typeof adapter.client.multi>) => {
			const transaction = originalMulti(...args);
			const originalExec = transaction.exec.bind(transaction);
			transaction.exec = (async (...execArgs: Parameters<typeof transaction.exec>) => {
				const result = await originalExec(...execArgs);
				markReadStarted();
				await gate;
				return result;
			}) as typeof transaction.exec;
			return transaction;
		}) as typeof adapter.client.multi;
		const staleRead = adapter.get('guild.local');
		try {
			await readStarted;
			assert.equal(await adapter.increment('guild.local', 'member_count', 1), 3);
			release();
			assert.equal((await staleRead).member_count, 2);
		} finally {
			release();
			await staleRead;
			adapter.client.multi = originalMulti;
		}
		assert.deepEqual(await adapter.get('guild.local'), { member_count: 3, name: 'keep' });
	});
});
