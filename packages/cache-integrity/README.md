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

Requires Seyfert v5 with the atomic adapter contract. The Redis setup below requires Redis 8.0 or newer and a single
writable keyspace; Redis Cluster is unsupported.

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

Each successful write commits the value and its supplied relationship through the backing adapter, then stores a
timestamp sidecar as a separate atomic entry. Value and relationship become locally visible after both writes succeed.
After a restart:

- `get` and `bulkGet` return persisted values whose timestamp is no older than `maxAge`.
- `scan`, `values`, and relationship reads return only entries rebuilt by the current process.
- `patch` preserves a recent value, but replaces an expired or unverified value so stale fields cannot survive.
- entries without sidecar metadata, including entries written before this behavior existed, are cache misses.
- new or unverified values and their relationships become visible only after both the entry and its metadata succeed.

The generic adapter contract cannot atomically write an entry and its sidecar together. If refreshing metadata fails,
the write rejects, but an overwrite can remain readable through existing current-process visibility or a previous
valid timestamp. After restart, that older timestamp does not extend the persisted reuse window. A failed write does
not roll back the backing adapter or revoke visibility established by an earlier successful write.

Bulk writes and removals attempt every entry in bounded groups and report failures with an `AggregateError` only after
all submitted work settles. Successful entries remain committed and visible. There is no batch atomicity. The wrapper
uses per-entry operations so it can publish the successful subset even when another entry fails.

`maxAge` applies to values reused from an earlier process. Values successfully written by the current process remain
locally visible beyond that window, while they exist in the backing adapter. A warm read does not grant that visibility
or add the entry to scans and relationships.

Relationship removals delete owned values and memberships, but their hidden sidecars may remain until adapter expiry
or `flush`. Direct `remove` and `bulkRemove` also delete the corresponding sidecars.

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
