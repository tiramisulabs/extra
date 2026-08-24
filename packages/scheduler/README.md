# @slipher/scheduler

Cron and interval scheduling for Seyfert, in the current process or on BullMQ/Redis.

**[Read the complete Scheduler guide on seyfert.dev](https://seyfert.dev/docs/plugins/official/scheduler).**

## Install

```sh
pnpm add @slipher/scheduler
```

Requires Seyfert v5. The persistent driver additionally requires `bullmq@^5.23.0 || ^6.0.0`.

## Quick start

```ts
import { Interval, memory, scheduler, type ScheduledTask } from '@slipher/scheduler';
import { Client, definePlugins, type UsingClient } from 'seyfert';

class MaintenanceTasks {
	@Interval('5m', { id: 'heartbeat' })
	heartbeat(task: ScheduledTask, client: UsingClient) {
		client.logger.debug(`Running ${task.id}`);
	}
}

const plugins = definePlugins(
	scheduler({
		driver: memory(),
		tasks: [MaintenanceTasks],
	}),
);

declare module 'seyfert' {
	interface SeyfertRegistry {
		plugins: typeof plugins;
	}
}

export const client = new Client({ plugins });
```

Persistent tasks need explicit, stable IDs. Removing one from code does not remove its Redis scheduler; follow the canonical cleanup guide when renaming or deleting tasks.
