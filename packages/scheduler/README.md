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

## Events

```ts
scheduler.on('failed', (task, error) => {
	console.error(`Task ${task.id} failed`, error);
});
```

## Control

```ts
const task = scheduler.every('1h', runReport, { id: 'report' });

scheduler.pause(task.id);
scheduler.start(task.id);
scheduler.remove(task.id);
```
