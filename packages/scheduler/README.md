# @slipher/scheduler

Cron and interval task scheduling for Seyfert bots — in the current process, or on BullMQ/Redis for cluster-wide schedules.

## How it works

You define tasks two ways — `@Cron`/`@Interval` decorated classes, or `registry.cron(...)` / `registry.interval(...)` calls. Each task has a stable `id`, runs on its schedule, and emits lifecycle events (`scheduled`, `started`, `completed`, `failed`, `paused`, `resumed`, `removed`).

A **driver** decides where schedules live: `memory()` runs them in the current process; `persistent()` runs them on BullMQ/Redis so they survive restarts and coordinate across replicas — same task code either way.

Everything flows through one **registry**, exposed as `ctx.scheduler`, `client.scheduler`, and the plugin's `registry` (the same object).

## Install

```sh
pnpm add @slipher/scheduler
```

Requires Seyfert v5. Install BullMQ only when you need persistent, cluster-aware schedules. The persistent driver uses BullMQ job schedulers, so it requires BullMQ `^5.23.0` or newer:

```sh
pnpm add bullmq@^5.23.0
```

## Seyfert Plugin

Pick the driver explicitly:

```ts
import { Client, definePlugins, type RegisterPlugins } from 'seyfert';
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
const plugins = definePlugins(schedulerPlugin);

declare module 'seyfert' {
	interface Register extends RegisterPlugins<typeof plugins> {}
}

export const registry = schedulerPlugin.registry;
export const client = new Client({
	plugins,
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
const plugins = definePlugins(schedulerPlugin);
export const registry = schedulerPlugin.registry;
export const client = new Client({ plugins });

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

await registry.setup();
```

When you use the registry without the Seyfert plugin, call `registry.setup()` after registering tasks. The `memory()` driver creates Croner jobs paused and resumes them during setup; the plugin does this for you when the client starts.

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

`memory()` uses Croner in the current process. It is ideal for local workers and single-process jobs. Jobs are paused until setup so tasks cannot fire before the Seyfert client/plugin lifecycle is ready.

`memory()` intervals tick at 1-second resolution. Values below or between whole seconds, such as `'500ms'` or `'1.5s'`, pass duration parsing but Croner rounds them to the next whole-second tick. If you need sub-second precision, use a different scheduling mechanism.

Cron timezone follows the selected driver. `memory()` delegates cron evaluation to Croner with its default runtime timezone. `persistent()` delegates repeated cron scheduling to BullMQ with no Slipher timezone override. If timezone matters, run workers with an explicit process timezone such as `TZ=UTC` and write cron expressions for that timezone; a first-class scheduler timezone option can be added later without changing task definitions.

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

For a Seyfert bot, create the plugin, register it on the client, and start the client so plugin setup opens Redis/BullMQ resources:

```ts
import { Client, definePlugins, type RegisterPlugins } from 'seyfert';
import { persistent, scheduler } from '@slipher/scheduler';

const schedulerPlugin = scheduler({
	driver: persistent({
		connection: { host: '127.0.0.1', port: 6379 },
	}),
	tasks: [MaintenanceTasks],
});
const plugins = definePlugins(schedulerPlugin);

declare module 'seyfert' {
	interface Register extends RegisterPlugins<typeof plugins> {}
}

const client = new Client({
	plugins,
});

await client.start();
```

`client.close()` tears the schedules down and releases the Redis/BullMQ resources; wire it to your process signals:

```ts
process.on('SIGTERM', () => {
	void client.close().then(() => process.exit(0));
});
```

### Persistent Cleanup

Removing a persistent task from code is not enough. The Redis schedule keeps firing until it is removed:

```ts
await registry.remove('old-task-id');
```

On startup, the persistent driver compares Redis job schedulers against registered tasks. Orphans are warned by default. Use `persistent({ purgeOrphansOnStartup: true })` to remove them during setup.

`pause(id)` removes the BullMQ job scheduler. `resume(id)` re-creates it with the captured template and emits `resumed`. `start(id)` remains as a compatibility alias for `resume(id)`.

`runImmediately: true` runs the task once at setup (deduplicated across replicas in the same start wave), then on its normal schedule.

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
