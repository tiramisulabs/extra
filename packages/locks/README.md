# @slipher/locks

Lock manager for Slipher packages and bot tasks.

Use it for commands, schedulers, queues, and workers that should avoid running the same job twice at the same time.

Status: beta/draft. The package is usable, but public API details may change before a stable release.

## Install

```sh
pnpm add @slipher/locks
```

## Usage

```ts
import { LockManager } from '@slipher/locks';

const locks = new LockManager();

await locks.withLock(`guild:${guildId}:sync`, async () => {
	await syncGuild(guildId);
});
```

## Lower-level API

```ts
const lock = await locks.acquire('jobs:daily-report', {
	ttl: '30s',
	wait: '5s',
	retryInterval: '100ms',
});

try {
	await runReport();
} finally {
	await locks.release(lock);
}
```

## Abort waiting acquisition

```ts
const controller = new AbortController();

await locks.acquire('jobs:daily-report', {
	ttl: '30s',
	wait: '5s',
	signal: controller.signal,
});
```

## Extending locks

```ts
const lock = await locks.acquire('guild:123:sync', { ttl: '30s' });

await locks.extend(lock, '30s');
await locks.release(lock);
```

## Stores

`MemoryLockStore` is local-process only. It uses owner tokens to prevent one caller from releasing or extending another caller's lock.

`RedisLockStore` coordinates locks across processes that share the same Redis instance. Redis support is exposed from the `@slipher/locks/redis` subpath so the default package entry stays dependency-light.

```ts
import { LockManager } from '@slipher/locks';
import { RedisLockStore } from '@slipher/locks/redis';

const store = new RedisLockStore({
	redisOptions: { url: process.env.REDIS_URL },
	namespace: 'slipher:locks',
});

await store.start();

const locks = new LockManager({ store });
```

Redis lock acquisition uses atomic `SET key token NX PX ttl`. Release and extend use Lua scripts that compare the owner token before deleting or extending the key.

Distributed locks depend on TTLs and Redis availability. They prevent duplicate best-effort execution, but they are not fencing tokens and cannot make side effects exactly-once by themselves.
