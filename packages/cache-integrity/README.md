# @slipher/cache-integrity

Seyfert plugin that prevents stale Discord cache entries from surviving a restart. It correlates Gateway packets with
the exact cache mutations performed by Seyfert, hides entries invalidated by authoritative snapshots, and removes them
only while the same causal evidence is still current.

The plugin does not make REST requests. A hidden or deleted entry behaves as a normal cache miss, so the caller's
configured `flow` still decides whether to fetch it from Discord.

## Install

```sh
pnpm add @slipher/cache-integrity
```

Requires Seyfert v5. The shared Redis coordinator additionally requires `@redis/client` 6.1.x and
`@slipher/redis-adapter` 0.0.9.

## Single-process setup

`localCoordinator()` supports a persistent adapter when exactly one process owns its storage. For example, a bot can
use a Redis-backed cache without claiming cross-process coordination:

```ts
import { createClient } from '@redis/client';
import { RedisAdapter } from '@slipher/redis-adapter';
import { cacheIntegrity, localCoordinator } from '@slipher/cache-integrity';
import { Client, definePlugins } from 'seyfert';

const redis = createClient({ url: process.env.REDIS_URL });
const adapter = new RedisAdapter({ client: redis, namespace: 'bot-cache' });
const integrity = cacheIntegrity({
	coordinator: localCoordinator(),
});

const plugins = definePlugins(
	integrity,
	// Plugins that contribute gateway.onDispatch must come after cache integrity.
);

const client = new Client({ plugins });
client.setServices({ cache: { adapter } });
await client.start();
```

`localCoordinator()` stores only causal metadata in process memory; the adapter may remain persistent. Using it with
Seyfert's `MemoryAdapter` is supported but adds no restart-recovery value because that adapter already starts empty.
The test suite uses `MemoryAdapter` only as a synchronous storage fixture.

Configure the adapter with `setServices()` before `client.start()`. Cache integrity must be the first resolved plugin
that contributes `gateway.onDispatch`; setup fails before replacing the adapter when an earlier interceptor exists.

## Shared Redis setup

Distributed fencing is intentionally narrower than Seyfert's generic `Adapter` contract. Import it from the optional
subpath and use the exact `RedisAdapter` implementation from `@slipher/redis-adapter` 0.0.9:

```ts
import { createClient } from '@redis/client';
import { RedisAdapter } from '@slipher/redis-adapter';
import { cacheIntegrity } from '@slipher/cache-integrity';
import { redisCoordinator } from '@slipher/cache-integrity/coordinators/redis';
import { Client, definePlugins } from 'seyfert';

const redis = createClient({ url: process.env.REDIS_URL });
const adapter = new RedisAdapter({ client: redis, namespace: 'bot-cache' });

const integrity = cacheIntegrity({
	coordinator: redisCoordinator({
		client: redis,
		cacheNamespace: adapter.namespace,
		namespace: 'bot-cache-integrity',
	}),
});

const plugins = definePlugins(integrity);
const client = new Client({ plugins });
client.setServices({ cache: { adapter } });
await client.start();
```

The two namespaces must be non-empty, disjoint keyspaces without Redis glob characters, and must not end in `:`. The
coordinator accepts a standalone `@redis/client` 6.1.x client without `keyPrefix`. `RedisAdapter.start()` connects the
client before the coordinator starts. The coordinator never calls `connect()` or `close()` on that transport; the
caller remains responsible for shutting it down.

Every process that shares a `cacheNamespace` must use the exact same coordinator `namespace`. The first successful
start stores that pairing in the persistent string key
`${cacheNamespace}:__slipher_cache_integrity_control`; the key is reserved for this package and intentionally survives
clean shutdown so a separately configured coordinator cannot acquire the same cache later.

The Redis coordinator owns every adapter data operation. Value mutations, relationship mutations, visibility changes,
delete claims, and generation fences are committed atomically with Lua. Reads are authoritative in Redis and therefore
have an additional asynchronous Redis cost, including reads that would otherwise be adapter-local. Existing wrappers
around `RedisAdapter` mutation methods do not observe coordinator-owned Lua; instrument the Redis transport or wrap the
installed `ReconciledAdapter` when those operations must be observed.

