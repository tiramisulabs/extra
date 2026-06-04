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

Pick the driver explicitly:

```ts
import { Client } from 'seyfert';
import { Interval, memory, scheduler } from '@slipher/scheduler';

class MaintenanceTasks {
	@Interval('5m', { id: 'heartbeat' })
	heartbeat() {
		// run work
	}
}

const schedulerPlugin = scheduler({
	driver: memory(),
	tasks: [MaintenanceTasks],
});

export const registry = schedulerPlugin.registry;
export const client = new Client({
	plugins: [schedulerPlugin],
});
```

The plugin exposes `ctx.scheduler` and `client.scheduler`.

```ts
import { Command, Declare, type CommandContext } from 'seyfert';

@Declare({
	name: 'refresh-cache',
	description: 'Schedule a cache refresh',
})
export default class RefreshCacheCommand extends Command {
	async run(ctx: CommandContext) {
		ctx.scheduler.interval('refresh-cache', '30s', async task => {
			void task.id;
		});

		await ctx.write({ content: 'Cache refresh scheduled.' });
	}
}
```

## Accessing The Plugin Without `ctx`

| Where | How |
| --- | --- |
| Command, component, modal | `ctx.scheduler` |
| Event | `entity.client.scheduler` |
| Anywhere with the client at hand | `client.scheduler` |
| Code with no client | capture the plugin `registry` |

```ts
// index.ts
const schedulerPlugin = scheduler({ driver: memory(), tasks: [MaintenanceTasks] });
export const registry = schedulerPlugin.registry;
export const client = new Client({ plugins: [schedulerPlugin] });

// services/reports.ts
import { registry } from '../index';

export function pauseReports() {
	return registry.pause('morning-report');
}
```

Avoid importing the exported `client` from task modules loaded by `index.ts`; that creates a circular import. Capturing the registry at composition time avoids it. The invariant is `ctx.scheduler === client.scheduler === schedulerPlugin.registry`.

## Programmatic Usage

```ts
import { createScheduler, memory } from '@slipher/scheduler';

const registry = createScheduler({ driver: memory() });

registry.cron('daily-cleanup', '0 0 * * *', async () => {
	// run work
});

registry.add('poller', '10s', async task => {
	void task.runCount;
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

When using `persistent()`, every decorated task must provide an explicit non-empty `id`. Method names are allowed as defaults with `memory()`, but persistent task ids are Redis scheduler ids. Renaming a method without a stable `id` creates a new schedule and leaves the old Redis schedule orphaned.

## Drivers

`memory()` uses Croner in the current process. It is ideal for local workers and single-process jobs.

`memory()` intervals tick at 1-second resolution. Values below or between whole seconds, such as `'500ms'` or `'1.5s'`, pass duration parsing but Croner rounds them to the next whole-second tick. If you need sub-second precision, use a different scheduling mechanism.

`persistent()` uses BullMQ job schedulers so repeated jobs are coordinated outside a single process:

```ts
import { createScheduler, persistent } from '@slipher/scheduler';

const registry = createScheduler({
	driver: persistent({
		connection: { host: '127.0.0.1', port: 6379 },
		queueName: 'scheduler',
		prefix: 'slipher',
	}),
});
```

Persistent schedules open BullMQ `Queue`, `Worker`, and `QueueEvents` during plugin `setup()`, not module load. `schedulerPlugin.teardown()` or `registry.close()` closes worker, queue-events, and queue resources. Until your Seyfert version includes plugin teardown, wire your process signals manually:

```ts
process.on('SIGTERM', () => {
	void registry.close().then(() => process.exit(0));
});
```

### Persistent Cleanup

Removing a persistent task from code is not enough. The Redis schedule keeps firing until it is removed:

```ts
await registry.remove('old-task-id');
```

On startup, the persistent driver compares Redis job schedulers against registered tasks. Orphans are warned by default. Use `persistent({ purgeOrphansOnStartup: true })` to remove them during setup.

`pause(id)` removes the BullMQ job scheduler. `start(id)` re-creates it with the captured template.

`runImmediately: true` enqueues one immediate job during setup with a deterministic job id: `${taskId}:immediate:${schedulerVersion}`. That deduplicates the immediate run across replicas in the same process-start wave and runs again on the next start, matching memory-driver behavior.

## Events

```ts
registry.on('completed', ({ task, result }) => {
	void task.id;
	void result;
});
```

Supported events: `scheduled`, `started`, `completed`, `failed`, `paused`, `resumed`, and `removed`.

With `memory()`, events are in-process. With `persistent()`, `started`, `completed`, and `failed` come from BullMQ `QueueEvents`, so every replica listening on the registry sees the cluster-level task outcome. `QueueEvents` uses one extra Redis connection per scheduler queue per replica.

Listener errors are isolated and reported through the configured logger.

## Implementation Notes

- `add()` treats duration strings as intervals and cron strings as cron expressions.
- `ScheduledTask.snapshot()` returns state for health checks or dashboards.
- The memory driver stores Croner jobs in-process.
- The persistent driver maps tasks into BullMQ job schedulers.

## Development

```sh
pnpm --filter @slipher/scheduler test
pnpm --filter @slipher/scheduler build
```
