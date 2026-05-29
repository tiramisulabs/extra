import { LockManager } from '@slipher/locks';
import { assert, describe, test } from 'vitest';
import {
	createSeyfertJob,
	InjectQueue,
	Process,
	Processor,
	parseDuration,
	Queue,
	QueueEvent,
	QueueModule,
} from '../src';

function waitForEvent<TArgs extends readonly unknown[]>(
	queue: { on(event: string, listener: (...args: TArgs) => void): () => void },
	event: string,
): Promise<TArgs> {
	return new Promise(resolve => {
		const off = queue.on(event, (...args: TArgs) => {
			off();
			resolve(args);
		});
	});
}

function wait(milliseconds: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function createDeferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(next => {
		resolve = next;
	});

	return { promise, resolve };
}

describe('parseDuration', () => {
	test('parses queue delay inputs', () => {
		assert.equal(parseDuration(0), 0);
		assert.equal(parseDuration('10ms'), 10);
		assert.equal(parseDuration('1s 5ms'), 1005);
		assert.throws(() => parseDuration('soon'), RangeError);
	});
});

describe('Queue', () => {
	test('processes jobs and stores completed results', async () => {
		const queue = new Queue<number, number>('math');
		const completed = waitForEvent(queue, 'completed');

		queue.process(async job => job.data * 2);
		const job = queue.add(21);
		const [completedJob, result] = await completed;

		assert.equal(completedJob, job);
		assert.equal(result, 42);
		assert.equal(job.status, 'completed');
		assert.equal(job.result, 42);
		assert.equal(queue.counts().completed, 1);
		assert.equal(queue.getJob(job.id), job);
	});

	test('rejects duplicate explicit job IDs', () => {
		const queue = new Queue<string, string>('duplicate', { autostart: false });

		queue.add('first', { id: 'same' });

		assert.throws(() => queue.add('second', { id: 'same' }), RangeError);
		assert.equal(queue.counts().waiting, 1);
	});

	test('skips generated job ID collisions', () => {
		const ids = ['same', 'same', 'other'];
		const queue = new Queue<string, string>('generated-duplicate', {
			autostart: false,
			idGenerator: () => ids.shift() ?? 'fallback',
		});

		const first = queue.add('first');
		const second = queue.add('second');

		assert.equal(first.id, 'same');
		assert.equal(second.id, 'other');
	});

	test('respects concurrency', async () => {
		const first = createDeferred<void>();
		const second = createDeferred<void>();
		const releases = [first, second];
		const started: string[] = [];
		const queue = new Queue<string, string>('concurrent', { concurrency: 2 });

		queue.process(async job => {
			started.push(job.data);
			await releases.shift()?.promise;
			return job.data;
		});
		queue.add('a');
		queue.add('b');
		queue.add('c');

		await Promise.resolve();
		assert.deepEqual(started, ['a', 'b']);
		assert.equal(queue.counts().active, 2);
		assert.equal(queue.counts().waiting, 1);

		const thirdActive = waitForEvent(queue, 'active');
		first.resolve();
		await thirdActive;
		assert.deepEqual(started, ['a', 'b', 'c']);

		const idle = waitForEvent(queue, 'idle');
		second.resolve();
		await idle;
		assert.equal(queue.counts().completed, 3);
	});

	test('runs higher priority jobs first when run time matches', async () => {
		const processed: string[] = [];
		const queue = new Queue<string, string>('priority', { autostart: false, now: () => 0 });
		const idle = waitForEvent(queue, 'idle');

		queue.add('low', { priority: 0 });
		queue.add('high', { priority: 10 });
		queue.process(async job => {
			processed.push(job.data);
			return job.data;
		});

		await idle;
		assert.deepEqual(processed, ['high', 'low']);
	});

	test('retries failed jobs before marking them completed', async () => {
		let attempts = 0;
		const queue = new Queue<string, string>('retry', { attempts: 2, retryDelay: 0 });
		const retrying = waitForEvent(queue, 'retrying');
		const completed = waitForEvent(queue, 'completed');

		queue.process(job => {
			attempts++;
			if (attempts === 1) throw new Error('try again');
			return job.data;
		});
		const job = queue.add('ok');
		const [, error, delay] = await retrying;
		const [completedJob] = await completed;

		assert.instanceOf(error, Error);
		assert.equal(delay, 0);
		assert.equal(completedJob, job);
		assert.equal(job.attemptsMade, 2);
		assert.equal(job.status, 'completed');
	});

	test('marks exhausted jobs as failed', async () => {
		const queue = new Queue<string, string>('failed', { attempts: 1 });
		const failed = waitForEvent(queue, 'failed');

		queue.process(() => {
			throw new Error('boom');
		});
		const job = queue.add('bad');
		const [failedJob, error] = await failed;

		assert.equal(failedJob, job);
		assert.instanceOf(error, Error);
		assert.equal(job.status, 'failed');
		assert.equal(queue.counts().failed, 1);
	});

	test('marks jobs as failed when retry delay resolution is invalid', async () => {
		const queue = new Queue<string, string>('invalid-retry', {
			attempts: 2,
			retryDelay: () => 'soon',
		});
		const failed = Promise.race([
			waitForEvent(queue, 'failed'),
			wait(25).then(() => {
				throw new Error('Timed out waiting for failed event.');
			}),
		]);

		queue.process(() => {
			throw new Error('processor failed');
		});
		const job = queue.add('bad-retry');
		const [failedJob, error] = await failed;

		assert.equal(failedJob, job);
		assert.instanceOf(error, Error);
		assert.equal(job.status, 'failed');
		assert.equal(queue.counts().failed, 1);
		assert.equal(queue.getJob(job.id), job);
	});

	test('waits for delayed jobs', async () => {
		const queue = new Queue<string, string>('delayed');
		const completed = waitForEvent(queue, 'completed');

		queue.process(job => job.data);
		const job = queue.add('later', { delay: '5ms' });

		assert.equal(job.status, 'delayed');
		assert.equal(queue.counts().delayed, 1);

		const [completedJob] = await completed;
		assert.equal(completedJob, job);
	});

	test('refuses to clear while jobs are active', async () => {
		const release = createDeferred<void>();
		const queue = new Queue<string, string>('clear-active');
		const active = waitForEvent(queue, 'active');
		const completed = waitForEvent(queue, 'completed');

		queue.process(async job => {
			await release.promise;
			return job.data;
		});
		queue.add('running');
		await active;

		assert.throws(() => queue.clear(), RangeError);
		assert.equal(queue.counts().active, 1);

		release.resolve();
		await completed;
	});

	test('runs processors while holding a resolved lock key', async () => {
		const locks = new LockManager();
		const queue = new Queue<string, string>('locked', {
			lock: locks,
			lockKey: job => `queue:${job.data}`,
		});
		const completed = waitForEvent(queue, 'completed');

		queue.process(async job => {
			const competing = await locks
				.acquire(`queue:${job.data}`)
				.then(async lock => {
					await locks.release(lock);
					return true;
				})
				.catch(() => false);
			return competing ? 'unlocked' : 'locked';
		});
		const job = queue.add('sync');
		const [completedJob, result] = await completed;

		assert.equal(completedJob, job);
		assert.equal(result, 'locked');
	});

	test('emits skipped instead of failed when another holder owns the lock', async () => {
		const locks = new LockManager();
		const lock = await locks.acquire('queue:shared', { ttl: '100ms' });
		const queue = new Queue<string, string>('locked', {
			lock: locks,
			lockKey: 'queue:shared',
			attempts: 1,
		});
		const skipped = waitForEvent(queue, 'skipped');

		queue.process(job => job.data);
		const job = queue.add('sync');
		const [skippedJob, error] = await skipped;

		assert.equal(skippedJob, job);
		assert.instanceOf(error, Error);
		assert.equal(job.status, 'skipped');
		assert.equal(queue.counts().skipped, 1);
		assert.equal(queue.counts().failed, 0);
		await locks.release(lock);
	});
});

