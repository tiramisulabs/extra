# @slipher/cache-reconciler

Seyfert plugin that reconciles a persistent cache with the Gateway's authoritative snapshots.

A cache that outlives the process that wrote it keeps whatever Discord changed while nobody was listening: a role
deleted during a deploy, a channel removed while a shard was reconnecting, a guild the bot was kicked from. The plugin
wraps the configured cache adapter so that such entries stop being readable as soon as a new Gateway session starts,
and removes them physically once the session's guild snapshots show what is actually there.

The plugin makes no REST calls. An entry it does not serve is an ordinary cache miss.

## Install

```sh
pnpm add @slipher/cache-reconciler
```

Requires Seyfert 6. The Redis coordinator additionally requires `@redis/client` 6, `@slipher/redis-adapter` 0.0.9,
and Redis 8.0 or newer with a single writable keyspace; Redis Cluster is unsupported.

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

`memoryCoordinator()` keeps the reconciliation state in the process. It works with any adapter and is correct while
exactly one process reads and writes that cache.

### Configuration order

1. Create the client with the plugin in `definePlugins()`.
2. Configure the adapter with `setServices({ cache: { adapter } })`.
3. Call `client.start()`.

The plugin replaces `client.cache.adapter` during plugin setup, which runs inside `client.start()` before the adapter
is started, and restores the original adapter when the client closes. An adapter assigned after setup is not wrapped:
`status().adapter` reports `replaced` and the plugin records a `cache-reconciler-adapter-replaced` diagnostic in
`client.plugins.diagnostics`. A plugin instance serves one client start; create a new client, adapter, and
`cacheReconciler()` to start again.

The plugin adds the `Guilds` intent, because the startup guild stream is its evidence. It also needs Seyfert's cache
to process Gateway packets: with `disabledCache.onPacket` the client refuses to start. To find that out it sends one
synthetic `@slipher/cache-reconciler:probe` packet through the cache resources of every plugin when plugins are ready.

### Workers that share a Redis cache

When several processes use the same Redis cache, each of them needs the plugin with `redisCoordinator()`, which keeps
ownership and visibility in Redis instead of in one process:

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

`client` and `cacheNamespace` must be the adapter's own. `namespace` is the prefix of the coordinator's own keys;
every process that shares the cache must use the same one. It may sit under the cache namespace, but then a raw
`scan('*')` on the adapter lists the coordinator's keys too.

The package root does not import Redis. Only the `coordinators/redis` entry point loads `@redis/client` and
`@slipher/redis-adapter`.

## What a reader sees

Each reconciled entry is in one of these states.

| State | Meaning | Reads | Physical deletion |
| --- | --- | --- | --- |
| `visible` | Written or confirmed in the current session of its shard, at or after its guild's snapshot. | Returned | Only by the usual cache removals |
| `unknown-preserved` | Stored, but nothing in the current session confirmed it. | Miss | Not in this state: a complete snapshot that leaves it out, or the removal of its guild, makes it `hidden-pending` first |
| `hidden-pending` | Authoritative evidence says it is gone; its removal is outstanding or failed. | Miss | Yes, while the evidence is still current |

A **ghost** is an entry that is stored although Discord no longer has it. Before a session confirms anything, every
stored entry is a potential ghost, so all of them start as `unknown-preserved`. A guild is **reconciled** once its
startup snapshot was cached and the entries that snapshot proves stale were removed.

Hiding and deleting are separate steps. Hiding is immediate and happens on evidence alone: a `READY` hides every guild
of its shard at once, before any snapshot arrived. Deleting follows in the background, only for entries a complete
snapshot leaves out, and only while no later write or session superseded that snapshot.

An entry that could not be deleted is not served again, and `status()` reports the failure. With `memoryCoordinator()`
it stays hidden, and a later snapshot or guild removal that covers it deletes it. With `redisCoordinator()`, cleanup
that failed leaves its entries unreadable as they were, and a removal Redis never answered runs again before that
process does anything else with the cache; until Redis answers, its reconciled reads and writes fail rather than
serve what was removed.

This is what happens over a session:

