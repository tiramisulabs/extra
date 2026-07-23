# @slipher/scheduler

Cron and interval scheduling for Seyfert, in the current process or on BullMQ/Redis.

**[Read the complete Scheduler guide on seyfert.dev](https://seyfert.dev/docs/plugins/official/scheduler).**

## Install

```sh
pnpm add @slipher/scheduler
```

Requires Seyfert v5. The persistent driver additionally requires `bullmq@^5.23.0`.

## Quick start

```ts
import { Interval, memory, scheduler } from '@slipher/scheduler';
import { Client, definePlugins } from 'seyfert';

class MaintenanceTasks {
	@Interval('5m', { id: 'heartbeat' })
	heartbeat() {
		// run work
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
