import { createClient } from '@redis/client';
import { Cache, CacheFrom, RoleFlags } from 'seyfert';
import { afterAll, assert, describe, expect, test } from 'vitest';
import { ExpirableRedisAdapter, type ExpirableRedisAdapterOptions } from '../src';

const redisUrl = process.env.SLIPHER_REDIS_URL ?? 'redis://127.0.0.1:6379';
const adapters: ExpirableRedisAdapter[] = [];
let namespaceSequence = 0;

class InspectableExpirableRedisAdapter extends ExpirableRedisAdapter {
	get cachedEntryCount() {
		let count = 0;
		for (const bucket of this.ondemandCache.values()) count += bucket.size;
		return count;
	}
}

async function createAdapter(options: ExpirableRedisAdapterOptions = {}) {
	const namespace = `slipher_expirable_${process.pid}_${namespaceSequence++}`;
	const adapter = new InspectableExpirableRedisAdapter({ redisOptions: { url: redisUrl }, namespace }, options);
	await adapter.start();
	await adapter.flush();
	adapters.push(adapter);
	return { adapter, namespace };
}

function userEntry(id: string, value: Record<string, unknown> = { id }) {
	return [`user.${id}`, value, ['user', id]] as const;
}

function channelEntry(guildId: string, name = guildId) {
	return [
		'channel.channel-1',
		{ id: 'channel-1', guild_id: guildId, name },
		[`channel.${guildId}`, 'channel-1'],
	] as const;
}

const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

