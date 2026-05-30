# @slipher/queues

Typed job queues for Seyfert bots. The package gives you a Seyfert plugin, a registry on `ctx.queues` and `client.queues`, in-memory and BullMQ-backed drivers, decorators for processors, lifecycle events, retries, delays, priorities, and concurrency controls.

## Install

```sh
pnpm add @slipher/queues
```

Install BullMQ only when you want Redis-backed persistent queues:

```sh
pnpm add bullmq
```

## Use With Seyfert

Register the plugin with a driver and the processors that should run in this process:

```ts
import { Client } from 'seyfert';
import {
	OnQueueEvent,
	Process,
	Processor,
	type QueueJob,
	queues,
	memory,
} from '@slipher/queues';

interface WelcomeJob {
	source: 'slash-command' | 'scheduler';
	userId: string;
}

@Processor('welcome')
class WelcomeProcessor {
	@Process('send')
	async send(job: QueueJob<WelcomeJob, string>) {
		await sendWelcomeMessage(job.data.userId);
		return `welcome:${job.data.userId}`;
	}

	@OnQueueEvent('completed')
	onCompleted(job: QueueJob<WelcomeJob, string>, result: string) {
		job.snapshot();
		console.info('welcome job completed', { jobId: job.id, result });
	}
}

const client = new Client({
	plugins: [
		queues({
			driver: memory({
				attempts: 3,
				retryDelay: '5s',
				concurrency: 4,
			}),
			processors: [WelcomeProcessor],
		}),
	],
});
```

The plugin exposes the same registry on every interaction context and on the client:

```ts
import { Command, Declare } from 'seyfert';
import type { QueuesRegistry } from '@slipher/queues';

@Declare({
	name: 'welcome',
	description: 'Queue a welcome message',
})
export default class WelcomeCommand extends Command {
	async run(ctx: {
		author: { id: string };
		queues: QueuesRegistry;
		write(response: { content: string }): Promise<unknown>;
	}) {
		await ctx.queues.add<WelcomeJob, string>(
			'welcome',
			{ source: 'slash-command', userId: ctx.author.id },
			{
				name: 'send',
				delay: '10s',
				priority: 10,
			},
		);

		await ctx.write({ content: 'Welcome job queued.' });
	}
}
```

That lets command code stay small: it only decides what should happen, while the processor owns the actual work, retries, and observability hooks.

## Inject Queues Into Producers

If you prefer a service-style producer, use `@InjectQueue()` and register the producer with the plugin:

```ts
import { InjectQueue, type Queue } from '@slipher/queues';

class WelcomeProducer {
	constructor(@InjectQueue('welcome') readonly welcome: Queue<WelcomeJob, string>) {}

	send(userId: string) {
		return this.welcome.add({ source: 'slash-command', userId }, { name: 'send' });
	}
}

queues({
	driver: memory(),
	processors: [WelcomeProcessor],
	producers: [WelcomeProducer],
});
```

Retrieve the producer from `ctx.queues` or `client.queues`:

```ts
const producer = ctx.queues.getProducer(WelcomeProducer);
await producer?.send(ctx.author.id);
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
import { queues, persistent } from '@slipher/queues';

export default queues({
	driver: persistent({
		connection: { host: '127.0.0.1', port: 6379 },
		prefix: 'slipher',
	}),
	processors: [WelcomeProcessor],
});
```

Persistent queues map Slipher job options into BullMQ queue and worker options, so the same command and processor code can move from `memory()` to BullMQ when the deployment grows.

## Outside Seyfert

The registry also works without a Seyfert client for scripts, tests, and workers:

```ts
import { createQueues, memory } from '@slipher/queues';

const registry = createQueues({ driver: memory() });
const welcome = registry.get<WelcomeJob, string>('welcome');

welcome.process(job => `hello:${job.data.userId}`);

await welcome.add({ source: 'slash-command', userId: '123' }, { name: 'send' });
await registry.close();
```

## Development

```sh
pnpm --filter @slipher/queues test
pnpm --filter @slipher/queues build
```
