# @slipher/redis-adapter

Redis-backed cache adapters for Seyfert's atomic adapter contract. Each `set` or `patch` stores the value and the
relationship membership supplied by Seyfert; the removed `addToRelationship` and `bulkAddToRelationShip` calls are not
part of this API.

The package requires Redis 8.0 or newer and the first Seyfert release containing
[the final atomic adapter contract](https://github.com/tiramisulabs/seyfert/pull/439). While that Seyfert change is under
review, this repository tests against the `pkg.pr.new` preview for #439; do not publish
`@slipher/redis-adapter`, `@slipher/cooldown`, or `@slipher/opentelemetry` against an older tagged Seyfert version. Once
the upstream release exists, update those packages' peer dependency minimum to that exact version before publishing.

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

## Atomicity and failure semantics

Every entry has three pieces of state: its value hash, one field in a relationship hash, and one reverse lookup used by
removal operations. Lua scripts update those pieces in a single isolated Redis operation. The resulting contract is:

- a successful write commits the value and supplied relationship together;
- keys use `resource.id` or `resource.scope.id`, with no dots inside IDs or namespace segments. Each custom resource
  must consistently use one layout. These are caller preconditions, not runtime validation;
- Seyfert's cache resources define entry identity and relationship placement. Passing a different relationship for the
  same physical key is outside the adapter contract; the adapter neither migrates the previous membership nor adds a
  rejection policy for that unsupported input;
- `remove`, `removeToRelationship`, and `removeRelationship` delete values and memberships as one logical operation;
- `bulkRemove` removes each entry atomically, attempts every chunk, and collects failures in an `AggregateError` after
  all submitted removals settle. Successful removals remain committed; the bulk itself is neither atomic nor ordered;
- encoding and supported Redis type checks complete before the first mutation;
- `set` replaces the stored value, while object `patch` merges fields and array `patch` replaces the array;
- `bulkSet` and `bulkPatch` encode their complete input before sending writes, then submit bounded Lua scripts of at most
  100 entries. Each script preflights its entries, commits the valid subset, and reports one result per entry in a single
  round trip. The batch is not atomic or ordered. The adapter attempts every chunk, accumulates per-entry failures, and
  rejects with an `AggregateError` only after all chunks settle. Any subset may therefore be committed, but no writes
  remain active after the caller observes failure. An encoding failure still rejects before the first write because
  complete-batch encoding is the bulk-write preflight.

`removeRelationship` is atomic for each supplied relationship and its runtime is proportional to that relationship's
member count. Prefer bounded relationships or explicit member removal when one relationship can grow very large,
because Redis runs a Lua script without interleaving other commands.

The scripts eliminate application crashes and competing-writer interleavings between value and relationship writes.
Redis does not roll back a Lua script after an unexpected runtime or server error, so the adapter preflights encoding
and supported key-type failures, but it cannot promise rollback after a fatal server-side error such as
an out-of-memory failure during mutation.

Lua is a deliberate choice rather than an incidental implementation detail:

| Mechanism | Fit for this contract |
| --- | --- |
| Pipelining | Does not provide isolation by itself. The adapter uses it to transport independently atomic per-entry scripts without paying one RTT per entry. |
| `MULTI`/`EXEC` | Isolates a fixed command list, but runtime command failures do not roll back earlier commands. |
| `WATCH` + transaction | Can implement compare-and-set, but adds reads, retries, and contention failures to every write. |
| Redis Functions | Can provide the same server-side isolation, but requires installing and versioning library state in every Redis deployment. |
| Lua via `EVALSHA` | Gives one isolated operation and needs no deployment state beyond Redis' script cache. |

The adapter loads scripts during `start()` and normally uses `EVALSHA`; it retries once with `EVAL` after `NOSCRIPT`.
The Redis server clock selects expiring writes' absolute deadline, avoiding application-host clock skew.

`message` values illustrate why the relationship is explicit: a value can be stored under `message.<message id>` while
its relationship is `message.<channel id>`. Relationship methods therefore return stored logical keys instead of
reconstructing them from the relationship field.

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

The value hash, relationship field, and reverse-lookup field receive the same absolute expiry in the atomic script.
Ordinary reads do not renew TTL. A successful write applies the configured policy; a failed encode, decode, or Redis
preflight does not refresh TTL. The adapter-local cache uses Redis' remaining `PTTL`, so it never intentionally outlives
the Redis key. It is process-local and does not receive cross-process invalidations. For data changed by multiple
processes, prefer node-redis client-side caching with RESP3 or keep `ondemand` disabled.

## Upgrade from the split-write layout

This is a breaking storage and adapter-contract change. Stop all old writers before upgrading; mixed old and new
processes can recreate split state.

- `RedisAdapter`: use a fresh `namespace`, or flush the adapter-owned cache namespace once before starting the new
  version. The relationship storage layout changed from sets to hashes with logical-key values and reverse lookups.
- `ExpirableRedisAdapter`: with writers stopped, set `migrateLegacyRelationships: true` in the second constructor
  argument for one startup. It migrates `.uset.*` sentinels and `:set` indexes, preserves each live value's remaining
  expiry, and creates the reverse lookup used for removal. If both possible legacy value keys exist for one relationship,
  migration fails before deleting its inputs because it cannot determine which value the relationship identifies. Disable
  the option after a successful startup.

Normal reads never scan the keyspace. Migration does scan the adapter namespace and is intentionally an offline
maintenance operation.

## Redis support and deployment shape

| Redis | Status | Reason |
| --- | --- | --- |
| 8.0 | Minimum, CI-covered | Introduces `HSETEX`, used for expiring relationship and reverse-lookup fields. |
| 8.x newer releases | Supported, locally exercised on 8.8 | Uses the same Redis 8 command and Lua surface. |
| 7.x and older | Unsupported | No `HSETEX`; an equivalent exact per-field TTL contract is unavailable. |
| Redis Cluster | Unsupported | One script touches value, relationship, and reverse-lookup keys. Arbitrary Seyfert keys cannot be guaranteed to share a cluster hash slot without changing the public key/lookup contract or pinning all cache data to one hot slot. |

Use standalone Redis or a topology that presents one writable Redis keyspace. The adapter accepts `RedisClientType`,
not `RedisClusterType`.

## Benchmark

Run a reproducible comparison against an otherwise idle Redis instance:

```sh
SLIPHER_REDIS_URL=redis://127.0.0.1:6379 pnpm --filter @slipher/redis-adapter bench:atomic
```

The benchmark reports median p50/p95 latency, median throughput with median absolute deviation, and deterministic
client/server command boundaries for single writes, patches, bulk writes, and TTL writes. It rotates implementation
order between samples and runs correctness checks outside the timed region. The split baselines reproduce the previous
adapter's commands; they do not provide the atomic adapter's ownership guarantees.

Use `BENCH_PAYLOAD=role` for a representative role with nested data and `BENCH_CONCURRENCY=8` for eight independent
lanes. Patch lanes use separate keys so completion order cannot change the expected final value. The default payload
is a small object and concurrency defaults to one. `BENCH_SAMPLES`, `BENCH_OPERATIONS`, `BENCH_BATCHES`, `BENCH_WARMUP`,
and `BENCH_BATCH_SIZE` tune the run; defaults are eight samples, 3,000 single operations, 300 batches, 300 warmup
operations, and 100 entries per batch. Atomic `bulkSet` uses one bounded script per 100-entry chunk.

To measure an optimization against another atomic implementation, build the reference checkout and pass its compiled
entry point. Both versions run in the same process against the same Redis instance with separate namespaces:

```sh
BENCH_COMPARE_MODULE=/absolute/path/to/reference/packages/redis-adapter/lib/index.js \
BENCH_PAYLOAD=role BENCH_CONCURRENCY=8 \
SLIPHER_REDIS_URL=redis://127.0.0.1:6379 pnpm --filter @slipher/redis-adapter bench:atomic
```

Comparison mode defaults to six samples to balance the three implementation positions. `vsReference` reports the
median of paired throughput changes plus MAD in percentage points; a positive value means higher throughput. These
are local microbenchmarks, not confidence intervals or production performance guarantees. Use the same Node and
node-redis versions for the reference and current builds.

Both adapters own clients they construct. Close the client during shutdown:

```ts
adapter.client.close();
```
