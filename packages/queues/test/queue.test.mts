import { assert, describe, test } from 'vitest';
import { parseDuration, Queue } from '../src';

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
		const queue = new Queue<string, string>('priority', { autostart: false });
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
});
