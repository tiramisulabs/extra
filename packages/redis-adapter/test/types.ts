import { createClient } from '@redis/client';
import { ExpirableRedisAdapter, type ExpirableRedisAdapterOptions, type ResourceLimitedMemoryAdapter } from '../src';

const resource = {
	expire: 1_000,
	limit: 10,
	native: false,
	ondemand: true,
} satisfies ResourceLimitedMemoryAdapter;

const options = {
	default: resource,
	message: { expire: 500, limit: 0 },
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

// @ts-expect-error on-demand is a boolean policy
new ExpirableRedisAdapter({ redisOptions: {} }, { user: { ondemand: 'yes' } });

// @ts-expect-error resource names are explicit
const invalidOptions: ExpirableRedisAdapterOptions = { unknown_resource: {} };
void invalidOptions;
