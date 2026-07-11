import { assert } from 'vitest';
import type { BullJobLike, Queue, QueueEventMap } from '../src';

export function waitForEvent<TData, TResult, TEvent extends keyof QueueEventMap<TData, TResult>>(
	queue: Pick<Queue<TData, TResult>, 'on'>,
	event: TEvent,
): Promise<QueueEventMap<TData, TResult>[TEvent]> {
	return new Promise(resolve => {
		const off = queue.on(event, payload => {
			off();
			resolve(payload);
		});
	});
}

export async function assertRejects(run: () => Promise<unknown>, expected: RegExp) {
	let thrown: unknown;
	try {
		await run();
	} catch (error) {
		thrown = error;
	}

	assert.instanceOf(thrown, Error);
	assert.match((thrown as Error).message, expected);
}

export async function flushQueueEvents() {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

export function createFakeBullMQ(
	options: {
		queueEventsReadiness?: Promise<void>;
		queueReadiness?: Promise<void>;
		readiness?: Promise<void>;
		workerReadiness?: Promise<void>;
	} = {},
) {
	const queues: FakeBullQueue[] = [];
	const workers: FakeBullWorker[] = [];
	const queueEvents: FakeBullQueueEvents[] = [];

	return {
		queueEvents,
		queues,
		workers,
		module: {
			Queue: class extends FakeBullQueue {
				constructor(name: string, constructorOptions: Record<string, unknown>) {
					super(name, constructorOptions, options.queueReadiness ?? options.readiness);
					queues.push(this);
				}
			},
			QueueEvents: class extends FakeBullQueueEvents {
				constructor(name: string, constructorOptions: Record<string, unknown>) {
					super(name, constructorOptions, options.queueEventsReadiness ?? options.readiness);
					queueEvents.push(this);
				}
			},
			Worker: class extends FakeBullWorker {
				constructor(
					name: string,
					processor: (job: FakeBullJob) => unknown,
					constructorOptions: Record<string, unknown>,
				) {
					super(name, processor, constructorOptions, options.workerReadiness ?? options.readiness);
					workers.push(this);
				}
			},
		},
	};
}

export class FakeBullQueue {
	readonly adds: { name: string; data: unknown; options: unknown }[] = [];
	readonly countTypes: string[][] = [];
	readonly delayedScores = new Map<string, number>();
	readonly client = Promise.resolve({
		zscore: async (_key: string, member: string) => this.delayedScores.get(member)?.toString() ?? null,
	});
	jobCounts: Record<string, number> = { active: 0, completed: 0, delayed: 0, failed: 0, waiting: 0 };
	closed = false;
	paused = false;
	resumed = false;
	waitedUntilReady = false;

	constructor(
		readonly name: string,
		readonly options: Record<string, unknown>,
		private readonly readiness?: Promise<void>,
	) {}

	async add(name: string, data: unknown, options: unknown) {
		this.adds.push({ name, data, options });
		const record = options as { delay?: number; jobId?: string };
		return { delay: record.delay ?? 0, id: record.jobId ?? `${name}:1`, name, data, opts: options };
	}

	async getJob(_id: string): Promise<BullJobLike | undefined> {
		return undefined;
	}

	async getJobCounts(...types: string[]) {
		this.countTypes.push(types);
		return this.jobCounts;
	}

	setDelayedRunAt(id: string, timestamp: number) {
		this.delayedScores.set(id, timestamp * 0x1000);
	}

	toKey(type: string) {
		return `fake:${this.name}:${type}`;
	}

	async pause() {
		this.paused = true;
	}

	async resume() {
		this.resumed = true;
	}

	async obliterate() {}

	async close() {
		this.closed = true;
	}

	async waitUntilReady() {
		this.waitedUntilReady = true;
		await this.readiness;
	}
}

export class FakeBullQueueEvents {
	readonly listeners = new Map<string, ((event: unknown) => void)[]>();
	closed = false;
	waitedUntilReady = false;

	constructor(
		readonly name: string,
		readonly options: Record<string, unknown>,
		private readonly readiness?: Promise<void>,
	) {}

	on(event: string, listener: (event: unknown) => void) {
		this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
		return this;
	}

	emit(event: string, payload: unknown) {
		for (const listener of this.listeners.get(event) ?? []) listener(payload);
	}

	async close() {
		this.closed = true;
	}

	async waitUntilReady() {
		this.waitedUntilReady = true;
		await this.readiness;
	}
}

export class FakeBullWorker {
	readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>();
	closed = false;
	paused = false;
	runCalled = false;
	waitedUntilReady = false;

	constructor(
		readonly name: string,
		readonly processor: (job: FakeBullJob) => unknown,
		readonly options: Record<string, unknown>,
		private readonly readiness?: Promise<void>,
	) {}

	on(event: string, listener: (...args: unknown[]) => void) {
		this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
		return this;
	}

	emit(event: string, ...args: unknown[]) {
		for (const listener of this.listeners.get(event) ?? []) listener(...args);
	}

	async close() {
		this.closed = true;
	}

	async pause() {
		this.paused = true;
	}

	async run() {
		this.runCalled = true;
	}

	async waitUntilReady() {
		this.waitedUntilReady = true;
		await this.readiness;
	}
}

export interface FakeBullJob extends BullJobLike {
	id: string;
	name: string;
	data: unknown;
}
