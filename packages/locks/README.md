# @slipher/locks

Lock manager for Slipher packages and bot tasks.

Use it for commands, schedulers, queues, and workers that should avoid running the same job twice at the same time.

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

`RedisLockStore` coordinates locks across processes that share the same Redis instance.

```ts
import { LockManager, RedisLockStore } from '@slipher/locks';

const store = new RedisLockStore({
	redisOptions: { url: process.env.REDIS_URL },
	namespace: 'slipher:locks',
});

await store.start();

const locks = new LockManager({ store });
```

Redis lock acquisition uses atomic `SET key token NX PX ttl`. Release and extend use Lua scripts that compare the owner token before deleting or extending the key.
