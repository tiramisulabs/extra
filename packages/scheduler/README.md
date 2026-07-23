# @slipher/scheduler

Cron and interval task scheduling for Seyfert bots — in the current process, or on BullMQ/Redis for cluster-wide schedules.

## How it works

You define tasks two ways — `@Cron`/`@Interval` decorated classes, or `registry.cron(...)` / `registry.interval(...)` calls. Each task has a stable `id`, runs on its schedule, and emits lifecycle events (`scheduled`, `started`, `completed`, `failed`, `skipped`, `paused`, `resumed`, `removed`).

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
import { Client, definePlugins } from 'seyfert';
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
	interface SeyfertRegistry {
		plugins: typeof plugins;
	}
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

When you use the registry without the Seyfert plugin, call `registry.setup()` after registering tasks. The `memory()` driver creates Croner jobs paused and resumes them during setup. With the plugin, driver resources are prepared during plugin setup so connection failures reject `client.start()`, then tasks activate from Seyfert's `plugins:ready` hook after every plugin has finished setup.

## Decorators

```ts
import { Cron, Interval, type ScheduledTask } from '@slipher/scheduler';

class Tasks {
	@Cron('0 9 * * *', {
		id: 'morning-report',
		overlap: 'skip',
		timezone: 'America/Santo_Domingo',
	})
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

Cron tasks accept a `timezone`:

```ts
registry.cron(
	'morning-report',
	'0 9 * * *',
	async () => {
		// run work
	},
	{ timezone: 'America/Santo_Domingo' },
);
```

`memory()` passes the timezone to Croner and `persistent()` passes it to BullMQ. Without this option, both drivers preserve their scheduling library's default timezone.

Tasks allow overlapping runs by default, preserving the existing behavior. With `memory()`, use `overlap: 'skip'` to omit a tick while the previous run is still pending:

```ts
registry.interval(
	'refresh-cache',
	'30s',
	async () => {
		// run work
	},
	{ overlap: 'skip' },
);
```

The persistent driver rejects `overlap: 'skip'`: BullMQ does not provide that per-task, cross-replica guarantee. Coordinate inside the task when using `persistent()`. Task failures still emit `failed`; the memory driver settles the rejected Croner callback after that event so it does not become an unhandled rejection.

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
import { Client, definePlugins } from 'seyfert';
import { persistent, scheduler } from '@slipher/scheduler';

const schedulerPlugin = scheduler({
	driver: persistent({
		connection: { host: '127.0.0.1', port: 6379 },
	}),
	tasks: [MaintenanceTasks],
});
const plugins = definePlugins(schedulerPlugin);

declare module 'seyfert' {
	interface SeyfertRegistry {
		plugins: typeof plugins;
	}
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
await registry.removeOrphan('old-task-id');
```

On startup, the persistent driver compares Redis job schedulers against registered tasks. Orphans are warned by default. After startup, remove a specific orphan with `removeOrphan(id)`, or use `persistent({ purgeOrphansOnStartup: true })` to remove all detected orphans during setup. `remove(id)` remains for tasks that are still registered in the current registry.

`pause(id)` removes the BullMQ job scheduler. `resume(id)` re-creates it with the captured template and emits `resumed`. `start(id)` remains as a compatibility alias for `resume(id)`.

`runImmediately: true` runs the task once when the scheduler activates, then on its normal schedule. Persistent drivers deduplicate immediate jobs across replicas that start within the same 60-second window. Configure `immediateRunDeduplicationMs` when a deployment wave needs a different window:

```ts
persistent({
	connection,
	immediateRunDeduplicationMs: 30_000,
});
```

A restart inside that positive-integer window belongs to the same wave and does not enqueue another immediate run. A restart after the window expires starts a new wave.

## Events

```ts
registry.on('completed', ({ task, result }) => {
	void task.id;
	void result;
});

registry.on('skipped', ({ task, reason }) => {
	if (reason === 'overlap') {
		void task.id;
	}
});
```

Supported events: `scheduled`, `started`, `completed`, `failed`, `skipped`, `paused`, `resumed`, `removed`, and `error`. A memory task configured with `overlap: 'skip'` emits `skipped` with `{ task, reason: 'overlap' }` without incrementing its run count. Persistent BullMQ resources emit `error` with `{ source, error }`, where `source` is `queue`, `queue-events`, or `worker`; these transport errors are also sent to the configured logger.

With `memory()`, events are in-process. With `persistent()`, the worker emits lifecycle events immediately in the replica running the task, while BullMQ `QueueEvents` mirrors the same outcome to the other replicas without duplicating it locally. `QueueEvents` uses one extra Redis connection per scheduler queue per replica.

Listener errors are isolated and reported through the configured logger.
