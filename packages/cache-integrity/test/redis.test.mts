import { ExpirableRedisAdapter } from '@slipher/redis-adapter';
import { Cache, CacheFrom, PresenceUpdateStatus } from 'seyfert';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { CacheIntegrityAdapter } from '../src/adapter';

const inner = new ExpirableRedisAdapter(
	{
		namespace: `slipher_integrity_${process.pid}`,
		redisOptions: { url: process.env.SLIPHER_REDIS_URL ?? 'redis://127.0.0.1:6379' },
	},
	{ default: { expire: 60_000, ondemand: true } },
);
beforeAll(() => inner.start());
afterAll(async () => {
	await inner.flush();
	inner.client.close();
});

test('preserves scoped resource ownership, restart admission, and relationship cleanup in Redis', async () => {
	const adapter = new CacheIntegrityAdapter(inner, 30_000);
	const cache = new Cache(0, adapter, {}, {} as never);
	const presence = {
		activities: [],
		client_status: {},
		status: PresenceUpdateStatus.Online as const,
		user: { id: 'shared' },
	};
	await cache.presences!.set(CacheFrom.Test, 'shared', 'one', { ...presence, guild_id: 'one' });
	await cache.presences!.set(CacheFrom.Test, 'shared', 'two', { ...presence, guild_id: 'two' });
	await cache.presences!.patch(CacheFrom.Test, 'shared', 'one', {
		user: { id: 'shared' },
		guild_id: 'one',
		status: PresenceUpdateStatus.Idle,
	});
	expect((await cache.presences!.get('shared', 'one'))?.status).toBe('idle');
	expect((await cache.presences!.get('shared', 'two'))?.status).toBe('online');
	expect(await adapter.keys('presence.one')).toEqual(['presence.one.shared']);
	const restarted = new CacheIntegrityAdapter(inner, 30_000);
	expect(await restarted.get('presence.one.shared')).toMatchObject({ status: 'idle' });
	expect(await restarted.keys('presence.one')).toEqual([]);
	expect(await restarted.scan('presence.*')).toEqual([]);

	await adapter.removeToRelationship('presence.one', 'shared');
	expect(await adapter.keys('presence.one')).toEqual([]);
	expect(await restarted.get('presence.one.shared')).toBeUndefined();
	expect(await adapter.get('presence.two.shared')).toMatchObject({ status: 'online' });
	await adapter.removeRelationship('presence.*');
	expect(await adapter.get('presence.two.shared')).toBeUndefined();
	expect(await adapter.keys('presence.two')).toEqual([]);

	await adapter.set('message.123', { id: '123' }, ['message.456', '123']);
	expect(await adapter.values('message.456')).toEqual([{ id: '123' }]);
	const metadataKeys = await inner.scan('__slipher_cache_integrity__.*', true);
	expect(metadataKeys.length).toBeGreaterThan(0);
	for (const key of metadataKeys) {
		expect(key.split('.')).toHaveLength(2);
		const ttl = await inner.client.pTTL(`${inner.namespace}:${key}`);
		expect(ttl).toBeGreaterThan(0);
		expect(ttl).toBeLessThanOrEqual(60_000);
	}
	await adapter.remove('message.123');
	expect(await adapter.values('message.456')).toEqual([]);
});
