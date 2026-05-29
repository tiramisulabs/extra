import { assert, describe, test } from 'vitest';
import {
	Cron,
	createScheduler,
	Interval,
	memory,
	parseDuration,
	persistent,
	type ScheduledTask,
	scheduler,
} from '../src';

class FakeCronerJob {
	paused = false;
	stopped = false;

	constructor(
		readonly expression: string,
		readonly options: Record<string, unknown>,
		private readonly runner: () => unknown,
	) {}

	trigger() {
		return this.runner();
	}

	pause() {
		this.paused = true;
	}

	resume() {
		this.paused = false;
	}

	stop() {
		this.stopped = true;
	}

	nextRun() {
		return new Date('2026-05-29T10:05:00.000Z');
	}
}

function createFakeCroner() {
	const jobs: FakeCronerJob[] = [];
	const factory = (expression: string, options: Record<string, unknown>, runner: () => unknown) => {
		const job = new FakeCronerJob(expression, options, runner);
		jobs.push(job);
		return job;
	};

	return { factory, jobs };
}

function createFakeBullMQ() {
	const state = {
		queues: [] as FakeQueue[],
		workers: [] as FakeWorker[],
	};

	class FakeQueue {
		closed = false;
		schedulers: Array<{ id: string; repeat: Record<string, unknown>; template: Record<string, unknown> }> = [];
		removed: string[] = [];

		constructor(
			readonly name: string,
			readonly options: Record<string, unknown>,
		) {
			state.queues.push(this);
		}

		upsertJobScheduler(id: string, repeat: Record<string, unknown>, template: Record<string, unknown>) {
			this.schedulers.push({ id, repeat, template });
		}

		removeJobScheduler(id: string) {
			this.removed.push(id);
		}

		close() {
			this.closed = true;
		}
	}

	class FakeWorker {
		closed = false;

		constructor(
			readonly name: string,
			readonly processor: (job: { name: string; data?: Record<string, unknown> }) => unknown,
			readonly options: Record<string, unknown>,
		) {
			state.workers.push(this);
		}

		close() {
			this.closed = true;
		}
	}

	return {
		module: { Queue: FakeQueue, Worker: FakeWorker },
		state,
	};
}

function waitForEvent<T>(registry: { once(event: string, listener: (payload: T) => void): () => void }, event: string) {
	return new Promise<T>(resolve => {
		registry.once(event, resolve);
	});
}

