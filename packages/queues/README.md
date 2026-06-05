# @slipher/queues

Typed job queues for Seyfert bots. The package gives you a Seyfert plugin, a registry on `ctx.queues` and `client.queues`, in-memory and BullMQ-backed drivers, processors, worker/queue events, retries, delays, priorities, and concurrency controls.

## Install

```sh
pnpm add @slipher/queues
```

Install BullMQ only when you want Redis-backed persistent queues:

```sh
pnpm add bullmq
```

## Use With Seyfert

Declare queues with `RegisteredQueues`. Named jobs use a `job` discriminant; that field is type-only and becomes BullMQ's native job name.

```ts
import { Client } from 'seyfert';
import {
	OnQueueEvent,
	OnWorkerEvent,
	Process,
	Processor,
	type QueueJobOf,
	type QueueRegistration,
	memory,
	queues,
} from '@slipher/queues';

type AudioJob =
	| { job: 'transcode'; fileId: string; format: 'mp3' | 'ogg' }
	| { job: 'concatenate'; fileIds: string[] };

declare module '@slipher/queues' {
	interface RegisteredQueues {
		audio: QueueRegistration<AudioJob, string>;
	}
}

@Processor('audio')
class AudioProcessor {
	@Process()
	async handle(job: QueueJobOf<'audio'>) {
		switch (job.name) {
			case 'transcode':
				return transcode(job.data.fileId, job.data.format);
			case 'concatenate':
				return concatenate(job.data.fileIds);
		}
	}

	@OnWorkerEvent('active')
	onActive(job: QueueJobOf<'audio'>) {
		job.snapshot();
	}

	@OnQueueEvent('completed')
	onCompleted(job: QueueJobOf<'audio'>, result: string) {
		job.snapshot();
		void result;
	}
}

const queuesPlugin = queues({
	driver: memory({
		attempts: 3,
		retryDelay: '5s',
		concurrency: 4,
	}),
	processors: [AudioProcessor],
});

export const registry = queuesPlugin.registry;
export const client = new Client({
	plugins: [queuesPlugin],
});
```

Produce jobs with the queue name, job name, and payload:

```ts
await ctx.queues.add('audio', 'transcode', {
	fileId: 'file-1',
	format: 'mp3',
});

await ctx.queues.get('audio').add('concatenate', {
	fileIds: ['a', 'b'],
});
```

Simple queues do not declare a `job` discriminant and use `add(data, options)`:

```ts
declare module '@slipher/queues' {
	interface RegisteredQueues {
		welcome: QueueRegistration<{ userId: string }>;
	}
}

await ctx.queues.add('welcome', { userId: ctx.author.id });
```

Each `@Processor()` class has exactly one `@Process()` handler. Switch on `job.name` for named-job queues. There is no framework-level per-name dispatch, so typos are caught by the typed producer surface instead of becoming `"Queue process not found"` retries at runtime.

## Accessing The Plugin Without `ctx`

| Where | How |
| --- | --- |
| Command, component, modal | `ctx.queues` |
| Event | `entity.client.queues` |
| Anywhere with the client at hand | `client.queues` |
| Code with no client | capture the plugin `registry` |

```ts
// index.ts
const queuesPlugin = queues({ driver: memory(), processors: [AudioProcessor] });
export const registry = queuesPlugin.registry;
export const client = new Client({ plugins: [queuesPlugin] });

// services/media.ts
import { registry } from '../index';

export function scheduleTranscode(fileId: string) {
	return registry.get('audio').add('transcode', { fileId, format: 'mp3' });
}
```

Avoid importing the exported `client` from processors or services that are loaded by `index.ts`; that creates a circular import. Capturing the registry at composition time keeps the service independent. The invariant is `ctx.queues === client.queues === queuesPlugin.registry`.

## Events

`@OnWorkerEvent(event)` is local to the process that ran the job. Use it for local cache updates or process-local instrumentation.

`@OnQueueEvent(event)` is the queue/global channel. With `memory()` both decorators observe the same single-process queue. With `persistent()`, queue-level events are prepared for BullMQ `QueueEvents` and use one extra Redis connection per queue per replica.

Listener errors are isolated. Throwing inside an event handler is reported through `reportListenerError` and never changes job state, retry counts, or whether later listeners run.

```ts
queues({
	driver: memory({
		reportListenerError(event, error) {
			logger.error('queue listener failed', { event, error });
		},
	}),
});
```

## Drivers

`memory()` runs jobs in the current process and supports:

- `delay`
- `attempts`
- `retryDelay`
- `priority`
- `concurrency`
- lifecycle events: `added`, `active`, `completed`, `failed`, `retrying`, and `idle`

Use `persistent()` when jobs need to survive restarts or be shared across workers:

```ts
import { persistent, queues } from '@slipher/queues';

export default queues({
	driver: persistent({
		connection: { host: '127.0.0.1', port: 6379 },
		prefix: 'slipher',
		queueOptions: {
			settings: {
				stalledInterval: 30_000,
			},
		},
		defaultJobOptions: {
			removeOnComplete: true,
			attempts: 3,
		},
	}),
	processors: [AudioProcessor],
});
```

`queueOptions` goes to BullMQ's `new Queue(name, options)` layer. `defaultJobOptions` goes to BullMQ's per-job defaults and is also merged into explicit `add()` options.

Static `retryDelay` values map to BullMQ `backoff: { type: 'fixed', delay }`. BullMQ backoff objects pass through. Function-form `retryDelay` is memory-only; the persistent driver rejects it during setup or at the `add()` call site because BullMQ owns retry timing.

Persistent queues open BullMQ `Queue`, `Worker`, and `QueueEvents` during plugin `setup()`, not module load. `client.close()` runs `queuesPlugin.teardown()` and closes worker, queue-events, and queue resources. Outside Seyfert, call `registry.close()` directly. Wire process signals to close whichever lifecycle owner you use:

```ts
process.on('SIGTERM', () => {
	void client.close().then(() => process.exit(0));
});
```

## Outside Seyfert

The registry also works without a Seyfert client for scripts, tests, and workers:

```ts
import { createQueues, memory } from '@slipher/queues';

const registry = createQueues({ driver: memory() });
const audio = registry.get('audio');

audio.process(job => `processed:${job.name}`);

await audio.add('transcode', { fileId: 'file-1', format: 'mp3' });
await registry.close();
```

## Development

```sh
pnpm --filter @slipher/queues test
pnpm --filter @slipher/queues build
```
