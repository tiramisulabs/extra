# @slipher/cache-reconciler

Seyfert plugin that reconciles a cache with the Gateway's authoritative snapshots.

After a new `READY`, nothing cached earlier in that shard's guilds is served until the session's guild snapshots
confirm it, and the entries those snapshots prove stale are removed. That covers a session Discord invalidated inside
a running process, with any adapter, and a cache that outlives the process. The plugin makes no REST calls: an entry
it does not serve is an ordinary cache miss.

The [full guide](https://seyfert.dev/docs/plugins/official/cache-reconciler) covers what each snapshot can prove, the
guarantee per configuration, the Redis coordinator, and the known limits.

## Install

```sh
pnpm add @slipher/cache-reconciler
```

Requires Seyfert 6. The Redis coordinator additionally requires `@redis/client` 6, exactly `@slipher/redis-adapter`
0.0.9, and Redis 8.0 or newer with a single writable keyspace; Redis Cluster is unsupported.

## Setup

```ts
import { cacheReconciler, memoryCoordinator } from '@slipher/cache-reconciler';
import { RedisAdapter } from '@slipher/redis-adapter';
import { Client, definePlugins } from 'seyfert';

const client = new Client({
	plugins: definePlugins(cacheReconciler({ coordinator: memoryCoordinator() })),
});

client.setServices({
	cache: {
		adapter: new RedisAdapter({ redisOptions: { url: process.env.REDIS_URL }, namespace: 'bot-cache' }),
	},
});

await client.start();
```

Create the client with the plugin, configure the adapter with `setServices()`, then call `client.start()`. An adapter
assigned after that is not wrapped. The plugin adds the `Guilds` intent.

| Coordinator | Use when |
| --- | --- |
| `memoryCoordinator()` | Exactly one process reads and writes the cache, with any adapter except `WorkerAdapter` |
| `redisCoordinator()` | Several processes share one `RedisAdapter` cache; every one of them needs the plugin |

### Processes that share a Redis cache

```ts
import { cacheReconciler } from '@slipher/cache-reconciler';
import { redisCoordinator } from '@slipher/cache-reconciler/coordinators/redis';
import { RedisAdapter } from '@slipher/redis-adapter';
import { definePlugins, WorkerClient } from 'seyfert';

const adapter = new RedisAdapter({ redisOptions: { url: process.env.REDIS_URL }, namespace: 'bot-cache' });

const client = new WorkerClient({
	plugins: definePlugins(
		cacheReconciler({
			coordinator: redisCoordinator({
				client: adapter.client,
				cacheNamespace: adapter.namespace,
				namespace: 'bot-cache-reconciler',
			}),
		}),
	),
});

client.setServices({ cache: { adapter } });

await client.start();
```

`client` and `cacheNamespace` must be the adapter's own, and every process that shares the cache must use the same
`namespace`. Only the `coordinators/redis` entry point loads Redis.

## Status

```ts
const status = client.cacheReconciler.status();
await client.cacheReconciler.waitForIdle();
```

The manager is observability only. `waitForIdle()` does not time out, so race it with your own deadline when the wait
has to be bounded.

## Operational warnings

- **No warm guild cache after a restart.** Entries stored earlier are misses until the new session confirms them, so
  expect more REST fallbacks until the Gateway has repopulated the cache.
- **Every writer goes through the plugin.** A cache shared by several processes with `memoryCoordinator()`, or with the
  plugin missing in one of them, is not detected: one process can serve or delete what another maintains.
- **Refused setups.** Seyfert's `WorkerAdapter`, `WorkerManager.hotReload` replacement workers, and
  `disabledCache.onPacket`. With `redisCoordinator()` also `ExpirableRedisAdapter`, a `RedisAdapter` subclass, and an
  adapter object that another plugin, such as `@slipher/cache-integrity`, replaced first.
- **Redis reads and writes change.** `get`, `bulkGet`, and `scan` take one extra round trip. Reconciled writes run as
  Lua scripts on the Redis client, so instrumentation on the `RedisAdapter` methods does not see them.
- **Losing a shard lease is terminal.** That instance stops serving reconciled resources until the process restarts.
  After a crash, a process that restarts quickly handles nothing on that shard until the old lease expires, up to 30
  seconds.
- **Shutdown order.** Stop the shards before or together with closing the client, and close the Redis client after
  `client.close()` resolves.
- **Resharding.** Change the shard count with the previous processes stopped.
