import { Cron as Croner } from 'croner';
import { assert, describe, test } from 'vitest';
import {
	Cron,
	type CronerFactoryOptions,
	createScheduler,
	Interval,
	memory,
	persistent,
	type ScheduledTask,
	type SchedulerEventName,
	type SchedulerEventPayloads,
	type SchedulerRegistry,
	scheduler,
} from '../src';
import { parseDuration } from '../src/duration';
import { createFakeBullMQ } from './fake-bullmq';

class FakeCronerJob {
	private busy = false;
	paused: boolean;
	stopped = false;

	constructor(
		readonly expression: string,
		readonly options: CronerFactoryOptions,
		private readonly runner: () => unknown,
	) {
		this.paused = options.paused === true;
	}

	trigger() {
		if (this.paused) return undefined;
		if (this.busy && this.options.protect) {
			this.options.protect();
			return undefined;
		}

		this.busy = true;
		return Promise.resolve()
			.then(() => this.runner())
			.catch(() => undefined)
			.finally(() => {
				this.busy = false;
			});
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
	const factory = (expression: string, options: CronerFactoryOptions, runner: () => unknown) => {
		const job = new FakeCronerJob(expression, options, runner);
		jobs.push(job);
		return job;
	};

	return { factory, jobs };
}

async function flushMicrotasks() {
	for (let index = 0; index < 100; index += 1) await Promise.resolve();
}

function waitForEvent<TEvent extends SchedulerEventName>(registry: SchedulerRegistry, event: TEvent) {
	return new Promise<SchedulerEventPayloads[TEvent]>(resolve => {
		registry.once(event, resolve);
	});
}

async function assertRejects(run: () => Promise<unknown>, expected: RegExp) {
	let thrown: unknown;
	try {
		await run();
	} catch (error) {
		thrown = error;
	}

	assert.instanceOf(thrown, Error);
	assert.match((thrown as Error).message, expected);
}

function applyMethodDecorator(decorator: MethodDecorator, target: object, propertyKey: string) {
	const descriptor = Object.getOwnPropertyDescriptor(target, propertyKey);
	if (!descriptor) throw new Error(`Missing method descriptor for ${propertyKey}`);
	decorator(target, propertyKey, descriptor);
}

describe('scheduler', () => {
	test('runs interval tasks with the Croner memory driver and emits lifecycle events', async () => {
		const croner = createFakeCroner();
		const registry = createScheduler({
			driver: memory({ croner: croner.factory }),
		});
		const started = waitForEvent(registry, 'started');
		const completed = waitForEvent(registry, 'completed');
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
		assert.equal(croner.jobs[0]!.paused, true);

		await registry.setup({ initialized: true });
		assert.equal(croner.jobs[0]!.paused, false);

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

	test('settles rejected Croner callbacks after emitting failed and releases Croner state', async () => {
		let job: Croner | undefined;
		const registry = createScheduler({
			driver: memory({
				croner(expression, options, runner) {
					job = new Croner(expression, options, async () => {
						await runner();
					});
					return job;
				},
			}),
		});
		const failure = new Error('memory task failed');
		const task = registry.interval('failing', '1h', () => {
			throw failure;
		});
		const failed = waitForEvent(registry, 'failed');
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown) => unhandled.push(error);
		process.on('unhandledRejection', onUnhandled);

		try {
			await registry.setup({ initialized: true });
			void job!.trigger();
			const payload = await failed;
			await new Promise<void>(resolve => setImmediate(resolve));

			assert.equal(payload.task, task);
			assert.equal(payload.error, failure);
			assert.equal(task.status, 'failed');
			assert.equal(task.lastError, failure);
			assert.equal(job!.isBusy(), false);
			assert.deepEqual(unhandled, []);
		} finally {
			process.off('unhandledRejection', onUnhandled);
			await registry.close();
		}
	});

	test('allows overlapping memory runs by default', async () => {
		const croner = createFakeCroner();
		const registry = createScheduler({ driver: memory({ croner: croner.factory }) });
		const releases: Array<() => void> = [];
		let active = 0;
		let maxActive = 0;
		const task = registry.interval('allow-overlap', '1s', async () => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			await new Promise<void>(resolve => releases.push(resolve));
			active -= 1;
		});

		await registry.setup({ initialized: true });
		const first = croner.jobs[0]!.trigger();
		await flushMicrotasks();
		const second = croner.jobs[0]!.trigger();
		await flushMicrotasks();

		assert.equal(task.overlap, 'allow');
		assert.equal(task.runCount, 2);
		assert.equal(maxActive, 2);
		for (const release of releases) release();
		await Promise.all([first, second]);
		await registry.close();
	});

	test('skips overlapping memory runs and emits the task and reason', async () => {
		const croner = createFakeCroner();
		const registry = createScheduler({ driver: memory({ croner: croner.factory }) });
		let release: (() => void) | undefined;
		const task = registry.interval(
			'skip-overlap',
			'1s',
			() =>
				new Promise<void>(resolve => {
					release = resolve;
				}),
			{ overlap: 'skip' },
		);
		const skipped = waitForEvent(registry, 'skipped');

		await registry.setup({ initialized: true });
		const first = croner.jobs[0]!.trigger();
		await flushMicrotasks();
		const second = croner.jobs[0]!.trigger();
		const payload = await skipped;

		assert.equal(second, undefined);
		assert.equal(payload.task, task);
		assert.equal(payload.reason, 'overlap');
		assert.equal(task.overlap, 'skip');
		assert.equal(task.status, 'running');
		assert.equal(task.runCount, 1);
		release?.();
		await first;
		assert.equal(task.status, 'completed');
		await registry.close();
	});

	test('passes cron timezone to Croner and exposes the effective task contract', () => {
		const croner = createFakeCroner();
		const registry = createScheduler({ driver: memory({ croner: croner.factory }) });
		const task = registry.cron('morning-report', '0 9 * * *', () => undefined, {
			timezone: 'America/Santo_Domingo',
		});

		assert.equal(croner.jobs[0]!.options.timezone, 'America/Santo_Domingo');
		assert.equal(croner.jobs[0]!.options.catch, true);
		assert.equal(task.timezone, 'America/Santo_Domingo');
		assert.equal(task.snapshot().timezone, 'America/Santo_Domingo');
		assert.equal(task.snapshot().overlap, 'allow');
	});

	test('keeps memory Croner jobs paused until setup completes', async () => {
		const events: string[] = [];
		const registry = createScheduler({
			driver: memory({
				croner(_expression, options, runner) {
					events.push('croner-created');
					const job = new FakeCronerJob(_expression, options, runner);
					void Promise.resolve().then(() => {
						events.push('croner-trigger');
						return job.trigger();
					});
					return job;
				},
			}),
		});
		registry.on('started', () => {
			events.push('started');
		});

		registry.interval('heartbeat', '1s', () => {
			events.push('runner');
		});

		await Promise.resolve();
		await Promise.resolve();

		assert.deepEqual(events, ['croner-created', 'croner-trigger']);

		await registry.setup({ initialized: true });

		assert.deepEqual(events, ['croner-created', 'croner-trigger']);
		await registry.close();
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

		applyMethodDecorator(Interval('5m', { id: 'heartbeat' }), MaintenanceTasks.prototype, 'heartbeat');
		applyMethodDecorator(Cron('0 0 * * *', { id: 'daily', timezone: 'Etc/UTC' }), MaintenanceTasks.prototype, 'daily');

		const plugin = scheduler({
			driver: memory({ croner: croner.factory }),
			tasks: [MaintenanceTasks],
		});
		const client: Record<string, unknown> = {};
		let onPluginsReady: ((client: Record<string, unknown>) => Promise<void> | void) | undefined;
		plugin.register?.({
			hooks: {
				on(name: string, listener: (client: Record<string, unknown>) => Promise<void> | void) {
					assert.equal(name, 'plugins:ready');
					onPluginsReady = listener;
					return () => undefined;
				},
			},
		} as never);

		await plugin.setup?.(client);
		assert.equal(
			croner.jobs.every(job => job.paused),
			true,
		);
		await onPluginsReady?.(client);
		assert.equal(
			croner.jobs.every(job => !job.paused),
			true,
		);

		const extension = { scheduler: plugin.ctx?.scheduler({} as never, client as never) };

		assert.equal(plugin.name, '@slipher/scheduler');
		assert.equal(typeof plugin.client?.scheduler, 'function');
		assert.equal(client.scheduler, plugin.registry);
		assert.equal(extension.scheduler, plugin.registry);
		assert.deepEqual(
			plugin.registry.list().map(task => task.id),
			['heartbeat', 'daily'],
		);
		assert.equal(croner.jobs[1]!.options.timezone, 'Etc/UTC');

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

	test('reports a clear error when add receives neither duration nor cron', () => {
		const registry = createScheduler({
			driver: memory({
				croner(expression, options, runner) {
					if (expression === 'soon') throw new Error('Croner opaque parse failure');
					return new FakeCronerJob(expression, options, runner);
				},
			}),
		});

		assert.throws(
			() => registry.add('bad-schedule', 'soon', () => undefined),
			/Scheduler schedule "soon" for task "bad-schedule" is not a valid duration or cron expression/,
		);
	});

	test('defers an immediate memory task until setup after emitting scheduled', async () => {
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

		await Promise.resolve();
		assert.deepEqual(events, ['scheduled']);

		await registry.setup({ initialized: true });
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

		registry.cron(
			'daily',
			'0 0 * * *',
			task => {
				runs.push(task.id);
				return 'cron-result';
			},
			{ timezone: 'Etc/UTC' },
		);
		registry.interval('heartbeat', '30s', task => {
			runs.push(task.id);
			return 'interval-result';
		});

		assert.equal(bullmq.state.queues.length, 0);

		await registry.setup({ initialized: true });

		assert.equal(bullmq.state.queues[0]!.name, 'scheduler');
		assert.deepEqual(bullmq.state.queues[0]!.options, { connection, prefix: 'slipher-test' });
		assert.equal(bullmq.state.workers[0]!.name, 'scheduler');
		assert.deepEqual(bullmq.state.workers[0]!.options, {
			autorun: false,
			connection,
			prefix: 'slipher-test',
		});
		assert.equal(bullmq.state.queueEvents[0]!.name, 'scheduler');
		assert.deepEqual(bullmq.state.queues[0]!.schedulers, [
			{
				id: 'daily',
				repeat: { pattern: '0 0 * * *', tz: 'Etc/UTC' },
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

		const queueEventCompletions: string[] = [];
		registry.once('completed', ({ task }) => {
			queueEventCompletions.push(task.id);
		});
		bullmq.state.jobs.set('opaque-job-id', {
			data: { taskId: 'heartbeat' },
			id: 'opaque-job-id',
			name: 'opaque',
		});
		bullmq.state.queueEvents[0]!.emit('completed', {
			jobId: 'opaque-job-id',
			returnvalue: 'queue-event-result',
		});
		await flushMicrotasks();

		assert.deepEqual(queueEventCompletions, ['heartbeat']);

		await registry.close();

		assert.equal(bullmq.state.queues[0]!.closed, true);
		assert.equal(bullmq.state.queueEvents[0]!.closed, true);
		assert.equal(bullmq.state.workers[0]!.closed, true);
	});

	test('rejects unsupported persistent overlap skipping without creating a partial task', () => {
		const bullmq = createFakeBullMQ();
		const registry = createScheduler({ driver: persistent({ bullmq: bullmq.module }) });

		assert.throws(
			() => registry.interval('exclusive', '1m', () => undefined, { overlap: 'skip' }),
			/does not support overlap: "skip"/,
		);
		assert.equal(registry.get('exclusive'), undefined);
		assert.deepEqual(registry.list(), []);
	});

	test('updates persistent task snapshots before emitting queue lifecycle events', async () => {
		const bullmq = createFakeBullMQ();
		const registry = createScheduler({
			driver: persistent({ bullmq: bullmq.module }),
		});
		const events: Array<{
			event: string;
			status: string;
			runCount: number;
			lastRunAt: boolean;
			lastError: unknown;
			result?: unknown;
			error?: string;
		}> = [];

		registry.interval('heartbeat', '30s', () => 'ok');
		registry.interval('cleanup', '30s', () => 'ok');
		registry.on('started', ({ task }) => {
			events.push({
				event: 'started',
				status: task.status,
				runCount: task.runCount,
				lastRunAt: task.lastRunAt instanceof Date,
				lastError: task.lastError,
			});
		});
		registry.on('completed', ({ task, result }) => {
			events.push({
				event: 'completed',
				status: task.status,
				runCount: task.runCount,
				lastRunAt: task.lastRunAt instanceof Date,
				lastError: task.lastError,
				result,
			});
		});
		registry.on('failed', ({ task, error }) => {
			events.push({
				event: 'failed',
				status: task.status,
				runCount: task.runCount,
				lastRunAt: task.lastRunAt instanceof Date,
				lastError: task.lastError instanceof Error ? task.lastError.message : task.lastError,
				error: error instanceof Error ? error.message : String(error),
			});
		});

		await registry.setup({ initialized: true });
		bullmq.state.jobs.set('heartbeat-job', {
			data: { taskId: 'heartbeat' },
			id: 'heartbeat-job',
			name: 'opaque',
		});
		bullmq.state.jobs.set('cleanup-job', {
			data: { taskId: 'cleanup' },
			id: 'cleanup-job',
			name: 'opaque',
		});

		bullmq.state.queueEvents[0]!.emit('active', { jobId: 'heartbeat-job' });
		bullmq.state.queueEvents[0]!.emit('completed', {
			jobId: 'heartbeat-job',
			returnvalue: 'queue-event-result',
		});
		bullmq.state.queueEvents[0]!.emit('failed', {
			jobId: 'cleanup-job',
			failedReason: 'boom',
		});
		await flushMicrotasks();

		assert.deepEqual(events, [
			{
				event: 'started',
				status: 'running',
				runCount: 1,
				lastRunAt: true,
				lastError: undefined,
			},
			{
				event: 'completed',
				status: 'completed',
				runCount: 1,
				lastRunAt: true,
				lastError: undefined,
				result: 'queue-event-result',
			},
			{
				event: 'failed',
				status: 'failed',
				runCount: 1,
				lastRunAt: true,
				lastError: 'boom',
				error: 'boom',
			},
		]);
	});

	test('counts a persistent run once when QueueEvents active arrives before the local processor', async () => {
		const bullmq = createFakeBullMQ();
		const registry = createScheduler({
			driver: persistent({ bullmq: bullmq.module }),
		});
		const task = registry.interval('heartbeat', '30s', () => 'ok');

		await registry.setup({ initialized: true });
		bullmq.state.jobs.set('heartbeat-job', {
			data: { taskId: 'heartbeat' },
			id: 'heartbeat-job',
			name: 'heartbeat',
		});
		bullmq.state.queueEvents[0]!.emit('active', { jobId: 'heartbeat-job' });
		await flushMicrotasks();
		await bullmq.state.workers[0]!.processor({
			data: { taskId: 'heartbeat' },
			id: 'heartbeat-job',
			name: 'heartbeat',
		});

		assert.equal(task.runCount, 1);
		await registry.close();
	});

	test('ignores duplicate and late QueueEvents after the local processor completes', async () => {
		const bullmq = createFakeBullMQ();
		const registry = createScheduler({
			driver: persistent({ bullmq: bullmq.module }),
		});
		const task = registry.interval('heartbeat', '30s', () => 'ok');
		let started = 0;
		let completed = 0;
		registry.on('started', () => {
			started += 1;
		});
		registry.on('completed', () => {
			completed += 1;
		});

		await registry.setup({ initialized: true });
		await bullmq.state.workers[0]!.processor({
			data: { taskId: 'heartbeat' },
			id: 'heartbeat-job',
			name: 'heartbeat',
		});
		bullmq.state.queueEvents[0]!.emit('waiting', { jobId: 'heartbeat-job' });
		bullmq.state.queueEvents[0]!.emit('active', { jobId: 'heartbeat-job', name: 'heartbeat' });
		bullmq.state.queueEvents[0]!.emit('active', { jobId: 'heartbeat-job', name: 'heartbeat' });
		bullmq.state.queueEvents[0]!.emit('completed', { jobId: 'heartbeat-job', name: 'heartbeat' });
		bullmq.state.queueEvents[0]!.emit('completed', { jobId: 'heartbeat-job', name: 'heartbeat' });
		await flushMicrotasks();

		assert.equal(task.runCount, 1);
		assert.equal(started, 1);
		assert.equal(completed, 1);
		await registry.close();
	});

	test('ignores duplicate failed events after the local processor rejects', async () => {
		const bullmq = createFakeBullMQ();
		const registry = createScheduler({
			driver: persistent({ bullmq: bullmq.module }),
		});
		const task = registry.interval('cleanup', '30s', () => {
			throw new Error('boom');
		});
		let failed = 0;
		registry.on('failed', () => {
			failed += 1;
		});

		await registry.setup({ initialized: true });
		await assertRejects(
			() =>
				Promise.resolve(
					bullmq.state.workers[0]!.processor({
						data: { taskId: 'cleanup' },
						id: 'cleanup-job',
						name: 'cleanup',
					}),
				),
			/boom/,
		);
		bullmq.state.queueEvents[0]!.emit('failed', { failedReason: 'boom', jobId: 'cleanup-job', name: 'cleanup' });
		bullmq.state.queueEvents[0]!.emit('failed', { failedReason: 'boom', jobId: 'cleanup-job', name: 'cleanup' });
		bullmq.state.queueEvents[0]!.emit('active', { jobId: 'cleanup-job', name: 'cleanup' });
		await flushMicrotasks();

		assert.equal(task.runCount, 1);
		assert.equal(failed, 1);
		await registry.close();
	});

	test('counts a BullMQ retry with the same job id as a new run', async () => {
		const bullmq = createFakeBullMQ();
		let attempts = 0;
		const registry = createScheduler({
			driver: persistent({ bullmq: bullmq.module }),
		});
		const task = registry.interval('cleanup', '30s', () => {
			attempts += 1;
			if (attempts === 1) throw new Error('retry me');
			return 'ok';
		});
		let started = 0;
		registry.on('started', () => {
			started += 1;
		});

		await registry.setup({ initialized: true });
		const job = { attemptsMade: 0, data: { taskId: 'cleanup' }, id: 'cleanup-job', name: 'cleanup' };
		bullmq.state.jobs.set(job.id, job);
		bullmq.state.queueEvents[0]!.emit('active', { jobId: 'cleanup-job', prev: 'waiting' });
		await flushMicrotasks();
		await assertRejects(() => Promise.resolve(bullmq.state.workers[0]!.processor(job)), /retry me/);
		bullmq.state.queueEvents[0]!.emit('waiting', { jobId: 'cleanup-job', prev: 'active' });
		bullmq.state.queueEvents[0]!.emit('active', { jobId: 'cleanup-job', prev: 'waiting' });
		await flushMicrotasks();
		job.attemptsMade = 1;
		await bullmq.state.workers[0]!.processor(job);

		assert.equal(task.runCount, 2);
		assert.equal(started, 2);
		assert.equal(task.status, 'completed');
		await registry.close();
	});

	test('keeps local retry state when QueueEvents catches up after both attempts', async () => {
		const bullmq = createFakeBullMQ();
		let attempts = 0;
		const registry = createScheduler({
			driver: persistent({ bullmq: bullmq.module }),
		});
		const task = registry.interval('cleanup', '30s', () => {
			attempts += 1;
			if (attempts === 1) throw new Error('retry me');
			return 'ok';
		});
		let started = 0;
		registry.on('started', () => {
			started += 1;
		});

		await registry.setup({ initialized: true });
		const job = { attemptsMade: 0, data: { taskId: 'cleanup' }, id: 'cleanup-job', name: 'cleanup' };
		bullmq.state.jobs.set(job.id, job);
		await assertRejects(() => Promise.resolve(bullmq.state.workers[0]!.processor(job)), /retry me/);
		job.attemptsMade = 1;
		await bullmq.state.workers[0]!.processor(job);

		bullmq.state.queueEvents[0]!.emit('active', { jobId: 'cleanup-job', prev: 'waiting' });
		bullmq.state.queueEvents[0]!.emit('waiting', { jobId: 'cleanup-job', prev: 'active' });
		bullmq.state.queueEvents[0]!.emit('active', { jobId: 'cleanup-job', prev: 'waiting' });
		bullmq.state.queueEvents[0]!.emit('completed', { jobId: 'cleanup-job', returnvalue: 'ok' });
		await flushMicrotasks();

		assert.equal(task.runCount, 2);
		assert.equal(started, 2);
		assert.equal(task.status, 'completed');
		await registry.close();
	});

	test('serializes async QueueEvents for a reprocessed job', async () => {
		const bullmq = createFakeBullMQ();
		const registry = createScheduler({
			driver: persistent({ bullmq: bullmq.module }),
		});
		const task = registry.interval('cleanup', '30s', () => 'ok');
		let started = 0;
		let completed = 0;
		registry.on('started', () => {
			started += 1;
		});
		registry.on('completed', () => {
			completed += 1;
		});

		await registry.setup({ initialized: true });
		bullmq.state.jobs.set('cleanup-job', {
			data: { taskId: 'cleanup' },
			id: 'cleanup-job',
			name: 'cleanup',
		});
		bullmq.state.queueEvents[0]!.emit('active', { jobId: 'cleanup-job' });
		await flushMicrotasks();

		let releaseLookup: (() => void) | undefined;
		bullmq.state.jobLookupGate = new Promise<void>(resolve => {
			releaseLookup = resolve;
		});
		bullmq.state.queueEvents[0]!.emit('completed', { jobId: 'cleanup-job', returnvalue: 'first' });
		bullmq.state.queueEvents[0]!.emit('waiting', { jobId: 'cleanup-job', prev: 'completed' });
		bullmq.state.queueEvents[0]!.emit('active', { jobId: 'cleanup-job' });
		releaseLookup?.();
		await flushMicrotasks();
		await flushMicrotasks();
		await flushMicrotasks();

		assert.equal(task.runCount, 2);
		assert.equal(task.status, 'running');
		assert.equal(started, 2);
		assert.equal(completed, 1);
		await registry.close();
	});

	test('persistent setup rejects after close without reopening resources', async () => {
		const bullmq = createFakeBullMQ();
		const registry = createScheduler({
			driver: persistent({ bullmq: bullmq.module }),
		});

		registry.cron('daily', '0 0 * * *', () => undefined);
		await registry.setup({ initialized: true });
		await registry.close();

		await assertRejects(() => registry.setup({ initialized: true }), /has been stopped/);
		assert.equal(bullmq.state.queues.length, 1);
		assert.equal(bullmq.state.queueEvents.length, 1);
		assert.equal(bullmq.state.workers.length, 1);
	});

	test('persistent setup rolls back partial resources and can retry', async () => {
		const bullmq = createFakeBullMQ();
		const registry = createScheduler({
			driver: persistent({ bullmq: bullmq.module }),
		});
		registry.interval('heartbeat', '30s', () => undefined);
		bullmq.state.failUpserts = 1;

		await assertRejects(() => registry.setup({ initialized: true }), /upsert failed/);
		assert.equal(bullmq.state.queues[0]!.closed, true);
		assert.equal(bullmq.state.queueEvents[0]!.closed, true);
		assert.equal(bullmq.state.workers[0]!.closed, true);

		await registry.setup({ initialized: true });
		assert.equal(bullmq.state.queues.length, 2);
		assert.equal(bullmq.state.queues[1]!.closed, false);
		await registry.close();
	});

	test('persistent setup coalesces concurrent callers', async () => {
		const bullmq = createFakeBullMQ();
		const registry = createScheduler({
			driver: persistent({ bullmq: bullmq.module }),
		});
		registry.interval('heartbeat', '30s', () => undefined);

		await Promise.all([registry.setup({ initialized: true }), registry.setup({ initialized: true })]);
		assert.equal(bullmq.state.queues.length, 1);
		assert.equal(bullmq.state.queueEvents.length, 1);
		assert.equal(bullmq.state.workers.length, 1);
		await registry.close();
	});

	test('persistent close coalesces callers and rejects setup while resources are closing', async () => {
		const bullmq = createFakeBullMQ();
		const registry = createScheduler({
			driver: persistent({ bullmq: bullmq.module }),
		});
		registry.interval('heartbeat', '30s', () => undefined);
		await registry.setup({ initialized: true });

		let releaseClose: (() => void) | undefined;
		bullmq.state.closeGate = new Promise<void>(resolve => {
			releaseClose = resolve;
		});
		let secondCloseResolved = false;
		const firstClose = registry.close();
		const secondClose = registry.close().then(() => {
			secondCloseResolved = true;
		});
		await flushMicrotasks();

		assert.equal(secondCloseResolved, false);
		await assertRejects(() => registry.setup({ initialized: true }), /has been stopped/);
		releaseClose?.();
		await Promise.all([firstClose, secondClose]);
		assert.equal(bullmq.state.queues[0]!.closed, true);
		assert.equal(bullmq.state.queueEvents[0]!.closed, true);
		assert.equal(bullmq.state.workers[0]!.closed, true);
	});

	test('persistent close drains queued terminal events before closing Queue', async () => {
		const bullmq = createFakeBullMQ();
		const registry = createScheduler({
			driver: persistent({ bullmq: bullmq.module }),
		});
		const task = registry.interval('heartbeat', '30s', () => undefined);
		let completed = 0;
		registry.on('completed', () => {
			completed += 1;
		});
		await registry.setup({ initialized: true });
		bullmq.state.jobs.set('heartbeat-job', {
			data: { taskId: 'heartbeat' },
			id: 'heartbeat-job',
			name: 'heartbeat',
		});

		bullmq.state.queueEvents[0]!.emit('completed', {
			jobId: 'heartbeat-job',
			returnvalue: 'ok',
		});
		await registry.close();

		assert.equal(task.status, 'completed');
		assert.equal(task.runCount, 1);
		assert.equal(completed, 1);
		assert.equal(bullmq.state.queues[0]!.closed, true);
	});

	test('persistent pause removes the job scheduler and resume re-upserts its template', async () => {
		const bullmq = createFakeBullMQ();
		const registry = createScheduler({
			driver: persistent({ bullmq: bullmq.module }),
		});

		registry.cron('daily', '0 0 * * *', () => undefined);
		await registry.setup({ initialized: true });
		const resumed = waitForEvent(registry, 'resumed');

		await registry.pause('daily');
		await registry.resume('daily');

		assert.deepEqual(bullmq.state.queues[0]!.removed, ['daily']);
		assert.deepEqual(
			bullmq.state.queues[0]!.schedulers.map(item => item.id),
			['daily', 'daily'],
		);
		assert.equal(registry.get('daily')?.status, 'scheduled');
		assert.equal((await resumed).task.id, 'daily');
	});

	test('persistent runImmediately deduplicates a start wave and runs again after its window', async () => {
		const bullmq = createFakeBullMQ();
		const createRegistry = () => {
			const registry = createScheduler({
				driver: persistent({ bullmq: bullmq.module, immediateRunDeduplicationMs: 1_000 }),
			});
			registry.interval('boot', '30s', () => undefined, { runImmediately: true });
			return registry;
		};
		const first = createRegistry();
		const second = createRegistry();

		await first.setup({ initialized: true });
		await second.setup({ initialized: true });
		assert.equal(bullmq.state.acceptedJobs.length, 1);
		assert.deepEqual(bullmq.state.queues[0]!.adds[0]!.options, {
			deduplication: { id: 'slipher:scheduler:immediate:boot', ttl: 1_000 },
			delay: 0,
		});
		assert.equal('jobId' in bullmq.state.queues[0]!.adds[0]!.options, false);

		bullmq.state.now = 1_001;
		const nextWave = createRegistry();
		await nextWave.setup({ initialized: true });
		assert.equal(bullmq.state.acceptedJobs.length, 2);
		assert.notEqual(bullmq.state.acceptedJobs[0]!.id, bullmq.state.acceptedJobs[1]!.id);

		await first.close();
		await second.close();
		await nextWave.close();
	});

	test('persistent validates the immediate run deduplication window', () => {
		const bullmq = createFakeBullMQ();
		for (const immediateRunDeduplicationMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			assert.throws(() => persistent({ bullmq: bullmq.module, immediateRunDeduplicationMs }), /positive integer/);
		}
	});

	test('persistent setup warns about or purges orphaned schedulers', async () => {
		const warned: unknown[] = [];
		const purged = createFakeBullMQ();
		const warnedBullmq = createFakeBullMQ();
		warnedBullmq.state.jobSchedulers.push({ id: 'old-task' }, { id: 'daily' });
		purged.state.jobSchedulers.push({ id: 'old-task' });

		const warnRegistry = createScheduler({
			driver: persistent({ bullmq: warnedBullmq.module }),
			logger: {
				warn: (...args: unknown[]) => warned.push(args),
			},
		});
		warnRegistry.cron('daily', '0 0 * * *', () => undefined);
		await warnRegistry.setup({ initialized: true });

		assert.equal(warned.length, 1);
		assert.match(String((warned[0] as unknown[])[1]), /scheduler\.removeOrphan\('old-task'\)/);
		assert.deepEqual(warnedBullmq.state.queues[0]!.removed, []);
		await warnRegistry.removeOrphan('old-task');
		assert.deepEqual(warnedBullmq.state.queues[0]!.removed, ['old-task']);
		await assertRejects(() => warnRegistry.removeOrphan('daily'), /is registered; use remove\('daily'\)/);

		const purgeRegistry = createScheduler({
			driver: persistent({ bullmq: purged.module, purgeOrphansOnStartup: true }),
		});
		purgeRegistry.cron('daily', '0 0 * * *', () => undefined);
		await purgeRegistry.setup({ initialized: true });

		assert.deepEqual(purged.state.queues[0]!.removed, ['old-task']);
	});

	test('persistent attaches BullMQ error handlers before starting the worker', async () => {
		const bullmq = createFakeBullMQ();
		const logged: unknown[] = [];
		const registry = createScheduler({
			driver: persistent({ bullmq: bullmq.module }),
			logger: {
				error: (...args: unknown[]) => logged.push(args),
			},
		});
		const errors: Array<{ source: string; error: unknown }> = [];
		registry.on('error', payload => {
			errors.push(payload);
		});
		registry.interval('heartbeat', '30s', () => undefined);

		await registry.setup({ initialized: true });

		assert.equal(bullmq.state.workers[0]!.options.autorun, false);
		assert.deepEqual(bullmq.state.workerRunErrorListenerCounts, [1]);
		const queueError = new Error('queue connection failed');
		const queueEventsError = new Error('queue events connection failed');
		const workerError = new Error('worker connection failed');
		bullmq.state.queues[0]!.emit('error', queueError);
		bullmq.state.queueEvents[0]!.emit('error', queueEventsError);
		bullmq.state.workers[0]!.emit('error', workerError);

		assert.deepEqual(errors, [
			{ source: 'queue', error: queueError },
			{ source: 'queue-events', error: queueEventsError },
			{ source: 'worker', error: workerError },
		]);
		assert.equal(logged.length, 3);
		await registry.close();
	});

	test('persistent decorated tasks require explicit stable ids', async () => {
		const bullmq = createFakeBullMQ();

		class Tasks {
			implicit() {}
			explicit() {}
		}

		applyMethodDecorator(Interval('5m'), Tasks.prototype, 'implicit');
		applyMethodDecorator(Interval('5m', { id: 'stable-explicit' }), Tasks.prototype, 'explicit');

		const registry = createScheduler({
			driver: persistent({ bullmq: bullmq.module }),
			tasks: [Tasks],
		});

		await assertRejects(() => registry.setup({ initialized: true }), /requires explicit task ids.*Tasks\.implicit/);
		assert.equal(bullmq.state.queues.length, 0);
		assert.equal(bullmq.state.queueEvents.length, 0);
		assert.equal(bullmq.state.workers.length, 0);
	});

	test('parses human interval durations for scheduler definitions', () => {
		assert.equal(parseDuration('10ms'), 10);
		assert.equal(parseDuration('1s 5ms'), 1005);
		assert.equal(parseDuration('2h'), 7_200_000);
		assert.throws(() => parseDuration('soon'), /Invalid duration/);
	});
});
