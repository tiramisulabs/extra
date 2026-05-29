# @slipher/queues

In-memory job queues for Slipher and Seyfert projects.

Use it for reminders, expensive background work, retries, rate-controlled syncs, and other bot tasks that should not run directly inside command handlers.

## Install

```sh
pnpm add @slipher/queues
```

## Basic usage

```ts
import { Queue } from '@slipher/queues';

const reminders = new Queue<{ userId: string; message: string }>('reminders', {
	concurrency: 5,
	attempts: 3,
	retryDelay: '5s',
});

reminders.process(async job => {
	await sendReminder(job.data.userId, job.data.message);
});

reminders.add({ userId: '123', message: 'Time to ship!' }, { delay: '10m' });
```

## Events

```ts
reminders.on('completed', job => {
	console.log(`Completed ${job.id}`);
});

reminders.on('failed', (job, error) => {
	console.error(`Failed ${job.id}`, error);
});
```

## Inspecting queue state

```ts
console.log(reminders.counts());
console.log(reminders.getJob('1')?.snapshot());
```
