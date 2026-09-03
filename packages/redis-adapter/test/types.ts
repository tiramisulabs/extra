import { createClient } from '@redis/client';
import type { Adapter } from 'seyfert/lib/cache';
import {
	ExpirableRedisAdapter,
	type ExpirableRedisAdapterOptions,
	RedisAdapter,
	type ResourceLimitedMemoryAdapter,
} from '../src';

const resource = {
	expire: 1_000,
	limit: 10,
	native: false,
	ondemand: true,
} satisfies ResourceLimitedMemoryAdapter;

const options = {
	default: resource,
	message: { expire: 500, limit: 0 },
	migrateLegacyRelationships: true,
	user: { native: true },
} satisfies ExpirableRedisAdapterOptions;

new ExpirableRedisAdapter({ redisOptions: {} }, options);
new ExpirableRedisAdapter(
	{
		client: createClient({
			RESP: 3,
			clientSideCache: { evictPolicy: 'LRU', maxEntries: 100, ttl: 0 },
		}),
	},
	{ default: { native: true } },
);

const atomicAdapter = new RedisAdapter({ redisOptions: {} });
const adapterContract: Adapter = atomicAdapter;
adapterContract.set('user.1', { id: '1' }, ['user', '1']);
adapterContract.patch('user.1', { username: 'updated' }, ['user', '1']);
adapterContract.bulkSet([['user.1', { id: '1' }, ['user', '1']]]);
const atomicCooldownContract: {
	supportsAtomicCooldowns: true;
	eval<T = unknown>(script: string, keys: string[], args: string[]): Promise<T>;
} = atomicAdapter;
void atomicCooldownContract;

// @ts-expect-error the atomic contract requires relationship ownership on every write
adapterContract.set('user.1', { id: '1' });

// @ts-expect-error split relationship writes were removed from Seyfert's adapter contract
adapterContract.addToRelationship('user', '1');

// @ts-expect-error on-demand is a boolean policy
new ExpirableRedisAdapter({ redisOptions: {} }, { user: { ondemand: 'yes' } });

// @ts-expect-error resource names are explicit
const invalidOptions: ExpirableRedisAdapterOptions = { unknown_resource: {} };
void invalidOptions;