`ExpirableRedisAdapter`, Redis subclasses, clusters, sentinels, clients with `keyPrefix`, and other shared adapters are
not supported by `redisCoordinator()` in this version. Writes that bypass the installed reconciled adapter are outside
the distributed guarantee.

## Visibility and cleanup

Cache integrity separates logical visibility from physical cleanup:

- `visible`: current evidence validated the entry, so normal reads may return it.
- `unknown-preserved`: the entry predates complete evidence. Normal reads miss, but no deletion is authorized.
- `hidden-pending`: authoritative evidence identified a ghost. Reads miss immediately; physical deletion proceeds only
  while its generation and causal fence remain current.
- reconciled: the stale physical entry was removed, or a later successful write superseded the pending deletion.

A failed physical removal remains hidden and appears in diagnostics. A later authoritative snapshot may retry it; the
plugin does not run an independent retry scheduler. A later write always defeats an older sweep before the destructive
boundary.

Snapshot completeness is resource-specific:

| Resource | Startup behavior |
| --- | --- |
| Guild existence | Replaced from the shard's `READY` guild set after all expected guild outcomes settle |
| Roles, non-thread channels, emojis, overwrites, voice states, stage instances | Replaced by an available guild snapshot |
| Stickers | Replaced only when the snapshot field is present |
| Active/viewable threads | Replaced within the shared channel namespace; archived or unclassified threads are preserved |
| Members and presences | Partial; previous entries are hidden until reobserved and are never snapshot-swept |
| Messages and bans | Preserved as unknown until a current write; never startup-swept |
| Users | Globally visible after a current write and never owned or swept by one shard |

An unavailable guild is preserved. A stale guild is removed through Seyfert's existing guild cascade under an internal
task-local unfiltered scope, so hidden descendants remain discoverable to the cleanup without becoming visible to
concurrent callers.

## Processes and workers

- `localCoordinator()` provides causal visibility and cleanup only inside one process. Do not use it to claim
  cross-process safety over shared storage.
- `redisCoordinator()` coordinates multiple clients or workers sharing the same supported RedisAdapter namespace. Shard
  leases, coordinator incarnations, committed generations, tombstones, and flush barriers fence old owners.
- Redis reclaims hidden state tombstones in bounded background batches only after every coordinator incarnation capable
  of issuing an earlier operation has stopped. Visible state records are never removed by this compaction.
- A `WorkerClient` is supported when it owns a real adapter. Seyfert's RPC-backed `WorkerAdapter` is rejected before the
  plugin changes the client because its actual store lives in `WorkerManager`, outside the plugin process.
- A replacement worker that receives only `RESUMED` cannot prove the Discord session generation. Shard-scoped reads and
  mutations stay fail-closed until that instance observes a new `READY`.

Lease loss or Redis transport failure is terminal for that coordinator instance: new visibility-dependent reads return
cache-miss shapes, pending destructive work is fenced, and the cause is exposed through diagnostics. Recovery requires
a fresh client/plugin/coordinator instance; the failed incarnation never reacquires ownership.

## Lifecycle and diagnostics

The plugin instance is one-shot. Replacing `client.cache.adapter`, `client.cache.onPacket`, the paired cache-write
handlers, or Seyfert's public member or presence duplicate-filter handlers after installation terminally disables
reconciliation. The paired write handlers carry REST message and empty-overwrite ownership across Seyfert's separate
relationship and value mutations. Observing the two duplicate filters lets a deduplicated packet settle without
waiting for core cache processing while still fencing admitted updates to their original READY generation. During
teardown, the plugin stops new work, drains admitted operations, releases only leases it still owns, and restores each
hook only when it remains the current owner. It does not close the backing adapter or caller-owned Redis client.

The client extension is observability-only:

```ts
const status = client.cacheIntegrity.status();
await client.cacheIntegrity.waitForIdle();
```

`status()` reports lifecycle, adapter ownership, correlation counts, and deduplicated diagnostics. The public API does
not expose manual flush or deletion operations.
