# @slipher/cache-integrity

Seyfert plugin that bounds persisted cache staleness after a process restart.

The plugin wraps the configured cache adapter with a freshness window and a process-local visibility layer. Direct
lookups can reuse recently written persisted values. Relationships and enumerations from an earlier process remain
hidden until current Gateway or REST writes rebuild them. Hidden or expired entries behave as ordinary cache misses, so
the resource's configured `flow` still decides whether to fetch from Discord.

## Install

```sh
pnpm add @slipher/cache-integrity
```

Requires Seyfert v5.

## Setup

```ts
import { createClient } from '@redis/client';
import { cacheIntegrity } from '@slipher/cache-integrity';
import { ExpirableRedisAdapter } from '@slipher/redis-adapter';
import { Client, definePlugins } from 'seyfert';

const maxAge = 5 * 60_000;
const retention = 24 * 60 * 60_000;
const redis = createClient({ url: process.env.REDIS_URL });
const persistentAdapter = new ExpirableRedisAdapter(
	{
		client: redis,
		namespace: 'bot-cache',
	},
	{
		default: {
			expire: retention,
			ondemand: true,
		},
	},
);

const client = new Client({
	plugins: definePlugins(cacheIntegrity({ maxAge })),
});

client.setServices({
	cache: {
		adapter: persistentAdapter,
	},
});

await client.start();
```

Configure the adapter with `setServices()` before `client.start()`. `maxAge` controls whether a persisted value may be
reused after a restart; the adapter's `expire` controls how long values, relationships, and freshness metadata remain
physically stored. Keep `expire` at least as large as `maxAge` if the entire freshness window should be reusable.

The plugin is adapter-agnostic and does not require Redis-specific setup or cross-process coordination. An adapter
without expiration is also valid, but expired and hidden physical data can then remain until an explicit removal or
`flush`.

## Behavior

`maxAge` is required and expressed in milliseconds. It is the maximum persisted staleness the application accepts for
lookups by explicit key.

Each successful value write stores a timestamp sidecar in the same adapter. After a restart:

- `get` and `bulkGet` return persisted values whose timestamp is no older than `maxAge`.
- `scan`, `values`, and relationship reads return only entries rebuilt by the current process.
- `patch` preserves a recent value, but replaces an expired or unverified value so stale fields cannot survive.
- entries without sidecar metadata, including entries written before this behavior existed, are cache misses.
- new or unverified values become visible only after both the value and its metadata succeed.

The generic adapter contract cannot atomically write a value and its sidecar. If an already recent value is overwritten
but refreshing its timestamp fails, the newer value can remain readable under the previous timestamp until that
timestamp expires. The timestamp is conservative, so the configured staleness bound still holds.

`maxAge` is not a storage TTL. Without expiration in the backing adapter, physical data from older processes may remain
indefinitely. The plugin provides logical isolation, not garbage collection or authoritative validation against
Discord.

Current-process visibility is intentionally local and key-based. A later write that bypasses the wrapper—including a
write from another process—can therefore change an admitted value without refreshing its metadata. Use one writer per
keyspace, or partition shared storage so processes do not overwrite each other's entries. This plugin does not provide
cross-process isolation.

Seyfert's RPC-backed `WorkerAdapter` is not supported. Seyfert v5 resolves worker cache responses through the exact
adapter instance installed on the client, so wrapping it would leave cache requests pending until timeout. Install the
plugin where a real adapter is configured instead.

Using the plugin with Seyfert's `MemoryAdapter` is supported but redundant because that adapter already starts empty.
