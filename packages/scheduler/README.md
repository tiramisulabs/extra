# @slipher/scheduler

Small task scheduler for Slipher and Seyfert projects.

Use it for cache cleanup, role syncs, metrics pushes, reminders, and other recurring bot tasks.

## Install

```sh
pnpm add @slipher/scheduler
```

## Intervals

```ts
import { Scheduler } from '@slipher/scheduler';

const scheduler = new Scheduler();

scheduler.every('5m', async () => {
	await cleanupExpiredState();
});
```

## Cron

```ts
scheduler.cron('0 */6 * * *', async () => {
	await syncGuilds();
});
```

`scheduler.cron` evaluates expressions in UTC. Write cron fields for the UTC time you want, not the host machine's local timezone.

## Events

```ts
scheduler.on('failed', (task, error) => {
	console.error(`Task ${task.id} failed`, error);
});

scheduler.on('skipped', task => {
	console.log(`Task ${task.id} is already running on another shard`);
});
```

## Control

```ts
const task = scheduler.every('1h', runReport, { id: 'report' });

scheduler.pause(task.id);
scheduler.start(task.id);
scheduler.remove(task.id);
```

## Shard-safe schedules

Pass a `LockManager` when the same scheduler task is registered by multiple Seyfert shards. If another holder owns the lock, the local run emits `skipped` and is rescheduled without calling the runner.

```ts
import { LockManager } from '@slipher/locks';
import { RedisLockStore } from '@slipher/locks/redis';
import { Scheduler } from '@slipher/scheduler';

const store = new RedisLockStore({
	redisOptions: { url: process.env.REDIS_URL },
	namespace: 'slipher:locks',
});
await store.start();

const locks = new LockManager({ store });
const scheduler = new Scheduler({
	lock: locks,
	lockOptions: { ttl: '30s' },
});

scheduler.every(
	'5m',
	async () => {
		await syncGuilds();
	},
	{
		id: 'sync-guilds',
		lockKey: 'scheduler:sync-guilds',
	},
);
```

`MemoryLockStore` only coordinates work inside one process. Use `RedisLockStore` for cross-process or cross-host shards.
