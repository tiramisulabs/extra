# @slipher/scheduler

Task scheduling helpers for Seyfert projects.

## Install

```sh
pnpm add @slipher/scheduler
```

Use BullMQ only when you need persistent, cluster-aware schedules:

```sh
pnpm add bullmq
```

## Usage

```ts
import { Interval, scheduler, memory } from '@slipher/scheduler';

class MaintenanceTasks {
	@Interval('5m', { id: 'heartbeat' })
	heartbeat() {
		// run work
	}
}

export default scheduler({
	driver: memory(),
	tasks: [MaintenanceTasks],
});
```

The plugin exposes the registry as `ctx.scheduler`.

```ts
ctx.scheduler.interval('refresh-cache', '30s', async task => {
	void task.id;
});
```

## Drivers

`memory()` uses Croner in the current process. It is ideal for local workers and single-process jobs.

```ts
import { createScheduler, memory } from '@slipher/scheduler';

const registry = createScheduler({ driver: memory() });
registry.cron('daily-cleanup', '0 0 * * *', async () => {
	// run work
});
```

`persistent()` uses BullMQ job schedulers so repeated jobs are coordinated outside a single process.

```ts
import { createScheduler, persistent } from '@slipher/scheduler';

const registry = createScheduler({
	driver: persistent({
		connection: { host: '127.0.0.1', port: 6379 },
		queueName: 'scheduler',
	}),
});
```
