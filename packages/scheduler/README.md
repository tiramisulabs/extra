# @slipher/scheduler

Task scheduling helpers for Seyfert projects.

## Install

```sh
pnpm add @slipher/scheduler
```

Install BullMQ only when you need persistent, cluster-aware schedules:

```sh
pnpm add bullmq
```

## Seyfert Plugin

```ts
import { Client } from 'seyfert';
import { Interval, scheduler, memory } from '@slipher/scheduler';

class MaintenanceTasks {
	@Interval('5m', { id: 'heartbeat' })
	heartbeat() {
		// run work
	}
}

const client = new Client({
	plugins: [
		scheduler({
			driver: memory(),
			tasks: [MaintenanceTasks],
		}),
	],
});
```

The plugin exposes `ctx.scheduler` and `client.scheduler`.

```ts
ctx.scheduler.interval('refresh-cache', '30s', async task => {
	void task.id;
});
```

## Programmatic Usage

```ts
import { createScheduler, memory } from '@slipher/scheduler';

const scheduler = createScheduler({ driver: memory() });

scheduler.cron('daily-cleanup', '0 0 * * *', async () => {
	// run work
});

scheduler.add('poller', '10s', async task => {
	console.log(task.runCount);
});
```

## Decorators

```ts
import { Cron, Interval, type ScheduledTask } from '@slipher/scheduler';

class Tasks {
	@Cron('0 9 * * *', { id: 'morning-report' })
	report(task: ScheduledTask) {
		return task.id;
	}

	@Interval('1h', { id: 'heartbeat', runImmediately: true })
	heartbeat() {}
}
```

## Drivers

`memory()` uses Croner in the current process. It is ideal for local workers and single-process jobs.

`persistent()` uses BullMQ job schedulers so repeated jobs are coordinated outside a single process:

```ts
import { createScheduler, persistent } from '@slipher/scheduler';

const scheduler = createScheduler({
	driver: persistent({
		connection: { host: '127.0.0.1', port: 6379 },
		queueName: 'scheduler',
		prefix: 'slipher',
	}),
});
```

## Events

```ts
scheduler.on('completed', ({ task, result }) => {
	console.log(task.id, result);
});
```

Supported events: `scheduled`, `started`, `completed`, `failed`, `paused`, `resumed`, and `removed`.

## Implementation Notes

- `add()` treats duration strings as intervals and cron strings as cron expressions.
- `ScheduledTask.snapshot()` returns state for health checks or dashboards.
- The memory driver stores Croner jobs in-process.
- The persistent driver maps tasks into BullMQ repeatable job schedulers.

## Development

```sh
pnpm --filter @slipher/scheduler test
pnpm --filter @slipher/scheduler build
```