describe('QueueModule', () => {
	test('creates Seyfert job payloads from command context', () => {
		const job = createSeyfertJob(
			{
				fullCommandName: 'image anime',
				guildId: 'guild-1',
				channelId: 'channel-1',
				shardId: 3,
				author: { id: 'user-1' },
				interaction: { id: 'interaction-1', locale: 'es-ES' },
			},
			{ prompt: 'ship it' },
			{ name: 'generate' },
		);

		assert.deepEqual(job, {
			name: 'generate',
			payload: { prompt: 'ship it' },
			context: {
				command: 'image anime',
				guildId: 'guild-1',
				channelId: 'channel-1',
				shardId: 3,
				userId: 'user-1',
				interactionId: 'interaction-1',
				locale: 'es-ES',
			},
		});
	});

	test('registers decorated Seyfert processors and queue events', async () => {
		const processed: string[] = [];
		const events: string[] = [];

		class ImageProcessor {
			async generate(job: { data: { payload: { prompt: string } } }) {
				processed.push(job.data.payload.prompt);
				return 'image.png';
			}

			completed(_job: unknown, result: string) {
				events.push(result);
			}
		}

		Processor('images')(ImageProcessor);
		Process('generate')(ImageProcessor.prototype, 'generate');
		QueueEvent('completed')(ImageProcessor.prototype, 'completed');

		const module = new QueueModule();
		module.register({ processors: [ImageProcessor] });
		const queue = module.get('images');
		const completed = waitForEvent(queue, 'completed');

		const job = queue.add(createSeyfertJob({}, { prompt: 'draw' }, { name: 'generate' }));
		const [completedJob, result] = await completed;

		assert.equal(completedJob, job);
		assert.equal(result, 'image.png');
		assert.deepEqual(processed, ['draw']);
		assert.deepEqual(events, ['image.png']);
	});

	test('injects queues into producer constructor positions', () => {
		class ImageProducer {
			constructor(
				readonly audit: unknown,
				readonly images: unknown,
			) {}
		}

		InjectQueue('images')(ImageProducer, undefined, 1);
		InjectQueue('audit')(ImageProducer, undefined, 0);

		const module = new QueueModule();
		module.register({ producers: [ImageProducer] });
		const producer = module.getProducer(ImageProducer);

		assert.equal(producer?.audit, module.get('audit'));
		assert.equal(producer?.images, module.get('images'));
	});

	test('rejects duplicate processor queue registrations with conflicting options', () => {
		class FirstProcessor {
			run() {
				return 'first';
			}
		}
		class SecondProcessor {
			run() {
				return 'second';
			}
		}

		Processor('images', { concurrency: 1 })(FirstProcessor);
		Process()(FirstProcessor.prototype, 'run');
		Processor('images', { concurrency: 2 })(SecondProcessor);
		Process()(SecondProcessor.prototype, 'run');

		const module = new QueueModule();
		module.register({ processors: [FirstProcessor] });

		assert.throws(() => module.register({ processors: [SecondProcessor] }), RangeError);
	});
});
