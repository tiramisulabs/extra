# @slipher/locks

Local lock manager for Slipher packages and bot tasks.

This package is an in-memory reference implementation for preventing duplicate work in a single process. It is useful for commands, schedulers, queues, and workers that should avoid running the same job twice at the same time.

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

Distributed locks should live in a separate adapter package after atomic semantics are designed. A Redis implementation should use atomic acquire, compare-and-delete release, and compare-and-expire extension.
