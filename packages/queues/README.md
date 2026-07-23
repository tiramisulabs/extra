# @slipher/queues

Typed background job queues for Seyfert, backed by the current process or BullMQ/Redis.

**[Read the complete Queues guide on seyfert.dev](https://seyfert.dev/docs/plugins/official/queues).**

## Install

```sh
pnpm add @slipher/queues
```

Requires Seyfert v5. Install `bullmq` only when using the persistent driver.

## Quick start

```ts
import { memory, Process, Processor, queues, type QueueJobOf, type QueueRegistration } from '@slipher/queues';
import { Client, definePlugins } from 'seyfert';

declare module '@slipher/queues' {
	interface RegisteredQueues {
		email: QueueRegistration<{ userId: string }>;
	}
}

@Processor('email')
class EmailProcessor {
	@Process()
	send(job: QueueJobOf<'email'>) {
		return sendWelcomeEmail(job.data.userId);
	}
}

const plugins = definePlugins(queues({ driver: memory(), processors: [EmailProcessor] }));

declare module 'seyfert' {
	interface SeyfertRegistry {
		plugins: typeof plugins;
	}
}

export const client = new Client({ plugins });
```

`memory()` is process-local and does not survive restarts. Use `persistent()` with BullMQ/Redis when jobs must be durable or shared across workers.
