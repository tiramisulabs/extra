# @slipher/queues

Seyfert-first job queues for Discord work that should not run directly inside command handlers.

Use it for image generation, reminders, expensive syncs, retries, and other bot tasks that need queue state, shard-aware locks, Discord context, processors, producers, and lifecycle events.

Status: beta/draft. The package is usable, but public API details may change before a stable release.

## Install

```sh
pnpm add @slipher/queues
```

## Seyfert module usage

```ts
import { createSeyfertJob, Process, Processor, QueueEvent, QueueModule } from '@slipher/queues';

@Processor('images', { concurrency: 2, attempts: 3, retryDelay: '5s' })
class ImageProcessor {
	@Process('anime')
	async anime(job) {
		return generateAnimeImage(job.data.payload);
	}

	@QueueEvent('completed')
	async completed(job, result) {
		const channel = await client.channels.fetch(job.data.context.channelId);
		await channel?.messages.write({ files: [result] });
	}
}

const queues = new QueueModule({ logger: client.logger, lock: locks });
queues.register({ processors: [ImageProcessor] });

queues.get('images').add(createSeyfertJob(ctx, { prompt: 'kanna ship it' }, { name: 'anime' }));
```

Jobs created with `createSeyfertJob` keep a compact snapshot of command context: command, guild, channel, user, shard, interaction, and locale.

## Producers

```ts
import { InjectQueue } from '@slipher/queues';

class ImageProducer {
	constructor(@InjectQueue('images') private readonly images) {}

	anime(ctx, payload) {
		return this.images.add(createSeyfertJob(ctx, payload, { name: 'anime' }));
	}
}

queues.register({ producers: [ImageProducer] });
const producer = queues.getProducer(ImageProducer);
```

## Inspecting queue state

```ts
console.log(queues.get('images').counts());
console.log(queues.get('images').getJob('1')?.snapshot());
```

## Lifecycle

`pause()` stops pulling new jobs. Jobs already marked active keep running. `clear()` removes waiting, delayed, completed, failed, and skipped jobs, but throws while any job is active.

This package is an in-memory queue. It does not persist waiting jobs, recover active work after process exit, or provide a distributed queue store yet.

## Shard-safe processing

Pass a `LockManager` when multiple Seyfert shards may enqueue equivalent work and only one processor should run at a time.

```ts
import { LockManager } from '@slipher/locks';
import { RedisLockStore } from '@slipher/locks/redis';
import { QueueModule } from '@slipher/queues';

const store = new RedisLockStore({
	redisOptions: { url: process.env.REDIS_URL },
	namespace: 'slipher:locks',
});
await store.start();

const locks = new LockManager({ store });
const queues = new QueueModule({
	lock: locks,
});
```

When a shard cannot acquire the lock for a job, the queue marks it as `skipped` and emits `skipped` instead of treating lock contention as processor failure. That keeps duplicate shard attempts out of retry and dead-letter accounting.

`MemoryLockStore` only coordinates work inside one process. Use `RedisLockStore` for cross-process or cross-host shards.
