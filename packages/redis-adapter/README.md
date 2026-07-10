# @slipher/redis-adapter

Redis-backed cache adapters for Seyfert.

## Basic adapter

```ts
import { Client } from 'seyfert';
import { RedisAdapter } from '@slipher/redis-adapter';

const client = new Client();

client.setServices({
	cache: {
		adapter: new RedisAdapter({
			redisOptions: { url: process.env.REDIS_URL },
			namespace: 'my-bot',
		}),
	},
});

await client.start();
```

## Expiration and per-resource caching

`ExpirableRedisAdapter` accepts a `default` policy plus overrides for Seyfert resources such as `user`, `guild`, `member`, and `message`.

```ts
import { ExpirableRedisAdapter } from '@slipher/redis-adapter';

const adapter = new ExpirableRedisAdapter(
	{
		redisOptions: { url: process.env.REDIS_URL },
		namespace: 'my-bot',
	},
	{
		default: {
			expire: 5 * 60_000,
			ondemand: true,
			limit: 1_000,
		},
		message: {
			expire: 30_000,
			limit: 100,
		},
		presence: {
			ondemand: false,
		},
	},
);
```

Resource overrides inherit every omitted value from `default`.

| Option | Behavior |
| --- | --- |
| `expire` | Redis TTL in milliseconds. Positive values refresh the TTL on writes; zero or negative values remove an existing TTL; `undefined` leaves an existing TTL unchanged. |
| `ondemand` | Enables an adapter-local LRU read-through and write-through cache. Disabled by default. |
| `limit` | Maximum local entries for that resource. `0` disables local caching; `undefined` or `Infinity` is unlimited. |
| `native` | Disables the adapter-local cache for that resource. Use this when the supplied node-redis client already has RESP3 `clientSideCache` configured. This option does not enable node-redis caching itself. |

The adapter-local cache uses Redis' remaining `PTTL`, so it never intentionally outlives the Redis key. It is process-local and does not receive cross-process invalidations. For data changed by multiple processes, prefer node-redis client-side caching with RESP3 or keep `ondemand` disabled.

Both adapters own clients they construct. Close the client during shutdown:

```ts
adapter.client.close();
```
