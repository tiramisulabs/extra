# @slipher/cache-reconciler

Seyfert plugin that reconciles a persistent cache with the Gateway's authoritative snapshots.

The plugin wraps the configured cache adapter. Entries that Discord no longer confirms stop being readable
immediately and are physically removed afterwards, so a deleted role, channel, or guild cannot be served from a cache
that outlived the process that wrote it.

This package is under construction; the behavior and guarantees are documented as each part lands.

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

Configure the adapter with `setServices()` before `client.start()`. The plugin replaces `client.cache.adapter` during
plugin setup and restores the original adapter when the client closes.

Requires Seyfert 6.

## Unsupported configurations

- Seyfert's RPC-backed `WorkerAdapter`. The real store lives in the `WorkerManager` process, where the plugin does not
  run, and Seyfert resolves worker cache responses through the adapter instance installed on the client. Give each
  `WorkerClient` a real adapter instead.
- `WorkerManager.hotReload` replacement workers. A standby worker skips cache processing for its startup guild stream,
  so the replacement would activate without a reconciled snapshot.

Both are refused during plugin setup, before the adapter is replaced.
