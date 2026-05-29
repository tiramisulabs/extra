# @slipher/queues

In-memory job queues for Slipher and Seyfert projects.

Use it for reminders, expensive background work, retries, rate-controlled syncs, and other bot tasks that should not run directly inside command handlers.

## Install

```sh
pnpm add @slipher/queues
```

## Basic usage

```ts
import { Queue } from '@slipher/queues';

const reminders = new Queue<{ userId: string; message: string }>('reminders', {
	concurrency: 5,
	attempts: 3,
	retryDelay: '5s',
});

reminders.process(async job => {
	await sendReminder(job.data.userId, job.data.message);
});

reminders.add({ userId: '123', message: 'Time to ship!' }, { delay: '10m' });
```

## Events

```ts
reminders.on('completed', job => {
	console.log(`Completed ${job.id}`);
});

reminders.on('failed', (job, error) => {
	console.error(`Failed ${job.id}`, error);
});
```

## Inspecting queue state

```ts
console.log(reminders.counts());
console.log(reminders.getJob('1')?.snapshot());
```

## Shard-safe processing

Pass a `LockManager` when multiple Seyfert shards may enqueue equivalent work and only one processor should run at a time.

```ts
import { LockManager, RedisLockStore } from '@slipher/locks';
import { Queue } from '@slipher/queues';

const store = new RedisLockStore({
	redisOptions: { url: process.env.REDIS_URL },
	namespace: 'slipher:locks',
});
await store.start();

const locks = new LockManager({ store });
const syncs = new Queue<{ guildId: string }>('syncs', {
	lock: locks,
	lockKey: job => `guild:${job.data.guildId}:sync`,
	lockOptions: { ttl: '30s', wait: '5s' },
});

syncs.process(async job => {
	await syncGuild(job.data.guildId);
});
```

`MemoryLockStore` only coordinates work inside one process. Use `RedisLockStore` for cross-process or cross-host shards.
