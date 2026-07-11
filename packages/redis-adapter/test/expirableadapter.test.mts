import { afterAll, assert, beforeAll, describe, expect, test } from 'vitest';
import { ExpirableRedisAdapter, type ExpirableRedisAdapterOptions } from '../src';

const redisUrl = process.env.SLIPHER_REDIS_URL ?? 'redis://127.0.0.1:6379';
const adapters: ExpirableRedisAdapter[] = [];
let namespaceSequence = 0;

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

	test('uses zero to remove a TTL and undefined to preserve one', async () => {
		const zero = await createAdapter({ user: { expire: 0, ondemand: true } });
		const zeroKey = `${zero.namespace}:user.1`;
		await zero.adapter.client.hSet(zeroKey, { value: 'before' });
		await zero.adapter.client.pExpire(zeroKey, 1_000);
		await zero.adapter.patch('user.1', { value: 'persisted' });
		assert.equal(await zero.adapter.client.pTTL(zeroKey), -1);

		const inherited = await createAdapter({ user: { ondemand: true } });
		const inheritedKey = `${inherited.namespace}:user.1`;
		await inherited.adapter.client.hSet(inheritedKey, { value: 'before' });
		await inherited.adapter.client.pExpire(inheritedKey, 1_000);
		await inherited.adapter.patch('user.1', { value: 'still-expiring' });
		const remaining = await inherited.adapter.client.pTTL(inheritedKey);
		assert.isAbove(remaining, 0);
		assert.isAtMost(remaining, 1_000);
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
		let releaseDelete: () => void = () => {};
		const deleteGate = new Promise<void>(resolve => {
			releaseDelete = resolve;
		});
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

	test('keeps bulk removal and flush consistent across hashes, local cache, and relationships', async () => {
		const { adapter: local } = await createAdapter({
			default: { ondemand: true },
			role: { expire: 500 },
		});
		await local.bulkSet([
			['user.1', { value: 'one' }],
			['user.2', { value: 'two' }],
		]);
		await local.addToRelationship('role.guild', ['one', 'two']);
		assert.equal(await local.contains('role.guild', 'one'), true);

		await local.bulkRemove(['user.1', 'user.2']);
		assert.deepEqual(await local.bulkGet(['user.1', 'user.2']), []);
		await local.flush();
		assert.equal(await local.contains('role.guild', 'one'), false);
		assert.equal(await local.count('role.guild'), 0);
	});

	test('stores each relationship key separately with its resource TTL', async () => {
		const { adapter: local, namespace } = await createAdapter({ member: { expire: 500 } });
		await local.addToRelationship('member.guild', ['one', 'two']);

		assert.deepEqual((await local.getToRelationship('member.guild')).sort(), ['one', 'two']);
		assert.equal(await local.count('member.guild'), 2);
		assert.equal(await local.contains('member.guild', 'one'), true);
		assert.equal(await local.contains('member.guild', 'missing'), false);
		for (const id of ['one', 'two']) {
			const ttl = await local.client.pTTL(`${namespace}:member.guild.uset.${id}`);
			assert.isAbove(ttl, 0);
			assert.isAtMost(ttl, 500);
		}

		await local.removeToRelationship('member.guild', 'one');
		assert.equal(await local.contains('member.guild', 'one'), false);
		assert.equal(await local.count('member.guild'), 1);
		await local.removeRelationship('member.guild');
		assert.equal(await local.contains('member.guild', 'two'), false);
		assert.equal(await local.count('member.guild'), 0);
	});

	test('rejects ambiguous TTL and limit values at construction', () => {
		assert.throws(() => new ExpirableRedisAdapter(undefined, { user: { expire: 1.5 } }), /expire/);
		assert.throws(() => new ExpirableRedisAdapter(undefined, { user: { limit: -1 } }), /limit/);
		assert.doesNotThrow(() => new ExpirableRedisAdapter(undefined, { user: { limit: Number.POSITIVE_INFINITY } }));
	});
});
