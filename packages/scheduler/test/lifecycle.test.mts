import { createPlugin, definePlugins, HttpClient } from 'seyfert';
import { assert, describe, test } from 'vitest';
import {
	type CronerFactoryOptions,
	createScheduler,
	memory,
	persistent,
	type SchedulerEventName,
	type SchedulerEventPayloads,
	type SchedulerRegistry,
	scheduler,
} from '../src';
import { createFakeBullMQ } from './fake-bullmq';

class FakeCronerJob {
	paused = true;
	stopped = false;

	constructor(private readonly runner: () => unknown) {}

	trigger() {
		if (this.paused) return undefined;
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
}

function createFakeCroner() {
	const jobs: FakeCronerJob[] = [];
	return {
		jobs,
		factory: (_expression: string, _options: CronerFactoryOptions, runner: () => unknown) => {
			const job = new FakeCronerJob(runner);
			jobs.push(job);
			return job;
		},
	};
}

function waitForEvent<TEvent extends SchedulerEventName>(registry: SchedulerRegistry, event: TEvent) {
	return new Promise<SchedulerEventPayloads[TEvent]>(resolve => {
		registry.once(event, resolve);
	});
}

async function flushMicrotasks() {
	for (let index = 0; index < 100; index += 1) await Promise.resolve();
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

function createSeyfertClient(plugins: readonly unknown[]) {
	class TestClient extends HttpClient {
		protected override async execute() {}
	}

	return new TestClient({
		plugins: plugins as never,
		getRC: () => ({
			locations: { base: '.' },
			token: 'scheduler-test-token',
		}),
	});
}

describe('scheduler lifecycle', () => {
	test('memory schedules added after setup recur and run immediately exactly once when requested', async () => {
		const croner = createFakeCroner();
		const registry = createScheduler({ driver: memory({ croner: croner.factory }) });
		const runs: string[] = [];
		await registry.setup({ initialized: true });

		registry.interval('recurring', '1s', () => {
			runs.push('recurring');
		});
		const immediateCompleted = waitForEvent(registry, 'completed');
		registry.interval(
			'immediate',
			'1s',
			() => {
				runs.push('immediate');
			},
			{ runImmediately: true },
		);

		assert.equal(croner.jobs[0]!.paused, false);
		assert.equal(croner.jobs[1]!.paused, false);
		await immediateCompleted;
		assert.deepEqual(runs, ['immediate']);

		await croner.jobs[0]!.trigger();
		await croner.jobs[1]!.trigger();
		assert.deepEqual(runs, ['immediate', 'recurring', 'immediate']);
		assert.equal(registry.get('immediate')?.runCount, 2);
		await registry.close();
	});

	test('real Seyfert lifecycle prepares before downstream setup and activates only at plugins:ready', async () => {
		const bullmq = createFakeBullMQ();
		const schedulerPlugin = scheduler({ driver: persistent({ bullmq: bullmq.module }) });
		let downstreamReady = false;
		let runnerObservedReady = false;
		let processorCompletion: Promise<unknown> | undefined;
		schedulerPlugin.registry.interval('boot', '1s', () => {
			runnerObservedReady = downstreamReady;
		});
		const downstream = createPlugin({
			name: 'scheduler-lifecycle-downstream',
			async setup() {
				assert.equal(bullmq.state.workers[0]!.running, true);
				processorCompletion = Promise.resolve(
					bullmq.state.workers[0]!.processor({ id: 'boot-job', name: 'boot', data: { taskId: 'boot' } }),
				);
				await flushMicrotasks();
				assert.equal(runnerObservedReady, false);
				downstreamReady = true;
			},
		});
		const client = createSeyfertClient(definePlugins(schedulerPlugin, downstream));

		await client.start({ token: 'scheduler-test-token' });
		await processorCompletion;

		assert.equal(runnerObservedReady, true);
		await client.close();
	});

	test('real Seyfert startup rejects persistent preparation failures before plugins:ready', async () => {
		const bullmq = createFakeBullMQ();
		bullmq.state.failUpserts = 1;
		const schedulerPlugin = scheduler({ driver: persistent({ bullmq: bullmq.module }) });
		schedulerPlugin.registry.interval('heartbeat', '30s', () => undefined);
		let downstreamSetup = false;
		const downstream = createPlugin({
			name: 'scheduler-failed-prepare-downstream',
			setup() {
				downstreamSetup = true;
			},
		});
		const client = createSeyfertClient(definePlugins(schedulerPlugin, downstream));

		await assertRejects(() => client.start({ token: 'scheduler-test-token' }), /upsert failed/);

		assert.equal(downstreamSetup, false);
		assert.equal(bullmq.state.workers[0]!.running, false);
		assert.equal(bullmq.state.workers[0]!.closed, true);
	});

	test('driver logger remains the fallback after registry attachment', async () => {
		const bullmq = createFakeBullMQ();
		const warnings: unknown[] = [];
		bullmq.state.jobSchedulers.push({ id: 'old-task' });
		const registry = createScheduler({
			driver: persistent({
				bullmq: bullmq.module,
				logger: {
					warn: (...args: unknown[]) => warnings.push(args),
				},
			}),
		});

		await registry.setup({ initialized: true });

		assert.equal(warnings.length, 1);
		assert.match(String((warnings[0] as unknown[])[1]), /removeOrphan/);
		await registry.close();

		const croner = createFakeCroner();
		const errors: unknown[] = [];
		const memoryRegistry = createScheduler({
			driver: memory({
				croner: croner.factory,
				logger: { error: (...args: unknown[]) => errors.push(args) },
			}),
		});
		memoryRegistry.interval(
			'failing-immediate',
			'1s',
			() => {
				throw new Error('immediate failed');
			},
			{ runImmediately: true },
		);

		await memoryRegistry.setup({ initialized: true });
		await flushMicrotasks();

		assert.equal(errors.length, 1);
		assert.match(String((errors[0] as unknown[])[1]), /failed to run immediate task/);
		await memoryRegistry.close();
	});

	test('Worker.run rejection fails setup before task callbacks activate', async () => {
		const bullmq = createFakeBullMQ();
		bullmq.state.failWorkerRuns = 1;
		const logged: unknown[] = [];
		const registry = createScheduler({
			driver: persistent({ bullmq: bullmq.module }),
			logger: { error: (...args: unknown[]) => logged.push(args) },
		});
		const workerError = waitForEvent(registry, 'error');
		registry.interval('heartbeat', '30s', () => undefined);

		await assertRejects(() => registry.setup({ initialized: true }), /worker run failed/);

		assert.match(String((await workerError).error), /worker run failed/);
		assert.equal(logged.length, 1);
		assert.equal(bullmq.state.workers[0]!.running, false);
		assert.equal(bullmq.state.workers[0]!.closed, true);
		assert.deepEqual(bullmq.state.workerRunErrorListenerCounts, [1]);
		await registry.close();
	});
});