describe('scheduler', () => {
	test('runs interval tasks with the Croner memory driver and emits lifecycle events', async () => {
		const croner = createFakeCroner();
		const registry = createScheduler({
			driver: memory({ croner: croner.factory }),
		});
		const started = waitForEvent<{ task: ScheduledTask }>(registry, 'started');
		const completed = waitForEvent<{ task: ScheduledTask; result: string }>(registry, 'completed');
		const runs: string[] = [];

		const task = registry.interval('heartbeat', '5m', current => {
			runs.push(current.id);
			return 'ok';
		});

		assert.equal(croner.jobs.length, 1);
		assert.equal(croner.jobs[0]!.expression, '* * * * * *');
		assert.equal(croner.jobs[0]!.options.interval, 300);
		assert.equal(croner.jobs[0]!.options.name, 'heartbeat');
		assert.equal(task.status, 'scheduled');

		await croner.jobs[0]!.trigger();

		assert.deepEqual(runs, ['heartbeat']);
		assert.equal((await started).task.id, 'heartbeat');
		assert.equal((await completed).result, 'ok');
		assert.equal(task.runCount, 1);
		assert.equal(task.status, 'completed');
		assert.equal(task.lastRunAt instanceof Date, true);
		assert.equal(task.nextRunAt?.toISOString(), '2026-05-29T10:05:00.000Z');
		assert.equal(registry.get('heartbeat'), task);
		assert.deepEqual(
			registry.snapshot().map(item => item.id),
			['heartbeat'],
		);

		await registry.close();

		assert.equal(croner.jobs[0]!.stopped, true);
	});

	test('registers decorated class methods and exposes the registry through the seyfert plugin context', async () => {
		const croner = createFakeCroner();
		const runs: string[] = [];

		class MaintenanceTasks {
			heartbeat(task: ScheduledTask) {
				runs.push(task.id);
			}

			daily(task: ScheduledTask) {
				runs.push(task.id);
			}
		}

		Interval('5m', { id: 'heartbeat' })(MaintenanceTasks.prototype, 'heartbeat');
		Cron('0 0 * * *', { id: 'daily' })(MaintenanceTasks.prototype, 'daily');

		const plugin = scheduler({
			driver: memory({ croner: croner.factory }),
			tasks: [MaintenanceTasks],
		});
		const client: Record<string, unknown> = {};

		await plugin.setup?.(client);

		const extension = plugin.options?.({})?.context?.({});

		assert.equal(plugin.name, '@slipher/scheduler');
		assert.equal(client.scheduler, plugin.registry);
		assert.equal(extension?.scheduler, plugin.registry);
		assert.deepEqual(
			plugin.registry.list().map(task => task.id),
			['heartbeat', 'daily'],
		);

		await croner.jobs[0]!.trigger();
		await croner.jobs[1]!.trigger();

		assert.deepEqual(runs, ['heartbeat', 'daily']);
	});

	test('adds interval and cron tasks through the generic add helper', () => {
		const croner = createFakeCroner();
		const registry = createScheduler({
			driver: memory({ croner: croner.factory }),
		});

		const interval = registry.add('reminder', '30m', () => undefined);
		const cron = registry.add('daily', '0 0 * * *', () => undefined);

		assert.equal(interval.kind, 'interval');
		assert.equal(interval.intervalMs, 1_800_000);
		assert.equal(cron.kind, 'cron');
		assert.equal(cron.expression, '0 0 * * *');
		assert.deepEqual(
			croner.jobs.map(job => job.options.name),
			['reminder', 'daily'],
		);
	});

	test('emits scheduled before running an immediate memory task', async () => {
		const croner = createFakeCroner();
		const registry = createScheduler({
			driver: memory({ croner: croner.factory }),
		});
		const events: string[] = [];
		const completed = waitForEvent(registry, 'completed');

		registry.on('scheduled', () => {
			events.push('scheduled');
		});
		registry.on('started', () => {
			events.push('started');
		});

		registry.interval(
			'boot',
			'1s',
			() => {
				events.push('runner');
			},
			{ runImmediately: true },
		);
		await completed;

		assert.deepEqual(events, ['scheduled', 'started', 'runner']);
		assert.equal(croner.jobs.length, 1);
	});

	test('uses BullMQ job schedulers for the persistent driver and runs jobs through its worker', async () => {
		const bullmq = createFakeBullMQ();
		const connection = { host: '127.0.0.1' };
		const registry = createScheduler({
			driver: persistent({
				bullmq: bullmq.module,
				connection,
				prefix: 'slipher-test',
				queueName: 'scheduler',
			}),
		});
		const runs: string[] = [];

		registry.cron('daily', '0 0 * * *', task => {
			runs.push(task.id);
			return 'cron-result';
		});
		registry.interval('heartbeat', '30s', task => {
			runs.push(task.id);
			return 'interval-result';
		});

		assert.equal(bullmq.state.queues[0]!.name, 'scheduler');
		assert.deepEqual(bullmq.state.queues[0]!.options, { connection, prefix: 'slipher-test' });
		assert.equal(bullmq.state.workers[0]!.name, 'scheduler');
		assert.deepEqual(bullmq.state.workers[0]!.options, { connection, prefix: 'slipher-test' });
		assert.deepEqual(bullmq.state.queues[0]!.schedulers, [
			{
				id: 'daily',
				repeat: { pattern: '0 0 * * *' },
				template: { name: 'daily', data: { taskId: 'daily' } },
			},
			{
				id: 'heartbeat',
				repeat: { every: 30_000 },
				template: { name: 'heartbeat', data: { taskId: 'heartbeat' } },
			},
		]);

		const result = await bullmq.state.workers[0]!.processor({ name: 'daily', data: { taskId: 'daily' } });

		assert.equal(result, 'cron-result');
		assert.deepEqual(runs, ['daily']);

		await registry.close();

		assert.equal(bullmq.state.queues[0]!.closed, true);
		assert.equal(bullmq.state.workers[0]!.closed, true);
	});

	test('parses human interval durations for scheduler definitions', () => {
		assert.equal(parseDuration('10ms'), 10);
		assert.equal(parseDuration('1s 5ms'), 1005);
		assert.equal(parseDuration('2h'), 7_200_000);
		assert.throws(() => parseDuration('soon'), /Invalid duration/);
	});
});
