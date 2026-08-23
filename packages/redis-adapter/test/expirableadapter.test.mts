import { createClient } from '@redis/client';
import { Cache, CacheFrom, RoleFlags } from 'seyfert';
import { afterAll, assert, beforeAll, describe, expect, test, vi } from 'vitest';
import { ExpirableRedisAdapter, type ExpirableRedisAdapterOptions } from '../src';

const redisUrl = process.env.SLIPHER_REDIS_URL ?? 'redis://127.0.0.1:6379';
const adapters: ExpirableRedisAdapter[] = [];
let namespaceSequence = 0;

class InspectableExpirableRedisAdapter extends ExpirableRedisAdapter {
	get cachedEntryCount() {
		let count = 0;
		for (const bucket of this.ondemandCache.values()) {
			count += bucket.size;
		}
		return count;
	}
}

async function createAdapter(options: ExpirableRedisAdapterOptions = {}) {
	const namespace = `slipher_expirable_${process.pid}_${namespaceSequence++}`;
	const adapter = new ExpirableRedisAdapter({ redisOptions: { url: redisUrl }, namespace }, options);
	await adapter.start();
	await adapter.flush();
	adapters.push(adapter);
	return { adapter, namespace };
}

const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

describe('ExpirableRedisAdapter', () => {
	let adapter: ExpirableRedisAdapter;

	beforeAll(async () => {
		({ adapter } = await createAdapter({ default: { expire: 2_000 } }));
	});

	afterAll(async () => {
		await Promise.all(
			adapters.map(async instance => {
				await instance.flush();
				instance.client.close();
			}),
		);
	});

	test('supports the base cache adapter operations', async () => {
		assert.equal(adapter.isAsync, true);
		await adapter.set('test_key', { stale: true, value: 'oldValue' });
		await adapter.set('test_key', { value: 'testValue' });
		await adapter.bulkSet([
			['key1', { value: 'value1' }],
			['key2', { value: 'value2' }],
		]);
		await adapter.patch('test_key', { newValue: 'updatedValue' });
		await adapter.bulkPatch([
			['key1', { newValue: 'updatedValue1' }],
			['key2', { newValue: 'updatedValue2' }],
		]);

		assert.deepEqual(await adapter.get('test_key'), {
			newValue: 'updatedValue',
			value: 'testValue',
		});
		assert.deepEqual(await adapter.bulkGet(['key1', 'key2']), [
			{ newValue: 'updatedValue1', value: 'value1' },
			{ newValue: 'updatedValue2', value: 'value2' },
		]);
		assert.equal((await adapter.scan('*')).length, 3);
	});

	test('replaces object and array representations without retaining stale fields', async () => {
		const { adapter: local } = await createAdapter();

		await local.set('user.1', { stale: true, value: 'object' });
		await local.patch('user.1', [{ value: 'array' }]);
		assert.deepEqual(await local.get('user.1'), [{ value: 'array' }]);

		await local.set('user.1', { value: 'replacement' });
		assert.deepEqual(await local.get('user.1'), { value: 'replacement' });
	});

	test('inherits default on-demand and limit options into resource overrides', async () => {
		const { adapter: local, namespace } = await createAdapter({
			default: { limit: 2, ondemand: true },
			user: { expire: 1_000 },
		});

		await local.set('user.1', { value: 'one' });
		await local.set('user.2', { value: 'two' });
		await local.get('user.1');
		await local.set('user.3', { value: 'three' });
		await local.client.del([`${namespace}:user.1`, `${namespace}:user.2`, `${namespace}:user.3`]);

		assert.deepEqual(await local.get('user.1'), { value: 'one' });
		assert.equal(await local.get('user.2'), undefined);
		assert.deepEqual(await local.get('user.3'), { value: 'three' });
	});

	test('allows per-resource options to disable adapter-local caching', async () => {
		const { adapter: local, namespace } = await createAdapter({
			default: { ondemand: true },
			guild: { ondemand: false },
			user: { native: true },
		});

		await local.set('guild.1', { source: 'redis' });
		await local.set('user.1', { source: 'redis' });
		await local.client.del([`${namespace}:guild.1`, `${namespace}:user.1`]);

		assert.equal(await local.get('guild.1'), undefined);
		assert.equal(await local.get('user.1'), undefined);
	});

	test('treats a zero local limit as disabled caching', async () => {
		const { adapter: local, namespace } = await createAdapter({
			default: { ondemand: true },
			user: { limit: 0 },
		});

		await local.set('user.1', { value: 'redis-only' });
		await local.client.del(`${namespace}:user.1`);

		assert.equal(await local.get('user.1'), undefined);
	});

	test('keeps the local cache within the remaining Redis TTL', async () => {
		const { adapter: local, namespace } = await createAdapter({
			user: { expire: 80, ondemand: true },
		});

		await local.set('user.1', { value: 'short-lived' });
		const ttl = await local.client.pTTL(`${namespace}:user.1`);
		assert.isAbove(ttl, 0);
		assert.isAtMost(ttl, 80);
		assert.deepEqual(await local.get('user.1'), { value: 'short-lived' });

		await delay(140);
		assert.equal(await local.get('user.1'), undefined);
	});

	test('refreshes positive TTLs, removes zero TTLs, and preserves undefined TTLs on replacement', async () => {
		const expiring = await createAdapter({ user: { expire: 1_000, ondemand: true } });
		const expiringKey = `${expiring.namespace}:user.1`;
		await expiring.adapter.client.hSet(expiringKey, { stale: 'true' });
		await expiring.adapter.client.pExpire(expiringKey, 100);
		await expiring.adapter.set('user.1', { value: 'refreshed' });
		const refreshed = await expiring.adapter.client.pTTL(expiringKey);
		assert.isAbove(refreshed, 100);
		assert.isAtMost(refreshed, 1_000);

		const zero = await createAdapter({ user: { expire: 0, ondemand: true } });
		const zeroKey = `${zero.namespace}:user.1`;
		await zero.adapter.client.hSet(zeroKey, { stale: 'true' });
		await zero.adapter.client.pExpire(zeroKey, 1_000);
		await zero.adapter.set('user.1', { value: 'persisted' });
		assert.equal(await zero.adapter.client.pTTL(zeroKey), -1);

		const inherited = await createAdapter({ user: { ondemand: true } });
		const inheritedKey = `${inherited.namespace}:user.1`;
		await inherited.adapter.client.hSet(inheritedKey, { stale: 'true' });
		await inherited.adapter.client.pExpire(inheritedKey, 1_000);
		await inherited.adapter.set('user.1', { value: 'still-expiring' });
		const remaining = await inherited.adapter.client.pTTL(inheritedKey);
		assert.isAbove(remaining, 0);
		assert.isAtMost(remaining, 1_000);
		assert.deepEqual(await inherited.adapter.get('user.1'), { value: 'still-expiring' });
	});

	test('does not publish failed writes into the local cache', async () => {
		const { adapter: local, namespace } = await createAdapter({ user: { ondemand: true } });
		await local.set('user.1', { value: 'committed' });

		await expect(local.patch('user.1', { invalid: undefined })).rejects.toThrow();
		await local.client.del(`${namespace}:user.1`);

		assert.deepEqual(await local.get('user.1'), { value: 'committed' });
	});

	test('invalidates a value fetched while removal is in flight', async () => {
		const { adapter: local } = await createAdapter({ user: { ondemand: true } });
		await local.set('user.1', { value: 'soon-removed' });

		const originalDelete = local.client.del.bind(local.client);
		const mutableClient = local.client as unknown as { del: typeof local.client.del };
		const { promise: deleteGate, resolve: releaseDelete } = Promise.withResolvers<void>();
		mutableClient.del = (async (...keys: Parameters<typeof local.client.del>) => {
			await deleteGate;
			return originalDelete(...keys);
		}) as typeof local.client.del;

		try {
			const removing = local.remove('user.1');
			await Promise.resolve();
			assert.deepEqual(await local.get('user.1'), { value: 'soon-removed' });
			releaseDelete();
			await removing;
			assert.equal(await local.get('user.1'), undefined);
		} finally {
			mutableClient.del = originalDelete;
			releaseDelete();
		}
	});

	test('does not publish a stale in-flight read after a newer write', async () => {
		const { adapter: local, namespace } = await createAdapter({ user: { ondemand: true } });
		const key = `${namespace}:user.1`;
		await local.client.hSet(key, { value: 'stale' });

		const originalMulti = local.client.multi.bind(local.client);
		const mutableClient = local.client as unknown as { multi: typeof local.client.multi };
		const { promise: readGate, resolve: releaseRead } = Promise.withResolvers<void>();
		const { promise: readCaptured, resolve: capturedRead } = Promise.withResolvers<void>();
		let interceptNextRead = true;

		mutableClient.multi = ((...args: Parameters<typeof local.client.multi>) => {
			const transaction = originalMulti(...args);
			if (!interceptNextRead) return transaction;

			interceptNextRead = false;
			const mutableTransaction = transaction as unknown as { exec: typeof transaction.exec };
			const originalExec = transaction.exec.bind(transaction);
			mutableTransaction.exec = (async () => {
				const result = await originalExec();
				capturedRead();
				await readGate;
				return result;
			}) as typeof transaction.exec;
			return transaction;
		}) as typeof local.client.multi;

		try {
			const staleRead = local.get('user.1');
			await readCaptured;
			await local.set('user.1', { value: 'new' });
			releaseRead();

			assert.deepEqual(await staleRead, { value: 'stale' });
			await local.client.del(key);
			assert.deepEqual(await local.get('user.1'), { value: 'new' });
		} finally {
			mutableClient.multi = originalMulti;
			releaseRead();
		}
	});

	test('reclaims expired local entries when their resource bucket is used again', async () => {
		const namespace = `slipher_expirable_${process.pid}_${namespaceSequence++}`;
		const local = new InspectableExpirableRedisAdapter(
			{ redisOptions: { url: redisUrl }, namespace },
			{ user: { expire: 50, ondemand: true } },
		);
		await local.start();
		await local.flush();
		adapters.push(local);

		await local.set('user.1', { value: 'expired' });
		assert.equal(local.cachedEntryCount, 1);
		await delay(80);
		await local.set('user.2', { value: 'live' });

		assert.equal(local.cachedEntryCount, 1);
		assert.equal(await local.get('user.1'), undefined);
	});

	test('flushes adapter data without deleting unrelated strings and sets', async () => {
		const { adapter: local, namespace } = await createAdapter({
			default: { ondemand: true },
			role: { expire: 500 },
		});
		const conversationKey = `${namespace}:clippy-ask:conversation:one`;
		const unrelatedSetKey = `${namespace}:unrelated:set`;
		await local.bulkSet([
			['user.1', { value: 'one' }],
			['user.2', { value: 'two' }],
		]);
		await local.addToRelationship('role.guild', ['one', 'two']);
		await local.client.set(conversationKey, 'conversation');
		await local.client.sAdd(unrelatedSetKey, 'member');
		assert.equal(await local.contains('role.guild', 'one'), true);

		await local.bulkRemove(['user.1', 'user.2']);
		assert.deepEqual(await local.bulkGet(['user.1', 'user.2']), []);
		await local.flush();
		assert.equal(await local.contains('role.guild', 'one'), false);
		assert.equal(await local.count('role.guild'), 0);
		assert.equal(await local.client.get(conversationKey), 'conversation');
		assert.deepEqual(await local.client.sMembers(unrelatedSetKey), ['member']);

		await local.client.del([conversationKey, unrelatedSetKey]);
	});

	test('stores each relationship in one hash without SCAN or MGET reads', async () => {
		const { adapter: local, namespace } = await createAdapter({ member: { expire: 500 } });
		const relationshipKey = `${namespace}:relationships:member.guild`;
		const scanIterator = vi.spyOn(local.client, 'scanIterator');
		const mGet = vi.spyOn(local.client, 'mGet');
		await local.addToRelationship('member.guild', ['one', 'two']);

		assert.deepEqual((await local.getToRelationship('member.guild')).sort(), ['one', 'two']);
		expect(scanIterator).not.toHaveBeenCalled();
		expect(mGet).not.toHaveBeenCalled();
		assert.deepEqual((await local.client.hKeys(relationshipKey)).sort(), ['one', 'two']);
		assert.deepEqual(await local.scan('*', true), []);
		assert.equal(await local.count('member.guild'), 2);
		assert.equal(await local.contains('member.guild', 'one'), true);
		assert.equal(await local.contains('member.guild', 'missing'), false);
		for (const ttl of (await local.client.hpTTL(relationshipKey, ['one', 'two'])) ?? []) {
			assert.isAbove(ttl, 0);
			assert.isAtMost(ttl, 500);
		}

		await local.removeToRelationship('member.guild', 'one');
		assert.equal(await local.contains('member.guild', 'one'), false);
		assert.deepEqual(await local.getToRelationship('member.guild'), ['two']);
		await local.removeRelationship('member.guild');
		assert.equal(await local.client.exists(relationshipKey), 0);
		assert.equal(await local.count('member.guild'), 0);
	});

	test('removes a relationship atomically with a concurrent addition', async () => {
		const { adapter: local } = await createAdapter();
		await local.addToRelationship('role.guild', 'old');

		const originalDelete = local.client.del.bind(local.client);
		const mutableClient = local.client as unknown as { del: typeof local.client.del };
		const { promise: deleteGate, resolve: releaseDelete } = Promise.withResolvers<void>();
		const { promise: started, resolve: deleteStarted } = Promise.withResolvers<void>();
		mutableClient.del = (async (...keys: Parameters<typeof local.client.del>) => {
			deleteStarted();
			await deleteGate;
			return originalDelete(...keys);
		}) as typeof local.client.del;

		try {
			const removing = local.removeRelationship('role.guild');
			await started;
			await local.addToRelationship('role.guild', 'new');
			releaseDelete();
			await removing;

			assert.deepEqual(await local.getToRelationship('role.guild'), []);
			assert.equal(await local.contains('role.guild', 'new'), false);
		} finally {
			mutableClient.del = originalDelete;
			releaseDelete();
		}
	});

	test('removes wildcard relationships through bounded internal scans', async () => {
		const { adapter: local } = await createAdapter();
		await local.addToRelationship('role.guild-one', 'one');
		await local.addToRelationship('role.guild-two', 'two');
		await local.addToRelationship('member.guild-one', 'one');

		await local.removeRelationship('role.*');

		assert.deepEqual(await local.getToRelationship('role.guild-one'), []);
		assert.deepEqual(await local.getToRelationship('role.guild-two'), []);
		assert.deepEqual(await local.getToRelationship('member.guild-one'), ['one']);
	});

	test('expires relationship fields independently without retaining historical members', async () => {
		const { adapter: local } = await createAdapter({ member: { expire: 150 } });
		await local.addToRelationship('member.guild', 'old');
		await delay(100);
		await local.addToRelationship('member.guild', 'live');
		await delay(100);

		assert.deepEqual(await local.getToRelationship('member.guild'), ['live']);
		assert.equal(await local.count('member.guild'), 1);
		assert.equal(await local.contains('member.guild', 'old'), false);
		assert.equal(await local.contains('member.guild', 'live'), true);
	});

	test('refreshes, preserves, and removes relationship field TTLs according to resource policy', async () => {
		const expiring = await createAdapter({ member: { expire: 500 } });
		const expiringKey = `${expiring.namespace}:relationships:member.guild`;
		await expiring.adapter.addToRelationship('member.guild', 'one');
		await delay(30);
		const [beforeRefresh] = (await expiring.adapter.client.hpTTL(expiringKey, 'one')) ?? [];
		await expiring.adapter.addToRelationship('member.guild', 'one');
		const [afterRefresh] = (await expiring.adapter.client.hpTTL(expiringKey, 'one')) ?? [];
		assert.isAbove(afterRefresh ?? -2, beforeRefresh ?? -2);

		const preserving = await createAdapter({ member: { expire: undefined } });
		const preservingKey = `${preserving.namespace}:relationships:member.guild`;
		await preserving.adapter.client.hSetEx(preservingKey, { one: '1' }, { expiration: { type: 'PX', value: 500 } });
		await delay(30);
		const [beforePreserve] = (await preserving.adapter.client.hpTTL(preservingKey, 'one')) ?? [];
		await preserving.adapter.addToRelationship('member.guild', ['one', 'persistent']);
		const preservedTtls = (await preserving.adapter.client.hpTTL(preservingKey, ['one', 'persistent'])) ?? [];
		assert.isAtMost(preservedTtls[0] ?? 501, beforePreserve ?? 500);
		assert.equal(preservedTtls[1], -1);

		const persistent = await createAdapter({ member: { expire: 0 } });
		const persistentKey = `${persistent.namespace}:relationships:member.guild`;
		await persistent.adapter.client.hSetEx(persistentKey, { one: '1' }, { expiration: { type: 'PX', value: 500 } });
		await persistent.adapter.addToRelationship('member.guild', 'one');
		assert.deepEqual(await persistent.adapter.client.hpTTL(persistentKey, 'one'), [-1]);
	});

	test('migrates legacy relationships during startup only when enabled', async () => {
		const namespace = `slipher_expirable_${process.pid}_${namespaceSequence++}`;
		const seed = createClient({ url: redisUrl });
		await seed.connect();
		await seed.set(`${namespace}:member.guild.uset.one`, 's', { PX: 30_000 });
		await seed.set(`${namespace}:member.guild.uset.two`, 's');
		await seed.sAdd(`${namespace}:member.guild:set`, ['one', 'two', 'expired']);
		await seed.set(`${namespace}:member.guild:set:indexed`, '1');
		await seed.set(`${namespace}:role.guild.uset.three`, 's');
		seed.close();

		const skipped = new ExpirableRedisAdapter({ redisOptions: { url: redisUrl }, namespace });
		const skippedScanIterator = vi.spyOn(skipped.client, 'scanIterator');
		await skipped.start();
		expect(skippedScanIterator).not.toHaveBeenCalled();
		assert.equal(await skipped.client.exists(`${namespace}:member.guild.uset.one`), 1);
		skipped.client.close();

		const local = new ExpirableRedisAdapter(
			{ redisOptions: { url: redisUrl }, namespace },
			{ migrateLegacyRelationships: true },
		);
		const scanIterator = vi.spyOn(local.client, 'scanIterator');
		await local.start();
		adapters.push(local);

		assert.deepEqual((await local.getToRelationship('member.guild')).sort(), ['one', 'two']);
		assert.deepEqual(await local.getToRelationship('role.guild'), ['three']);
		const migratedTtls = (await local.client.hpTTL(`${namespace}:relationships:member.guild`, ['one', 'two'])) ?? [];
		assert.isAbove(migratedTtls[0] ?? -2, 0);
		assert.equal(migratedTtls[1], -1);
		assert.equal(await local.client.exists(`${namespace}:member.guild.uset.one`), 0);
		assert.equal(await local.client.exists(`${namespace}:member.guild:set`), 0);
		assert.equal(await local.client.exists(`${namespace}:member.guild:set:indexed`), 0);

		scanIterator.mockClear();
		await local.getToRelationship('member.guild');
		await local.count('member.guild');
		await local.contains('member.guild', 'one');
		expect(scanIterator).not.toHaveBeenCalled();
	});

	test('bounds concurrent relationship writes', async () => {
		const { adapter: local } = await createAdapter();
		const originalHSetEx = local.client.hSetEx.bind(local.client);
		let activeWrites = 0;
		let maxActiveWrites = 0;
		const hSetEx = vi
			.spyOn(local.client, 'hSetEx')
			.mockImplementation(async (...args: Parameters<typeof local.client.hSetEx>) => {
				activeWrites++;
				maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
				await delay(1);
				try {
					return await originalHSetEx(...args);
				} finally {
					activeWrites--;
				}
			});
		const relationships = Object.fromEntries(
			Array.from({ length: 250 }, (_, index) => [`role.guild-${index}`, [`role-${index}`]]),
		);

		await local.bulkAddToRelationShip(relationships);

		assert.isAtMost(maxActiveWrites, 100);
		assert.isAbove(maxActiveWrites, 1);
		expect(hSetEx).toHaveBeenCalledTimes(250);
	});

	test('serves Seyfert role lists without scanning the Redis keyspace', async () => {
		const { adapter: local } = await createAdapter();
		const cache = new Cache(0, local, {}, {} as never);
		await cache.roles?.set(CacheFrom.Test, 'one', 'guild', {
			color: 0,
			colors: {
				primary_color: 0,
				secondary_color: null,
				tertiary_color: null,
			},
			flags: RoleFlags.InPrompt,
			hoist: false,
			id: 'one',
			managed: false,
			mentionable: false,
			name: 'Role One',
			permissions: '0',
			position: 1,
		});
		const scanIterator = vi.spyOn(local.client, 'scanIterator');
		const roles = await cache.roles?.valuesRaw('guild');

		assert.equal(roles?.length, 1);
		assert.equal(roles?.[0]?.id, 'one');
		assert.equal((roles?.[0] as { guild_id: string } | undefined)?.guild_id, 'guild');
		expect(scanIterator).not.toHaveBeenCalled();
	});

	test('rejects ambiguous TTL and limit values at construction', () => {
		assert.throws(() => new ExpirableRedisAdapter(undefined, { user: { expire: 1.5 } }), /expire/);
		assert.throws(() => new ExpirableRedisAdapter(undefined, { user: { limit: -1 } }), /limit/);
		assert.doesNotThrow(() => new ExpirableRedisAdapter(undefined, { user: { limit: Number.POSITIVE_INFINITY } }));
	});
});