- `READY` starts a new session for its shard. Everything in the shard's guilds becomes unreadable. With
  `redisCoordinator()` that happens when the new session acquires the shard, which waits for a previous owner that is
  still alive; see [Shard ownership](#shard-ownership).
- Each startup guild snapshot makes that guild's entries readable again as Seyfert caches them. Entries of a
  replaceable resource that the snapshot does not list are deleted.
- A guild reported as unavailable confirms nothing. Its entries stay stored and unreadable until the guild arrives.
- Once every guild listed in `READY` has an outcome, guilds the cache still holds but `READY` never listed are
  removed with everything under them: the bot left them while nobody was updating this cache.
- A guild delete that is a real removal closes the guild and removes what is left of it. `unavailable: true` is an
  outage, never a removal.
- `RESUMED` continues the session for the process that saw its `READY`. A process that receives `RESUMED` for a
  session it never validated cannot tell which guilds that shard owns. Until the shard's next `READY` it only serves
  the guilds of its other, validated shards, and `status()` shows the shard as `awaiting-ready`. What it writes
  elsewhere in the meantime is stored but not served with `memoryCoordinator()`. With `redisCoordinator()` its writes
  and removals there are dropped without an error, because another process may own those guilds.

A write that follows a later Gateway packet wins over the cleanup of an earlier snapshot, in either completion order:
each write is stamped with the latest sequence its shard had seen when it was issued, and cleanup only removes
entries stamped at or before the snapshot's own sequence. [Limits](#limits) lists the two cases this does not cover.

### What a snapshot can prove

Only a resource Discord lists completely in the startup guild payload can be deleted for being absent from it.

| Resource | Startup snapshot | Absent entries |
| --- | --- | --- |
| Roles, emojis, stickers, voice states, stage instances | Complete when the field is present | Deleted |
| Channels | Complete | Deleted |
| Threads | Active threads only | Deleted when cached as active; archived threads are kept |
| Permission overwrites | Per listed channel | Deleted with their channel, or when the channel lists none |
| Members, presences | Partial | Kept, unreadable until written again |
| Bans, messages | Not included | Kept, unreadable until written again |
| Guilds | `READY` lists the shard's guilds | Removed with their descendants once startup completes |

A field that is missing from the payload preserves what is cached; a field that is present and empty replaces it with
nothing. Messages follow the guild of their channel, which the plugin knows from the channel being cached. A message
whose channel it never saw cached, as with the channels cache disabled, belongs to no guild.

Users, DM channels, and application emojis belong to no guild, so no snapshot ever lists them. They are served once
written through the plugin and are never swept. With `memoryCoordinator()` that means written by this process; with
`redisCoordinator()` it means written by any coordinated process, which survives restarts.

Resources of other plugins that live on the same adapter are not reconciled. Their reads and writes pass through.

## Cache misses and `flow`

The plugin never fetches. An entry it hides is a miss for whoever asked, and the mode of that call decides what
happens next: `'cache'` returns nothing, and `'flow'`, Seyfert's default, falls back to REST and caches the fresh
value. The same goes for `fetch()` helpers called without `force`. A value cached that way is readable if it was
cached after its guild's snapshot arrived in the current session; one cached earlier is superseded by that snapshot.
Expect more REST fallbacks right after a restart, mostly for members, until the Gateway has repopulated the cache.

## Guarantees by configuration

| Configuration | Guarantee |
| --- | --- |
| One process, any adapter, `memoryCoordinator()` | Entries no current session confirmed are not served, and stale entries of replaceable resources are removed. |
| Several `WorkerClient`s or processes, each with its own `RedisAdapter`, all with `redisCoordinator()` | The same, across processes: a key hidden by one worker is hidden for all, and a former owner cannot delete or overwrite what the new owner of a shard cached. |
| Seyfert's RPC-backed `WorkerAdapter` | Unsupported; refused during setup. |
| `WorkerManager.hotReload` replacement workers | Unsupported; refused during setup. |
| A cache shared by several processes with `memoryCoordinator()`, or with the plugin missing in some of them | Unsupported and not detected. Each process only knows its own evidence, so one can serve or delete what another one maintains. |

`WorkerAdapter` is refused because the real store lives in the `WorkerManager` process, where the plugin does not run.
Give each `WorkerClient` a real adapter instead. Hot-reload replacement workers are refused because a standby worker
skips cache processing for its startup guild stream, so it would take over without a reconciled snapshot. A worker
that hot reload stops keeps its process and stops being served the guilds of its shards.

Every process that writes to a shared cache has to write through the plugin. A write that reaches Redis any other way
is outside the guarantee: it is stored but not served, and cleanup may delete it.

## Status

The plugin exposes observability only. It offers no way to change the cache.

```ts
const status = client.cacheReconciler.status();
await client.cacheReconciler.waitForIdle();
```

`status()` returns:

- `coordinator`: `memory` or `redis`.
- `adapter`: `pending`, `installed`, `replaced`, or `restored`.
- `lifecycle`: `installing`, `active`, `closing`, `closed`, or `failed`. `failed` is terminal; `cause` holds the
  reason.
- `idle` and `pending`: guild packets not settled yet, keys hidden while their removal is outstanding, and background
  sweeps in flight. `pending.deletions` is counted by `memoryCoordinator()` only.
- `shards`: per shard, its session, whether its startup is `awaiting-ready`, `awaiting-guilds`, or `committed`, and
  how its `READY` guilds ended: `reconciled`, `unavailable-preserved`, `deleted`, or `failed`.
- `failures` and `failureCount`: the last 50 recorded failures and the total.

`waitForIdle()` resolves once no guild packet is being reconciled, no sweep is running, and every shard that received
`READY` committed its startup snapshot. It resolves immediately before the first `READY`, and it does not time out: a
guild Discord never delivers keeps it pending, so race it with your own deadline when the wait has to be bounded.

## Other plugins that wrap the adapter

The plugin wraps whatever adapter is installed when its setup runs, and other plugins may wrap the result. Order
decides what each layer sees:

- A wrapper installed before `cacheReconciler()` sits underneath it. It sees the reconciler's own reads, including
  the unfiltered ones cleanup uses, and it sees entries the reconciler hides from callers. With `redisCoordinator()`
  the adapter the plugin finds has to be the `RedisAdapter` itself, so a plugin that replaces the adapter object, as
  `@slipher/cache-integrity` does, cannot come first; one that patches the adapter's methods in place can.
- A wrapper installed after it sits on top and only sees what callers are served. Reconciliation keeps working as
  long as that wrapper delegates to the adapter it found. The plugin cannot verify that, so once something else owns
  `client.cache.adapter`, `status().adapter` reports `replaced`, the plugin records a diagnostic, and at teardown it
  leaves the newer adapter in place instead of restoring the original over it.

With `memoryCoordinator()` every mutation still goes through the wrapped adapter's own methods. With
`redisCoordinator()` it does not: reconciled writes and removals run as Lua scripts on the Redis client, so a wrapper
or instrumentation attached to the `RedisAdapter` mutation methods never sees them. Instrumentation that must observe
them has to sit on `client.cache.adapter` after the plugin is installed, or on the Redis client.

## Redis coordinator

### Storage contract

`redisCoordinator()` checks ownership, applies the write fence, changes the cache, and commits visibility in one Lua
script per mutation. That only works if the script writes exactly what the adapter would, so the coordinator depends
on how `RedisAdapter` lays out its storage, which is not a public API:

- It accepts only the `RedisAdapter` class itself; a subclass is refused. The peer dependency pins
  `@slipher/redis-adapter` 0.0.9, the version the coordinator is tested with. That pin is enforced by your package
  manager, not by the coordinator.
- At startup it writes and removes one probe entry of an unreconciled resource and refuses to start if the adapter
  put the value, its relationship membership, its owner entry, or its typed fields somewhere else than the scripts
  expect.
- `ExpirableRedisAdapter` is refused. It owns key expiry and an in-process cache that the scripts would bypass. It
  works with `memoryCoordinator()` in a single process.

Keys written through the coordinator never expire, like keys written by `RedisAdapter`.

### Read cost

Every read of a reconciled resource asks Redis which keys are visible before it returns anything. There is no local
visibility mirror, because a mirror would bring back the staleness between workers that the coordinator exists to
remove.

- `get`, `bulkGet`, and `scan` cost one extra round trip, whatever the number of keys.
- `values`, `keys`, `count`, `contains`, and `getToRelationship` cost no extra round trip: a script takes the place
  of the adapter's own listing command. That script reads the whole relationship and one visibility record per
  member, and Redis runs nothing else meanwhile, so `count` is no longer constant time. On a very large
  relationship, such as the members of a big guild, expect it to take as long as listing the relationship.

The coordinator also keeps one visibility record per reconciled key in Redis, in a single hash under its namespace.
`memoryCoordinator()` keeps the equivalent record per key in process memory.

### Shard ownership

Each coordinator instance has a unique identity and takes a lease per shard when the shard's `READY` arrives. The
lease lasts 30 seconds and is renewed every 10.

- A guild is served only while the instance that delivered it still holds the lease of its shard. When that process
  shuts down, its guilds stop being served to every other process at once; when it crashes, they stop once its lease
  expires. The entries stay stored, and the next owner's snapshots make them readable again or remove them. Expect
  other processes to see cache misses for a shard's guilds while its owner restarts.
- While another instance holds a shard's lease, a new owner waits for it to be released or to expire, and keeps
  reading what that instance maintains. Its cache writes and cleanup for that shard wait with it. Seyfert caches a
  packet before it runs the event's listeners, so the events of that shard wait too: after a crash, a process that
  restarts quickly handles nothing on that shard until the old lease expires. Its other shards are not held up.
  `status().failures` reports the wait once. If the waiting process is closed first, what it was waiting to write is
  dropped.
- Losing a lease is terminal for that instance. It enters `failed`, its reads of reconciled resources miss, its
  reconciled writes and removals are dropped instead of being applied unfenced, and it never takes the lease again.
  Resources of other plugins keep working. Restart the process to recover.
- A new session of the same instance replaces its previous one without giving up the lease.

A process that owns no shard, such as an HTTP worker, can read and write normally. What it writes into a guild is
served under that guild's current owner, and is stored without being served while the guild has none.

### Transport ownership

The Redis client is yours. The coordinator issues commands on it and never connects or closes it; the wrapped
`RedisAdapter` keeps starting it as before. When the client closes, the plugin stops taking on work, waits for
running cleanup, stops renewing, releases the leases it still holds, which is what stops its guilds from being
served, and restores the original adapter. Close the Redis client after `client.close()` resolves.

`client.close()` does not stop the Gateway. Packets that still arrive afterwards are cached through the original
adapter, outside every guarantee here, so stop the shards before or together with closing the client.

## Limits

- Cleanup trusts what Seyfert cached. If caching a guild packet fails in a way the plugin cannot tie to that guild,
  the guild stays pending, and `waitForIdle()` with it, until the shard's next `READY`.
- A guild that was unavailable during startup and arrives later is served from then on, but its stale entries are
  only removed at the next startup.
- A plugin whose Gateway interceptor runs before this one and drops a startup guild packet leaves that shard's
  startup uncommitted.
- A write issued by an old session after the new session's snapshot of the same guild arrived can make one stale entry
  readable until the shard's next `READY`.
- A value cached from REST at the same instant a snapshot is cleaned up can be deleted with it. The next read is a
  miss.
- Two processes connected to the same shard at once are only meant to overlap briefly, as in a rolling restart. The
  second one waits for the first one's lease for as long as the first one lives.
- Change the shard count with the previous processes stopped. Guilds move between shards, and each one is unreadable
  until its new shard delivers it. Processes of two shard counts running against the same cache at once are not a
  supported way to reshard: a new shard waits for the old shard that has the same number, and a guild both of them
  receive is served by whichever delivered it last.
- With `redisCoordinator()`, `increment` on a reconciled key checks that the key is readable and then increments
  through the adapter. It is the one change to a reconciled key that is not a single script.
