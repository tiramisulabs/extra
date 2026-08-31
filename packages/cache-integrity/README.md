# @slipher/cache-integrity

Seyfert plugin that prevents persisted cache entries from becoming ghost data after a process restart.

The plugin wraps the configured cache adapter with a process-local visibility layer. Values and relationships that
already exist in persistent storage begin hidden. Once the current process writes an entry, normal reads can return it.
Hidden entries behave as ordinary cache misses, so the resource's configured `flow` still decides whether to fetch from
Discord.

## Install

```sh
pnpm add @slipher/cache-integrity
```

Requires Seyfert v5.

## Setup

```ts
import { createClient } from '@redis/client';
import { cacheIntegrity } from '@slipher/cache-integrity';
import { RedisAdapter } from '@slipher/redis-adapter';
import { Client, definePlugins } from 'seyfert';

const redis = createClient({ url: process.env.REDIS_URL });
const persistentAdapter = new RedisAdapter({
	client: redis,
	namespace: 'bot-cache',
});

const client = new Client({
	plugins: definePlugins(cacheIntegrity()),
});

client.setServices({
	cache: {
		adapter: persistentAdapter,
	},
});

await client.start();
```

Configure the adapter with `setServices()` before `client.start()`. The plugin is adapter-agnostic and does not require
Redis-specific setup or cross-process coordination.

## Behavior

Each plugin installation represents one process generation:

- `get`, `bulkGet`, and `scan` ignore values that this process has not written.
- relationship reads ignore relationships that this process has not written.
- `patch` replaces a hidden value instead of merging with its stale persisted fields.
- successful writes make their entries visible; failed writes do not.
- removals and `flush` update visibility only after the backing adapter succeeds.

Physical data from older generations may remain in the backing store. The plugin provides logical isolation, not
garbage collection.

Visibility is intentionally local and key-based. The first successful local write admits that key for the rest of the
plugin generation. A later write that bypasses the wrapper—including a write from another process—can therefore change
the admitted value. Use one writer per keyspace, or partition shared storage so processes do not overwrite each other's
admitted keys. This plugin does not provide cross-process isolation.

Seyfert's RPC-backed `WorkerAdapter` is not supported. Seyfert v5 resolves worker cache responses through the exact
adapter instance installed on the client, so wrapping it would leave cache requests pending until timeout. Install the
plugin where a real adapter is configured instead.

Using the plugin with Seyfert's `MemoryAdapter` is supported but redundant because that adapter already starts empty.