describe('ExpirableRedisAdapter', () => {
	afterAll(async () => {
		await Promise.all(
			adapters.map(async adapter => {
				await adapter.flush();
				adapter.client.close();
			}),
		);
	});

	test('implements atomic writes while opting out of the cooldown-specific bridge', async () => {
		const { adapter } = await createAdapter({ default: { expire: 2_000 } });
		assert.equal(adapter.isAsync, true);
		assert.equal(adapter.supportsAtomicCooldowns, false);

		await adapter.set(...userEntry('primary', { id: 'primary', stale: true, value: 'old' }));
		await adapter.set(...userEntry('primary', { id: 'primary', value: 'current' }));
		await adapter.bulkSet([userEntry('one'), userEntry('two')]);
		await adapter.patch(...userEntry('primary', { patched: true }));
		await adapter.bulkPatch([userEntry('one', { patched: 1 }), userEntry('two', { patched: 2 })]);

		assert.deepEqual(await adapter.get('user.primary'), { id: 'primary', patched: true, value: 'current' });
		assert.deepEqual(await adapter.bulkGet(['user.one', 'user.two']), [
			{ id: 'one', patched: 1 },
			{ id: 'two', patched: 2 },
		]);
		assert.equal(await adapter.count('user'), 3);
	});

	test('gives value, ownership, and relationship fields one expiration authority', async () => {
		const { adapter, namespace } = await createAdapter({ channel: { expire: 800 } });
		await adapter.set(...channelEntry('guild-one'));

		const valueExpiry = await adapter.client.pExpireTime(`${namespace}:channel.channel-1`);
		const [relationshipTtl] =
			(await adapter.client.hpTTL(`${namespace}:relationships:channel.guild-one`, 'channel-1')) ?? [];
		const [ownerTtl] = (await adapter.client.hpTTL(`${namespace}:relationships:owners`, 'channel.channel-1')) ?? [];

		assert.isAbove(valueExpiry, Date.now());
		assert.isAbove(relationshipTtl ?? -2, 0);
		assert.isAbove(ownerTtl ?? -2, 0);
		assert.closeTo(relationshipTtl ?? 0, ownerTtl ?? 0, 10);
		assert.closeTo(relationshipTtl ?? 0, valueExpiry - Date.now(), 30);
	});

	test('expires an entry without retaining either direction of the relationship', async () => {
		const { adapter, namespace } = await createAdapter({ user: { expire: 70 } });
		await adapter.set(...userEntry('short'));
		await delay(120);

		assert.equal(await adapter.get('user.short'), undefined);
		assert.equal(await adapter.contains('user', 'short'), false);
		assert.deepEqual(await adapter.getToRelationship('user'), []);
		assert.equal(await adapter.client.hExists(`${namespace}:relationships:owners`, 'user.short'), 0);
	});

	test('does not refresh TTL on successful or failed reads', async () => {
		const { adapter, namespace } = await createAdapter({ user: { expire: 500 } });
		await adapter.set(...userEntry('read'));
		await delay(30);
		const beforeRead = await adapter.client.pTTL(`${namespace}:user.read`);
		assert.deepEqual(await adapter.get('user.read'), { id: 'read' });
		await delay(30);
		const afterRead = await adapter.client.pTTL(`${namespace}:user.read`);
		assert.isBelow(afterRead, beforeRead);

		await adapter.client.hSet(`${namespace}:user.read`, { O_corrupt: '{' });
		const beforeFailure = await adapter.client.pTTL(`${namespace}:user.read`);
		await expect(adapter.get('user.read')).rejects.toThrow();
		const afterFailure = await adapter.client.pTTL(`${namespace}:user.read`);
		assert.isAtMost(afterFailure, beforeFailure);
	});

	test('failed patch decode and encode leave value, owner, and expiration unchanged', async () => {
		const decode = await createAdapter({ channel: { expire: 600 } });
		await decode.adapter.set(...channelEntry('guild-old', 'old'));
		await decode.adapter.client.hSet(`${decode.namespace}:channel.channel-1`, { O_corrupt: '{' });
		const decodeTtl = await decode.adapter.client.pTTL(`${decode.namespace}:channel.channel-1`);

		await expect(decode.adapter.patch(...channelEntry('guild-new', 'new'))).rejects.toThrow();
		assert.equal(await decode.adapter.contains('channel.guild-old', 'channel-1'), true);
		assert.equal(await decode.adapter.contains('channel.guild-new', 'channel-1'), false);
		assert.isAtMost(await decode.adapter.client.pTTL(`${decode.namespace}:channel.channel-1`), decodeTtl);

		const encode = await createAdapter({ channel: { expire: 600 } });
		await encode.adapter.set(...channelEntry('guild-old', 'old'));
		const encodeTtl = await encode.adapter.client.pTTL(`${encode.namespace}:channel.channel-1`);
		await expect(
			encode.adapter.patch('channel.channel-1', { invalid: undefined }, ['channel.guild-new', 'channel-1']),
		).rejects.toThrow('cannot encode');
		assert.equal(await encode.adapter.contains('channel.guild-old', 'channel-1'), true);
		assert.equal(await encode.adapter.contains('channel.guild-new', 'channel-1'), false);
		assert.isAtMost(await encode.adapter.client.pTTL(`${encode.namespace}:channel.channel-1`), encodeTtl);
	});

	test('preserves, refreshes, or removes TTL according to the write policy', async () => {
		const expiring = await createAdapter({ user: { expire: 800 } });
		await expiring.adapter.set(...userEntry('one'));
		await expiring.adapter.client.pExpire(`${expiring.namespace}:user.one`, 100);
		await expiring.adapter.set(...userEntry('one', { id: 'one', refreshed: true }));
		assert.isAbove(await expiring.adapter.client.pTTL(`${expiring.namespace}:user.one`), 600);

		const persistent = await createAdapter({ user: { expire: 0 } });
		await persistent.adapter.set(...userEntry('one'));
		await persistent.adapter.client.pExpire(`${persistent.namespace}:user.one`, 500);
		await persistent.adapter.set(...userEntry('one', { id: 'one', persisted: true }));
		assert.equal(await persistent.adapter.client.pTTL(`${persistent.namespace}:user.one`), -1);

		const preserving = await createAdapter({ user: { expire: undefined } });
		await preserving.adapter.set(...userEntry('one'));
		await preserving.adapter.client.pExpire(`${preserving.namespace}:user.one`, 500);
		await delay(20);
		const before = await preserving.adapter.client.pExpireTime(`${preserving.namespace}:user.one`);
		await preserving.adapter.set(...userEntry('one', { id: 'one', preserved: true }));
		assert.closeTo(await preserving.adapter.client.pExpireTime(`${preserving.namespace}:user.one`), before, 5);
	});

	test('moves globally keyed resources and their TTL atomically', async () => {
		const { adapter, namespace } = await createAdapter({ channel: { expire: 800 } });
		await adapter.set(...channelEntry('guild-one'));
		await delay(20);
		await adapter.patch(...channelEntry('guild-two', 'moved'));

		assert.equal(await adapter.contains('channel.guild-one', 'channel-1'), false);
		assert.equal(await adapter.contains('channel.guild-two', 'channel-1'), true);
		assert.deepEqual(await adapter.keys('channel.guild-two'), ['channel.channel-1']);
		const [ttl] = (await adapter.client.hpTTL(`${namespace}:relationships:channel.guild-two`, 'channel-1')) ?? [];
		assert.isAbove(ttl ?? -2, 0);
	});

	test('tracks messages by relationship scope rather than storage scope', async () => {
		const { adapter } = await createAdapter({ message: { expire: 800 } });
		await adapter.set('message.message-1', { id: 'message-1', guild_id: 'guild-1', channel_id: 'channel-1' }, [
			'message.channel-1',
			'message-1',
		]);
		await adapter.patch('message.message-1', { channel_id: 'channel-2' }, ['message.channel-2', 'message-1']);

		assert.equal(await adapter.contains('message.channel-1', 'message-1'), false);
		assert.equal(await adapter.contains('message.channel-2', 'message-1'), true);
		assert.deepEqual(await adapter.keys('message.channel-2'), ['message.message-1']);
		assert.equal((await adapter.get('message.message-1')).guild_id, 'guild-1');
	});

	test('bulk writes pre-encode every entry before publishing Redis or local state', async () => {
		const { adapter } = await createAdapter({ user: { expire: 800 } });
		await expect(
			adapter.bulkSet([userEntry('one'), userEntry('two', { id: 'two', invalid: undefined }), userEntry('three')]),
		).rejects.toThrow('cannot encode');

		assert.equal(await adapter.get('user.one'), undefined);
		assert.equal(await adapter.get('user.two'), undefined);
		assert.equal(await adapter.get('user.three'), undefined);
		assert.deepEqual(await adapter.getToRelationship('user'), []);
	});

	test('bulk patches pre-encode every entry before publishing Redis or local state', async () => {
		const { adapter } = await createAdapter({ user: { ondemand: true } });
		await adapter.bulkSet([userEntry('one'), userEntry('two'), userEntry('three')]);

		await expect(
			adapter.bulkPatch([
				userEntry('one', { patched: true }),
				userEntry('two', { invalid: undefined }),
				userEntry('three', { patched: true }),
			]),
		).rejects.toThrow('cannot encode');

		assert.deepEqual(await adapter.get('user.one'), { id: 'one' });
		assert.deepEqual(await adapter.get('user.two'), { id: 'two' });
		assert.deepEqual(await adapter.get('user.three'), { id: 'three' });
		assert.equal(adapter.cachedEntryCount, 3);
	});

	test('bulk removal clears Redis ownership and on-demand state for every submitted entry', async () => {
		const { adapter } = await createAdapter({ user: { ondemand: true } });
		await adapter.bulkSet([userEntry('one'), userEntry('two'), userEntry('three')]);
		assert.equal(adapter.cachedEntryCount, 3);

		await adapter.bulkRemove(['user.one', 'user.two', 'user.three']);

		assert.deepEqual(await adapter.bulkGet(['user.one', 'user.two', 'user.three']), []);
		assert.deepEqual(await adapter.getToRelationship('user'), []);
		assert.equal(adapter.cachedEntryCount, 0);
	});

	test('invalidates local entries removed through relationship operations', async () => {
		const { adapter } = await createAdapter({ user: { ondemand: true } });
		await adapter.set(...userEntry('one'));
		await adapter.set(...userEntry('two'));
		assert.deepEqual(await adapter.get('user.one'), { id: 'one' });
		assert.deepEqual(await adapter.get('user.two'), { id: 'two' });
		assert.equal(adapter.cachedEntryCount, 2);

		await adapter.removeToRelationship('user', 'one');
		assert.equal(await adapter.get('user.one'), undefined);
		assert.deepEqual(await adapter.get('user.two'), { id: 'two' });

		await adapter.removeRelationship('user');
		assert.equal(await adapter.get('user.two'), undefined);
		assert.equal(adapter.cachedEntryCount, 0);
	});

	test('treats a missing relationship member as a no-op', async () => {
		const { adapter } = await createAdapter({ user: { ondemand: true } });
		await expect(adapter.removeToRelationship('user', 'missing')).resolves.toBeUndefined();
		assert.equal(adapter.cachedEntryCount, 0);
	});

	test('invalidates a concurrent on-demand write removed through its relationship', async () => {
		const { adapter } = await createAdapter({ user: { ondemand: true } });
		const originalEvalSha = adapter.client.evalSha.bind(adapter.client);
		const mutableClient = adapter.client as unknown as { evalSha: typeof adapter.client.evalSha };
		const { promise: removalCaptured, resolve: captured } = Promise.withResolvers<void>();
		const { promise: removalGate, resolve: releaseRemoval } = Promise.withResolvers<void>();
		let interceptRemoval = true;
		mutableClient.evalSha = (async (...args: Parameters<typeof adapter.client.evalSha>) => {
			if (interceptRemoval) {
				interceptRemoval = false;
				captured();
				await removalGate;
			}
			return originalEvalSha(...args);
		}) as typeof adapter.client.evalSha;

		try {
			const removing = adapter.removeToRelationship('user', 'one');
			await removalCaptured;
			await adapter.set(...userEntry('one', { id: 'one', value: 'written-during-remove' }));
			assert.deepEqual(await adapter.get('user.one'), { id: 'one', value: 'written-during-remove' });
			releaseRemoval();
			await removing;

			assert.equal(await adapter.client.exists(`${adapter.namespace}:user.one`), 0);
			assert.deepEqual(await adapter.getToRelationship('user'), []);
			assert.equal(await adapter.get('user.one'), undefined);
		} finally {
			mutableClient.evalSha = originalEvalSha;
			releaseRemoval();
		}
	});

	test('preflights Redis failures without publishing local or relationship state', async () => {
		const { adapter, namespace } = await createAdapter({ channel: { expire: 800, ondemand: true } });
		await adapter.set(...channelEntry('guild-safe', 'safe'));
		const invalidRelationship = `${namespace}:relationships:channel.guild-invalid`;
		await adapter.client.set(invalidRelationship, 'wrong type');

		await expect(adapter.set(...channelEntry('guild-invalid', 'unsafe'))).rejects.toThrow('WRONGTYPE');
		assert.equal(await adapter.contains('channel.guild-safe', 'channel-1'), true);
		assert.equal((await adapter.get('channel.channel-1')).name, 'safe');
		await adapter.client.del(invalidRelationship);
	});

	test('rejects hash-field deadlines Redis cannot represent before mutating state', async () => {
		const { adapter, namespace } = await createAdapter({ user: { expire: 5_000 } });
		await adapter.set(...userEntry('deadline', { id: 'deadline', value: 'old' }));
		const valueDeadline = await adapter.client.pExpireTime(`${namespace}:user.deadline`);
		adapter.options.user!.expire = Number.MAX_SAFE_INTEGER;

		await expect(
			adapter.set('user.deadline', { id: 'deadline', value: 'new' }, ['user.other', 'deadline']),
		).rejects.toThrow('cache expiry exceeds Redis hash-field deadline limit');

		assert.deepEqual(await adapter.get('user.deadline'), { id: 'deadline', value: 'old' });
		assert.equal(await adapter.contains('user', 'deadline'), true);
		assert.equal(await adapter.contains('user.other', 'deadline'), false);
		assert.equal(await adapter.client.pExpireTime(`${namespace}:user.deadline`), valueDeadline);
	});

	test('does not publish a stale in-flight read after a newer write', async () => {
		const { adapter, namespace } = await createAdapter({ user: { ondemand: true } });
		const key = `${namespace}:user.one`;
		await adapter.client.hSet(key, { id: 'one', value: 'stale' });

		const originalMulti = adapter.client.multi.bind(adapter.client);
		const mutableClient = adapter.client as unknown as { multi: typeof adapter.client.multi };
		const { promise: readGate, resolve: releaseRead } = Promise.withResolvers<void>();
		const { promise: readCaptured, resolve: capturedRead } = Promise.withResolvers<void>();
		let interceptNextRead = true;
		mutableClient.multi = ((...args: Parameters<typeof adapter.client.multi>) => {
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
		}) as typeof adapter.client.multi;

		try {
			const staleRead = adapter.get('user.one');
			await readCaptured;
			await adapter.set(...userEntry('one', { id: 'one', value: 'new' }));
			releaseRead();
			assert.deepEqual(await staleRead, { id: 'one', value: 'stale' });
			await adapter.client.del(key);
			assert.deepEqual(await adapter.get('user.one'), { id: 'one', value: 'new' });
		} finally {
			mutableClient.multi = originalMulti;
			releaseRead();
		}
	});

	test('invalidates a value fetched while atomic removal is in flight', async () => {
		const { adapter } = await createAdapter({ user: { ondemand: true } });
		await adapter.set(...userEntry('one', { id: 'one', value: 'soon-removed' }));

		const originalEvalSha = adapter.client.evalSha.bind(adapter.client);
		const mutableClient = adapter.client as unknown as { evalSha: typeof adapter.client.evalSha };
		const { promise: gate, resolve: release } = Promise.withResolvers<void>();
		let intercept = true;
		mutableClient.evalSha = (async (...args: Parameters<typeof adapter.client.evalSha>) => {
			if (intercept) {
				intercept = false;
				await gate;
			}
			return originalEvalSha(...args);
		}) as typeof adapter.client.evalSha;

		try {
			const removing = adapter.remove('user.one');
			await Promise.resolve();
			assert.deepEqual(await adapter.get('user.one'), { id: 'one', value: 'soon-removed' });
			release();
			await removing;
			assert.equal(await adapter.get('user.one'), undefined);
		} finally {
			mutableClient.evalSha = originalEvalSha;
			release();
		}
	});

	test('migrates old strings, sets, and marker hashes into ownership indexes offline', async () => {
		const namespace = `slipher_migration_${process.pid}_${namespaceSequence++}`;
		const seed = createClient({ url: redisUrl });
		await seed.connect();
		await seed.hSet(`${namespace}:member.guild.user`, { id: 'user', guild_id: 'guild' });
		await seed.pExpire(`${namespace}:member.guild.user`, 5_000);
		await seed.set(`${namespace}:member.guild.uset.user`, 's', { PX: 5_000 });
		await seed.sAdd(`${namespace}:member.guild:set`, 'user');
		await seed.hSet(`${namespace}:relationships:member.guild`, { user: '1' });
		seed.close();

		const adapter = new ExpirableRedisAdapter(
			{ redisOptions: { url: redisUrl }, namespace },
			{ migrateLegacyRelationships: true },
		);
		await adapter.start();
		adapters.push(adapter);

		assert.deepEqual(await adapter.getToRelationship('member.guild'), ['user']);
		assert.deepEqual(await adapter.keys('member.guild'), ['member.guild.user']);
		assert.equal(
			await adapter.client.hGet(`${namespace}:relationships:owners`, 'member.guild.user'),
			'member.guild.user',
		);
		assert.equal(await adapter.client.exists(`${namespace}:member.guild.uset.user`), 0);
		assert.equal(await adapter.client.exists(`${namespace}:member.guild:set`), 0);
		const [relationshipTtl] = (await adapter.client.hpTTL(`${namespace}:relationships:member.guild`, 'user')) ?? [];
		assert.isAbove(relationshipTtl ?? -2, 0);
	});

	test('rejects conflicting legacy ownership before deleting migration inputs', async () => {
		const namespace = `slipher_migration_conflict_${process.pid}_${namespaceSequence++}`;
		const seed = createClient({ url: redisUrl });
		await seed.connect();
		await seed.hSet(`${namespace}:channel.channel`, { id: 'channel' });
		await seed.sAdd(`${namespace}:channel.guild-one:set`, 'channel');
		await seed.sAdd(`${namespace}:channel.guild-two:set`, 'channel');
		seed.close();

		const adapter = new ExpirableRedisAdapter(
			{ redisOptions: { url: redisUrl }, namespace },
			{ migrateLegacyRelationships: true },
		);
		await expect(adapter.start()).rejects.toThrow('Ambiguous legacy ownership');
		adapters.push(adapter);

		assert.equal(await adapter.client.exists(`${namespace}:channel.guild-one:set`), 1);
		assert.equal(await adapter.client.exists(`${namespace}:channel.guild-two:set`), 1);
		assert.equal(await adapter.client.hLen(`${namespace}:relationships:owners`), 0);
		await adapter.client.del([
			`${namespace}:channel.channel`,
			`${namespace}:channel.guild-one:set`,
			`${namespace}:channel.guild-two:set`,
		]);
	});

	test('keeps Redis and on-demand representations equal across patch type changes', async () => {
		const { adapter } = await createAdapter({ user: { ondemand: true } });
		await adapter.set(...userEntry('typed', { id: 'typed', value: 'string' }));
		for (const value of [{ nested: true }, 42, false, 'final']) {
			await adapter.patch(...userEntry('typed', { value }));
			assert.deepEqual(await adapter.get('user.typed'), { id: 'typed', value });
		}
	});

	test('removes stale legacy hash markers whose values no longer exist', async () => {
		const namespace = `slipher_migration_stale_${process.pid}_${namespaceSequence++}`;
		const seed = createClient({ url: redisUrl });
		await seed.connect();
		await seed.hSet(`${namespace}:relationships:user`, { ghost: '1' });
		seed.close();

		const adapter = new ExpirableRedisAdapter(
			{ redisOptions: { url: redisUrl }, namespace },
			{ migrateLegacyRelationships: true },
		);
		await adapter.start();
		adapters.push(adapter);

		assert.equal(await adapter.contains('user', 'ghost'), false);
		assert.deepEqual(await adapter.getToRelationship('user'), []);
		assert.deepEqual(await adapter.keys('user'), []);
		assert.equal(await adapter.client.hExists(`${namespace}:relationships:owners`, 'user.ghost'), 0);
	});

	test('rejects a legacy marker that conflicts with an existing reverse owner', async () => {
		const namespace = `slipher_migration_owner_conflict_${process.pid}_${namespaceSequence++}`;
		const seed = createClient({ url: redisUrl });
		await seed.connect();
		await seed.hSet(`${namespace}:user.one`, { id: 'one' });
		await seed.hSet(`${namespace}:relationships:user`, { one: '1' });
		await seed.hSet(`${namespace}:relationships:owners`, { 'user.one': 'user.two' });
		seed.close();

		const adapter = new ExpirableRedisAdapter(
			{ redisOptions: { url: redisUrl }, namespace },
			{ migrateLegacyRelationships: true },
		);
		await expect(adapter.start()).rejects.toThrow('conflicting cache relationship owner');
		adapters.push(adapter);

		assert.equal(await adapter.client.hGet(`${namespace}:relationships:user`, 'one'), '1');
		assert.equal(await adapter.client.hGet(`${namespace}:relationships:owners`, 'user.one'), 'user.two');
	});

	test('flush removes adapter hashes but preserves unrelated strings and sets', async () => {
		const { adapter, namespace } = await createAdapter();
		const stringKey = `${namespace}:application:string`;
		const setKey = `${namespace}:application:set`;
		await adapter.set(...userEntry('one'));
		await adapter.client.set(stringKey, 'value');
		await adapter.client.sAdd(setKey, 'member');

		await adapter.flush();
		assert.equal(await adapter.get('user.one'), undefined);
		assert.equal(await adapter.client.get(stringKey), 'value');
		assert.deepEqual(await adapter.client.sMembers(setKey), ['member']);
		await adapter.client.del([stringKey, setKey]);
	});

	test('serves Seyfert guild-related resources through the new contract', async () => {
		const { adapter } = await createAdapter();
		const cache = new Cache(0, adapter, {}, {} as never);
		await cache.roles?.set(CacheFrom.Test, 'one', 'guild', {
			color: 0,
			colors: { primary_color: 0, secondary_color: null, tertiary_color: null },
			flags: RoleFlags.InPrompt,
			hoist: false,
			id: 'one',
			managed: false,
			mentionable: false,
			name: 'Role One',
			permissions: '0',
			position: 1,
		});

		const roles = await cache.roles?.valuesRaw('guild');
		assert.equal(roles?.length, 1);
		assert.equal(roles?.[0]?.id, 'one');
		assert.equal((roles?.[0] as { guild_id: string } | undefined)?.guild_id, 'guild');
	});

	test('reclaims expired local entries when their resource bucket is used again', async () => {
		const { adapter } = await createAdapter({ user: { expire: 50, ondemand: true } });
		await adapter.set(...userEntry('expired'));
		assert.equal(adapter.cachedEntryCount, 1);
		await delay(80);
		await adapter.set(...userEntry('live'));
		assert.equal(adapter.cachedEntryCount, 1);
	});

	test('rejects ambiguous TTL and limit values at construction', () => {
		assert.throws(() => new ExpirableRedisAdapter(undefined, { user: { expire: 1.5 } }), /expire/);
		assert.throws(() => new ExpirableRedisAdapter(undefined, { user: { limit: -1 } }), /limit/);
		assert.doesNotThrow(() => new ExpirableRedisAdapter(undefined, { user: { limit: Number.POSITIVE_INFINITY } }));
	});
});
