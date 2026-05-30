# @slipher/queues

Queue registry, memory driver, BullMQ driver, decorators, and Seyfert context plugin.

## Install

```sh
pnpm add @slipher/queues
```

Install BullMQ only when you need persistent queues:

```sh
pnpm add bullmq
```

## Basic Usage

```ts
import { createQueues, memory } from '@slipher/queues';

const queues = createQueues({ driver: memory() });
const welcome = queues.get<{ userId: string }, string>('welcome');

welcome.process(job => {
	return `hello:${job.data.userId}`;
});

await welcome.add({ userId: '123' }, { name: 'greet', priority: 10 });
```

## Seyfert Plugin

```ts
import { Client } from 'seyfert';
import { queues, memory } from '@slipher/queues';

const client = new Client({
	plugins: [
		queues({
			driver: memory({ attempts: 3, retryDelay: '5s' }),
		}),
	],
});
```

The plugin exposes `ctx.queues` and `client.queues`.

```ts
await ctx.queues.add('welcome', { userId: ctx.author.id }, { name: 'greet' });
```

## Decorators

```ts
import { InjectQueue, Process, Processor, type Queue, type QueueJob } from '@slipher/queues';

@Processor('welcome')
class WelcomeProcessor {
	@Process('greet')
	greet(job: QueueJob<{ userId: string }, string>) {
		return `hello:${job.data.userId}`;
	}
}

class WelcomeProducer {
	constructor(@InjectQueue('welcome') readonly welcome: Queue<{ userId: string }>) {}
}
```

Register processors and producers through `createQueues()` or the plugin:

```ts
queues({
	driver: memory(),
	processors: [WelcomeProcessor],
	producers: [WelcomeProducer],
});
```

## Drivers

`memory()` runs jobs in the current process. It supports:

- `delay`
- `attempts`
- `retryDelay`
- `priority`
- `concurrency`
- lifecycle events

`persistent()` delegates to BullMQ:

```ts
import { createQueues, persistent } from '@slipher/queues';

const queues = createQueues({
	driver: persistent({
		connection: { host: '127.0.0.1', port: 6379 },
		prefix: 'slipher',
	}),
});
```

## Implementation Notes

- The registry fingerprints queue options so a queue name cannot be reused with incompatible options.
- Memory jobs emit `added`, `active`, `completed`, `failed`, `retrying`, and `idle`.
- Delayed jobs are scheduled by run time; ready jobs are processed by priority and insertion order.
- Persistent queues map Slipher job options into BullMQ queue and worker options.

## Development

```sh
pnpm --filter @slipher/queues test
pnpm --filter @slipher/queues build
```
