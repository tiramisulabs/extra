import { Cache, CacheFrom, PresenceUpdateStatus } from 'seyfert';
import { afterAll, assert, beforeAll, describe, expect, test } from 'vitest';
import { ExpirableRedisAdapter, RedisAdapter } from '../src';

const redisOptions = { url: process.env.SLIPHER_REDIS_URL ?? 'redis://127.0.0.1:6379' };

describe.each([
	['RedisAdapter', (namespace: string) => new RedisAdapter({ namespace, redisOptions })],
	[
		'ExpirableRedisAdapter',
		(namespace: string) =>
			new ExpirableRedisAdapter({ namespace, redisOptions }, { default: { expire: 60_000, ondemand: true } }),
	],
] as const)('%s final Seyfert contract', (name, createAdapter) => {
	let adapter: RedisAdapter<boolean>;
	const namespace = `slipher_contract_${name}_${process.pid}`;

	beforeAll(async () => {
		adapter = createAdapter(namespace);
		await adapter.start();
	});

	afterAll(async () => {
		await adapter.flush();
		adapter.client.close();
	});

	test('keeps one user presence independent across guild writes, patches, and cleanup', async () => {
		const cache = new Cache(0, adapter, {}, {} as never);
		const presences = cache.presences!;
		const presence = {
			activities: [],
			client_status: {},
			status: PresenceUpdateStatus.Online as const,
			user: { id: 'shared' },
		};
		await presences.set(CacheFrom.Test, 'shared', 'guild-one', { ...presence, guild_id: 'guild-one' });
		await presences.set(CacheFrom.Test, 'shared', 'guild-two', { ...presence, guild_id: 'guild-two' });
		await presences.patch(CacheFrom.Test, 'shared', 'guild-one', {
			user: { id: 'shared' },
			guild_id: 'guild-one',
			status: PresenceUpdateStatus.Idle,
		});

		assert.equal((await presences.get('shared', 'guild-one'))?.status, 'idle');
		assert.equal((await presences.get('shared', 'guild-two'))?.status, 'online');
		assert.deepEqual(await adapter.keys('presence.guild-one'), ['presence.guild-one.shared']);
		assert.deepEqual(await adapter.keys('presence.guild-two'), ['presence.guild-two.shared']);

		await adapter.removeToRelationship('presence.guild-one', 'shared');
		assert.equal(await presences.get('shared', 'guild-one'), undefined);
		assert.equal(await presences.contains('shared', 'guild-one'), false);
		assert.equal((await presences.get('shared', 'guild-two'))?.status, 'online');

		await presences.flush('guild-two');
		assert.equal(await presences.get('shared', 'guild-two'), undefined);
		assert.equal(await presences.count('*'), 0);
		assert.deepEqual(await adapter.client.hGetAll(`${namespace}:relationships:owners`), {});
	});

	test('bulk removal settles in-flight entries and later chunks before reporting a failed entry', async () => {
		const entries = Array.from(
			{ length: 101 },
			(_, index) => [`user.${index}`, { id: String(index) }, ['user', String(index)]] as const,
		);
		await adapter.bulkSet(entries);
		// External corruption exercises a supported Redis type failure before any removal mutation.
		await adapter.client.set(`${namespace}:user.0`, 'wrong type');
		const originalEvalSha = adapter.client.evalSha.bind(adapter.client);
		const mutableClient = adapter.client as unknown as { evalSha: typeof adapter.client.evalSha };
		const { promise: started, resolve: markStarted } = Promise.withResolvers<void>();
		const { promise: failed, resolve: markFailed } = Promise.withResolvers<void>();
		const { promise: gate, resolve: release } = Promise.withResolvers<void>();
		mutableClient.evalSha = (async (...args: Parameters<typeof adapter.client.evalSha>) => {
			if (args[1]?.keys?.[0] === `${namespace}:user.99`) {
				markStarted();
				await gate;
			}
			try {
				return await originalEvalSha(...args);
			} catch (error) {
				if (args[1]?.keys?.[0] === `${namespace}:user.0`) markFailed();
				throw error;
			}
		}) as typeof adapter.client.evalSha;
		let settled = false;
		const operation = adapter
			.bulkRemove(entries.map(([key]) => key))
			.catch(error => error)
			.finally(() => {
				settled = true;
			});
		try {
			await Promise.all([started, failed]);
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.equal(settled, false);
			release();
			const error = await operation;
			expect(error).toBeInstanceOf(AggregateError);
			expect(error.errors).toHaveLength(1);
			expect(error.errors[0].message).toContain('WRONGTYPE');
			assert.equal(await adapter.client.get(`${namespace}:user.0`), 'wrong type');
			assert.deepEqual(await adapter.getToRelationship('user'), ['0']);
			assert.equal(await adapter.client.hGet(`${namespace}:relationships:owners`, 'user.0'), 'user.0');
			assert.deepEqual(await adapter.bulkGet(entries.slice(1).map(([key]) => key)), []);
		} finally {
			release();
			await operation;
			mutableClient.evalSha = originalEvalSha;
			await adapter.client.del(`${namespace}:user.0`);
		}
	});
});
