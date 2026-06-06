import { createRequire } from 'node:module';
import type { DurationInput } from '@slipher/internal';
import { isAmbiguousQueueAddArgs, parseDuration, queueAddAmbiguityMessage } from '@slipher/internal';
import './seyfert';

export type { DurationInput } from '@slipher/internal';
export { InvalidDurationError } from '@slipher/internal';

export type Awaitable<T> = T | Promise<T>;
export type JobStatus = 'waiting' | 'delayed' | 'active' | 'completed' | 'failed';
export type QueueEventName = keyof QueueEventMap<unknown, unknown>;
export type WorkerEventName = keyof QueueWorkerEventMap<unknown, unknown>;
export type QueueListener<TPayload> = (payload: TPayload) => void;
export type QueueProcessor<TData, TResult> = (job: QueueJob<TData, TResult, string>) => Awaitable<TResult>;
export type QueueListenerErrorReporter = (event: string, error: unknown) => void;
export interface BackoffOptions {
	type: string;
	delay?: DurationInput;
	[key: string]: unknown;
}
export type RetryDelayResolver<TData, TResult> =
	| DurationInput
	| BackoffOptions
	| ((job: QueueJob<TData, TResult>, error: unknown) => DurationInput);

export interface JobOptions<TData = unknown, TResult = unknown> {
	id?: string;
	delay?: DurationInput;
	attempts?: number;
	priority?: number;
	retryDelay?: RetryDelayResolver<TData, TResult>;
}

export interface QueueOptions<TData = unknown, TResult = unknown> {
	concurrency?: number;
	attempts?: number;
	retryDelay?: RetryDelayResolver<TData, TResult>;
	autostart?: boolean;
	now?: () => number;
	idGenerator?: () => string;
	reportListenerError?: QueueListenerErrorReporter;
}

export interface RegisteredQueues {}

export interface QueueRegistration<TData = unknown, TResult = unknown> {
	data: TData;
	result: TResult;
}

export type RegisteredQueueName = Extract<keyof RegisteredQueues, string>;
type QueueRegisteredData<TName extends string> = TName extends RegisteredQueueName
	? RegisteredQueues[TName] extends { data: infer TData }
		? TData
		: unknown
	: unknown;
type QueueJobName<TData> = TData extends { job: infer TJob extends string } ? TJob : never;
type QueuePayloadFor<TData, TJob extends string> = TData extends { job: TJob } ? Omit<TData, 'job'> : never;
type QueuePayloadUnion<TData> = TData extends { job: string } ? Omit<TData, 'job'> : TData;
export type QueueData<TName extends string> = TName extends RegisteredQueueName
	? QueuePayloadUnion<QueueRegisteredData<TName>>
	: unknown;
export type QueueResult<TName extends string> = TName extends RegisteredQueueName
	? RegisteredQueues[TName] extends { result: infer TResult }
		? TResult
		: unknown
	: unknown;
export type QueueOf<TName extends string> = Queue<QueueData<TName>, QueueResult<TName>, QueueRegisteredData<TName>>;
export type JobNameOf<TName extends string> = QueueJobName<QueueRegisteredData<TName>>;
export type QueueJobOf<TName extends string> =
	JobNameOf<TName> extends never
		? QueueJob<QueueData<TName>, QueueResult<TName>>
		: {
				[TJob in JobNameOf<TName>]: QueueJob<
					QueuePayloadFor<QueueRegisteredData<TName>, TJob>,
					QueueResult<TName>,
					TJob
				> & {
					readonly name: TJob;
				};
			}[JobNameOf<TName>];
export type QueueOptionsOf<TName extends string> = QueueOptions<QueueData<TName>, QueueResult<TName>>;

export interface QueueCounts {
	waiting: number;
	delayed: number;
	active: number;
	completed: number;
	failed: number;
	total: number;
}

export interface QueueJobSnapshot<TData, TResult = unknown> {
	id: string;
	queueName: string;
	data: TData;
	status: JobStatus;
	priority: number;
	attemptsMade: number;
	maxAttempts: number;
	createdAt: Date;
	updatedAt: Date;
	runAt: Date;
	name: string;
	result?: TResult;
	error?: unknown;
}

export interface QueueEventMap<TData, TResult> {
	added: { job: QueueJob<TData, TResult> };
	active: { job: QueueJob<TData, TResult> };
	completed: { job: QueueJob<TData, TResult>; result: TResult };
	failed: { job: QueueJob<TData, TResult>; error: unknown };
	retrying: { job: QueueJob<TData, TResult>; error: unknown; delay: number };
	idle: {};
}

export interface QueueWorkerEventMap<TData, TResult> {
	active: { job: QueueJob<TData, TResult> };
	completed: { job: QueueJob<TData, TResult>; result: TResult };
	failed: { job: QueueJob<TData, TResult>; error: unknown };
	retrying: { job: QueueJob<TData, TResult>; error: unknown; delay: number };
	idle: {};
}

export interface QueueGlobalEventMap<TData, TResult> {
	added: { job: QueueJob<TData, TResult> };
	completed: { job: QueueJob<TData, TResult>; result: TResult };
	failed: { job: QueueJob<TData, TResult>; error: unknown };
}

export interface Queue<TData = unknown, TResult = unknown, TRegisteredData = TData> {
	readonly name: string;
	add<TJobName extends QueueJobName<TRegisteredData>>(
		name: TJobName,
		data: QueuePayloadFor<TRegisteredData, TJobName>,
		options?: JobOptions<TData, TResult>,
	): Awaitable<QueueJob<QueuePayloadFor<TRegisteredData, TJobName>, TResult, TJobName>>;
	add(
		data: QueueJobName<TRegisteredData> extends never ? TData : never,
		options?: JobOptions<TData, TResult>,
	): Awaitable<QueueJob<TData, TResult>>;
	add<TDynamicData = unknown, TDynamicResult = unknown>(
		name: QueueJobName<TRegisteredData> extends never ? string : never,
		data: TDynamicData,
		options?: JobOptions<TDynamicData, TDynamicResult>,
	): Awaitable<QueueJob<TDynamicData, TDynamicResult, string>>;
	process(processor: QueueProcessor<TData, TResult>): this;
	start(): this;
	pause(): this;
	clear(): Awaitable<void>;
	close(): Awaitable<void>;
	counts(): Awaitable<QueueCounts>;
	getJob(id: string): Awaitable<QueueJob<TData, TResult> | undefined>;
	on<TEvent extends keyof QueueEventMap<TData, TResult>>(
		event: TEvent,
		listener: QueueListener<QueueEventMap<TData, TResult>[TEvent]>,
	): () => void;
	once<TEvent extends keyof QueueEventMap<TData, TResult>>(
		event: TEvent,
		listener: QueueListener<QueueEventMap<TData, TResult>[TEvent]>,
	): () => void;
	off<TEvent extends keyof QueueEventMap<TData, TResult>>(
		event: TEvent,
		listener: QueueListener<QueueEventMap<TData, TResult>[TEvent]>,
	): void;
}

export interface QueueDriver {
	get<TName extends RegisteredQueueName>(name: TName, options?: QueueOptionsOf<TName>): QueueOf<TName>;
	get<TData = unknown, TResult = unknown>(name: string, options?: QueueOptions<TData, TResult>): Queue<TData, TResult>;
	setup?(client?: QueuesClientLike): Awaitable<void>;
	close?(): Awaitable<void>;
}

export interface CreateQueuesOptions {
	driver: QueueDriver;
	queueDefaults?: QueueOptions;
	processors?: readonly QueueConstructor[];
	resolve?: <T extends object>(target: QueueConstructor<T>) => T;
	reportListenerError?: QueueListenerErrorReporter;
}

export interface QueuesRegisterOptions {
	processors?: readonly QueueConstructor[];
}

export interface QueuesPluginOptions extends CreateQueuesOptions {}

export interface QueuesPlugin {
	name: string;
	registry: QueuesRegistry;
	options?(current: Readonly<Record<string, unknown>>): QueuesPluginOptionsFragment;
	setup?(client: QueuesClientLike): Awaitable<void>;
	teardown?(client: QueuesClientLike): Awaitable<void>;
}

export interface QueuesPluginOptionsFragment {
	context?(source: unknown): Record<string, unknown>;
}

export interface QueuesClientLike {
	initialized?: boolean;
	queues?: unknown;
}

export interface PersistentQueueOptions {
	bullmq?: BullMQModuleLike;
	connection?: unknown;
	prefix?: string;
	queueOptions?: Record<string, unknown>;
	defaultJobOptions?: Record<string, unknown>;
	workerOptions?: Record<string, unknown>;
}

export interface BullMQModuleLike {
	Queue: new (name: string, options?: Record<string, unknown>) => BullQueueLike;
	Worker: new (
		name: string,
		processor: (job: BullJobLike) => Awaitable<unknown>,
		options?: Record<string, unknown>,
	) => BullWorkerLike;
	QueueEvents?: new (name: string, options?: Record<string, unknown>) => BullQueueEventsLike;
}

export interface BullQueueLike {
	add(name: string, data: unknown, options?: Record<string, unknown>): Awaitable<BullJobLike>;
	getJob?(id: string): Awaitable<BullJobLike | undefined | null>;
	getJobCounts?(): Awaitable<Record<string, number>>;
	pause?(): Awaitable<void>;
	resume?(): Awaitable<void>;
	obliterate?(options?: Record<string, unknown>): Awaitable<void>;
	close?(): Awaitable<void>;
}

export interface BullWorkerLike {
	on?(event: string, listener: (...args: unknown[]) => void): unknown;
	close?(): Awaitable<void>;
}

export interface BullQueueEventsLike {
	on?(event: string, listener: (...args: unknown[]) => void): unknown;
	off?(event: string, listener: (...args: unknown[]) => void): unknown;
	close?(): Awaitable<void>;
}

export interface BullJobLike {
	id?: string | number;
	name?: string;
	data?: unknown;
	opts?: {
		attempts?: number;
		delay?: number;
		jobId?: string;
		priority?: number;
		backoff?: unknown;
	};
	attemptsMade?: number;
	timestamp?: number;
	processedOn?: number;
	finishedOn?: number;
	returnvalue?: unknown;
	failedReason?: string;
}

export type QueueConstructor<T = object> = new (...args: unknown[]) => T;
type QueueMethod = string | symbol;
type DynamicQueueName<TName extends string> = string extends TName
	? TName
	: TName extends RegisteredQueueName
		? never
		: TName;

interface QueueEntry<TData, TResult> {
	job: QueueJob<TData, TResult, string>;
	sequence: number;
}

interface ProcessorMetadata {
	name: string;
	options?: QueueOptions;
}

interface EventMetadata {
	event: QueueEventName | WorkerEventName;
	method: QueueMethod;
	scope: 'queue' | 'worker';
}

const processorMetadata = new WeakMap<Function, ProcessorMetadata>();
const processMetadata = new WeakMap<object, QueueMethod[]>();
const eventMetadata = new WeakMap<object, EventMetadata[]>();

interface QueueWorkerEventSource<TData, TResult> {
	onWorker<TEvent extends keyof QueueWorkerEventMap<TData, TResult>>(
		event: TEvent,
		listener: QueueListener<QueueWorkerEventMap<TData, TResult>[TEvent]>,
	): () => void;
	onceWorker<TEvent extends keyof QueueWorkerEventMap<TData, TResult>>(
		event: TEvent,
		listener: QueueListener<QueueWorkerEventMap<TData, TResult>[TEvent]>,
	): () => void;
	offWorker<TEvent extends keyof QueueWorkerEventMap<TData, TResult>>(
		event: TEvent,
		listener: QueueListener<QueueWorkerEventMap<TData, TResult>[TEvent]>,
	): void;
}

export class QueueJob<TData, TResult = unknown, TName extends string = string> {
	status: JobStatus;
	attemptsMade = 0;
	updatedAt: Date;
	runAt: Date;
	result?: TResult;
	error?: unknown;

	constructor(
		readonly queueName: string,
		readonly id: string,
		readonly data: TData,
		readonly maxAttempts: number,
		readonly priority: number,
		readonly createdAt: Date,
		runAt: Date,
		readonly name: TName,
	) {
		this.runAt = runAt;
		this.updatedAt = createdAt;
		this.status = runAt.getTime() > createdAt.getTime() ? 'delayed' : 'waiting';
	}

	snapshot(): QueueJobSnapshot<TData, TResult> {
		return {
			id: this.id,
			queueName: this.queueName,
			name: this.name,
			data: this.data,
			status: this.status,
			priority: this.priority,
			attemptsMade: this.attemptsMade,
			maxAttempts: this.maxAttempts,
			createdAt: this.createdAt,
			updatedAt: this.updatedAt,
			runAt: this.runAt,
			result: this.result,
			error: this.error,
		};
	}
}

export class QueueEmitter<TData, TResult> {
	private readonly listeners = new Map<string, Set<QueueListener<unknown>>>();
	private readonly workerListeners = new Map<string, Set<QueueListener<unknown>>>();

	constructor(private readonly reportListenerError: QueueListenerErrorReporter = defaultReportListenerError) {}

	on<TEvent extends keyof QueueEventMap<TData, TResult>>(
		event: TEvent,
		listener: QueueListener<QueueEventMap<TData, TResult>[TEvent]>,
	): () => void {
		const listeners = this.listeners.get(event) ?? new Set<QueueListener<unknown>>();
		listeners.add(listener as QueueListener<unknown>);
		this.listeners.set(event, listeners);

		return () => this.off(event, listener);
	}

	once<TEvent extends keyof QueueEventMap<TData, TResult>>(
		event: TEvent,
		listener: QueueListener<QueueEventMap<TData, TResult>[TEvent]>,
	): () => void {
		const off = this.on(event, payload => {
			off();
			listener(payload);
		});
		return off;
	}

	onWorker<TEvent extends keyof QueueWorkerEventMap<TData, TResult>>(
		event: TEvent,
		listener: QueueListener<QueueWorkerEventMap<TData, TResult>[TEvent]>,
	): () => void {
		const listeners = this.workerListeners.get(event) ?? new Set<QueueListener<unknown>>();
		listeners.add(listener as QueueListener<unknown>);
		this.workerListeners.set(event, listeners);

		return () => this.offWorker(event, listener);
	}

	onceWorker<TEvent extends keyof QueueWorkerEventMap<TData, TResult>>(
		event: TEvent,
		listener: QueueListener<QueueWorkerEventMap<TData, TResult>[TEvent]>,
	): () => void {
		const off = this.onWorker(event, payload => {
			off();
			listener(payload);
		});
		return off;
	}

	off<TEvent extends keyof QueueEventMap<TData, TResult>>(
		event: TEvent,
		listener: QueueListener<QueueEventMap<TData, TResult>[TEvent]>,
	): void {
		this.listeners.get(event)?.delete(listener as QueueListener<unknown>);
	}

	offWorker<TEvent extends keyof QueueWorkerEventMap<TData, TResult>>(
		event: TEvent,
		listener: QueueListener<QueueWorkerEventMap<TData, TResult>[TEvent]>,
	): void {
		this.workerListeners.get(event)?.delete(listener as QueueListener<unknown>);
	}

	emit<TEvent extends keyof QueueEventMap<TData, TResult>>(
		event: TEvent,
		payload: QueueEventMap<TData, TResult>[TEvent],
	): void {
		this.emitTo(this.listeners, event, payload);
	}

	emitWorker<TEvent extends keyof QueueWorkerEventMap<TData, TResult>>(
		event: TEvent,
		payload: QueueWorkerEventMap<TData, TResult>[TEvent],
	): void {
		this.emitTo(this.workerListeners, event, payload);
	}

	removeAllListeners(): void {
		this.listeners.clear();
		this.workerListeners.clear();
	}

	private emitTo(listenersByEvent: Map<string, Set<QueueListener<unknown>>>, event: string, payload: unknown): void {
		for (const listener of listenersByEvent.get(event) ?? []) {
			try {
				listener(payload);
			} catch (error) {
				this.reportListenerError(String(event), error);
			}
		}
	}
}

export class MemoryQueue<TData = unknown, TResult = unknown>
	extends QueueEmitter<TData, TResult>
	implements Queue<TData, TResult>
{
	readonly concurrency: number;
	private readonly defaultAttempts: number;
	private readonly retryDelay: RetryDelayResolver<TData, TResult>;
	private readonly now: () => number;
	private readonly idGenerator: () => string;
	private readonly queue: QueueEntry<TData, TResult>[] = [];
	private readonly activeJobs = new Map<string, QueueJob<TData, TResult>>();
	private readonly completedJobs = new Map<string, QueueJob<TData, TResult>>();
	private readonly failedJobs = new Map<string, QueueJob<TData, TResult>>();
	private processor?: QueueProcessor<TData, TResult>;
	private sequence = 0;
	private idle = true;
	private running = false;
	private timer?: ReturnType<typeof setTimeout>;

	constructor(
		readonly name: string,
		options: QueueOptions<TData, TResult> = {},
	) {
		super(options.reportListenerError);
		this.concurrency = options.concurrency ?? 1;
		this.defaultAttempts = options.attempts ?? 1;
		this.retryDelay = options.retryDelay ?? 0;
		this.now = options.now ?? Date.now;
		this.idGenerator = options.idGenerator ?? createJobIdGenerator();

		if (!Number.isInteger(this.concurrency) || this.concurrency <= 0) {
			throw new RangeError('Queue concurrency must be a positive integer.');
		}
		if (!Number.isInteger(this.defaultAttempts) || this.defaultAttempts <= 0) {
			throw new RangeError('Queue attempts must be a positive integer.');
		}
		warnRetryDelayWithoutRetries(options.retryDelay, this.defaultAttempts, `queue "${this.name}"`);
		this.running = options.autostart ?? true;
	}

	add<TJobName extends QueueJobName<TData>>(
		name: TJobName,
		data: QueuePayloadFor<TData, TJobName>,
		options?: JobOptions<TData, TResult>,
	): QueueJob<QueuePayloadFor<TData, TJobName>, TResult, TJobName>;
	add(
		data: QueueJobName<TData> extends never ? TData : never,
		options?: JobOptions<TData, TResult>,
	): QueueJob<TData, TResult>;
	add<TDynamicData = unknown, TDynamicResult = unknown>(
		name: string,
		data: TDynamicData,
		options?: JobOptions<TDynamicData, TDynamicResult>,
	): QueueJob<TDynamicData, TDynamicResult, string>;
	add(nameOrData: unknown, dataOrOptions?: unknown, maybeOptions?: JobOptions): QueueJob<any, any, string> {
		const { data, name, options } = parseQueueAddArgs<TData, TResult>(nameOrData, dataOrOptions, maybeOptions);
		const now = this.now();
		const delay = parseDuration(options.delay ?? 0);
		const attempts = options.attempts ?? this.defaultAttempts;
		if (!Number.isInteger(attempts) || attempts <= 0) throw new RangeError('Job attempts must be a positive integer.');
		warnRetryDelayWithoutRetries(options.retryDelay, attempts, `job "${name}" on queue "${this.name}"`);
		const jobId = options.id ?? this.generateJobId();
		if (this.getJob(jobId)) throw new RangeError(`Job with id "${jobId}" already exists.`);

		const job = new QueueJob<TData, TResult, string>(
			this.name,
			jobId,
			data,
			attempts,
			options.priority ?? 0,
			new Date(now),
			new Date(now + delay),
			name,
		);

		this.idle = false;
		this.enqueue(job);
		this.emit('added', { job });
		this.schedule();
		return job;
	}

	process(processor: QueueProcessor<TData, TResult>): this {
		this.processor = processor;
		this.running = true;
		this.schedule();
		return this;
	}

	start(): this {
		this.running = true;
		this.schedule();
		return this;
	}

	pause(): this {
		this.running = false;
		this.clearTimer();
		return this;
	}

	clear(): void {
		if (this.activeJobs.size > 0) throw new RangeError('Cannot clear a queue while jobs are active.');
		this.queue.length = 0;
		this.completedJobs.clear();
		this.failedJobs.clear();
		this.idle = true;
		this.clearTimer();
	}

	close(): void {
		this.clearTimer();
		this.removeAllListeners();
	}

	counts(): QueueCounts {
		let waiting = 0;
		let delayed = 0;
		const now = this.now();

		for (const { job } of this.queue) {
			if (job.runAt.getTime() > now) delayed++;
			else waiting++;
		}

		return {
			waiting,
			delayed,
			active: this.activeJobs.size,
			completed: this.completedJobs.size,
			failed: this.failedJobs.size,
			total: this.queue.length + this.activeJobs.size + this.completedJobs.size + this.failedJobs.size,
		};
	}

	getJob(id: string): QueueJob<TData, TResult> | undefined {
		return (
			this.activeJobs.get(id) ??
			this.completedJobs.get(id) ??
			this.failedJobs.get(id) ??
			this.queue.find(entry => entry.job.id === id)?.job
		);
	}

	private enqueue(job: QueueJob<TData, TResult>): void {
		job.status = job.runAt.getTime() > this.now() ? 'delayed' : 'waiting';
		job.updatedAt = new Date(this.now());
		this.queue.push({ job, sequence: this.sequence++ });
		this.sortQueue();
	}

	private sortQueue(): void {
		const now = this.now();
		this.queue.sort((a, b) => {
			const aReady = a.job.runAt.getTime() <= now;
			const bReady = b.job.runAt.getTime() <= now;
			if (aReady !== bReady) return aReady ? -1 : 1;

			if (!(aReady && bReady)) {
				const byRunAt = a.job.runAt.getTime() - b.job.runAt.getTime();
				if (byRunAt !== 0) return byRunAt;
			}

			const byPriority = b.job.priority - a.job.priority;
			if (byPriority !== 0) return byPriority;
			return a.sequence - b.sequence;
		});
	}

	private schedule(): void {
		this.clearTimer();
		if (!(this.running && this.processor)) return;

		this.sortQueue();
		this.drainReadyJobs();
		if (this.activeJobs.size >= this.concurrency) return;

		const next = this.queue[0];
		if (!next) {
			if (this.activeJobs.size === 0 && !this.idle) {
				this.idle = true;
				this.emit('idle', {});
				this.emitWorker('idle', {});
			}
			return;
		}

		const delay = Math.max(next.job.runAt.getTime() - this.now(), 0);
		this.timer = setTimeout(() => this.schedule(), delay);
	}

	private drainReadyJobs(): void {
		while (this.activeJobs.size < this.concurrency) {
			const next = this.queue[0];
			if (!next || next.job.runAt.getTime() > this.now()) break;

			this.queue.shift();
			void this.run(next.job);
		}
	}

	private async run(job: QueueJob<TData, TResult>): Promise<void> {
		if (!this.processor) return;
		job.status = 'active';
		job.attemptsMade++;
		job.updatedAt = new Date(this.now());
		this.activeJobs.set(job.id, job);
		this.emit('active', { job });
		this.emitWorker('active', { job });
		let completedResult: TResult | undefined;
		let completed = false;
		let failedError: unknown;

		try {
			const result = await this.processor(job);
			completedResult = result;
			completed = true;
			job.error = undefined;
			job.result = result;
			job.status = 'completed';
			job.updatedAt = new Date(this.now());
			this.completedJobs.set(job.id, job);
		} catch (error) {
			job.error = error;
			job.updatedAt = new Date(this.now());

			if (job.attemptsMade < job.maxAttempts) {
				let delay: number;
				try {
					delay = this.resolveRetryDelay(job, error);
				} catch (retryError) {
					failedError = new AggregateError(
						[error, retryError],
						'Queue job failed and retry delay resolution also failed.',
					);
					this.failJob(job, failedError);
					return;
				}

				job.runAt = new Date(this.now() + delay);
				this.idle = false;
				this.emit('retrying', { delay, error, job });
				this.emitWorker('retrying', { delay, error, job });
				this.enqueue(job);
			} else {
				this.failJob(job, error);
				failedError = error;
			}
		} finally {
			this.activeJobs.delete(job.id);
			if (completed) {
				this.emit('completed', { job, result: completedResult as TResult });
				this.emitWorker('completed', { job, result: completedResult as TResult });
			} else if (failedError !== undefined) {
				this.emit('failed', { error: failedError, job });
				this.emitWorker('failed', { error: failedError, job });
			}
			this.schedule();
		}
	}

	private resolveRetryDelay(job: QueueJob<TData, TResult>, error: unknown): number {
		const delay = typeof this.retryDelay === 'function' ? this.retryDelay(job, error) : this.retryDelay;
		return resolveRetryDelayValue(delay, job.attemptsMade);
	}

	private failJob(job: QueueJob<TData, TResult>, error: unknown): void {
		job.error = error;
		job.status = 'failed';
		job.updatedAt = new Date(this.now());
		this.failedJobs.set(job.id, job);
	}

	private generateJobId(): string {
		for (let attempt = 0; attempt < 1000; attempt++) {
			const id = this.idGenerator();
			if (!this.getJob(id)) return id;
		}

		throw new RangeError('Unable to generate a unique job id.');
	}

	private clearTimer(): void {
		if (!this.timer) return;
		clearTimeout(this.timer);
		this.timer = undefined;
	}
}

export class MemoryQueueDriver implements QueueDriver {
	private readonly queues = new Map<string, MemoryQueue<unknown, unknown>>();

	constructor(private readonly defaults: QueueOptions = {}) {}

	get<TName extends RegisteredQueueName>(name: TName, options?: QueueOptionsOf<TName>): QueueOf<TName>;
	get<TData = unknown, TResult = unknown>(name: string, options?: QueueOptions<TData, TResult>): Queue<TData, TResult>;
	get<TData = unknown, TResult = unknown>(
		name: string,
		options: QueueOptions<TData, TResult> = {},
	): Queue<TData, TResult> {
		const existing = this.queues.get(name);
		if (existing) return existing as Queue<TData, TResult>;

		const queue = new MemoryQueue<TData, TResult>(name, { ...this.defaults, ...options });
		this.queues.set(name, queue as MemoryQueue<unknown, unknown>);
		return queue;
	}

	close(): void {
		for (const queue of this.queues.values()) queue.close();
		this.queues.clear();
	}
}

export class PersistentQueue<TData = unknown, TResult = unknown>
	extends QueueEmitter<TData, TResult>
	implements Queue<TData, TResult>
{
	private queue?: BullQueueLike;
	private worker?: BullWorkerLike;
	private queueEvents?: BullQueueEventsLike;
	private processor?: QueueProcessor<TData, TResult>;
	private state: 'pending' | 'ready' | 'closed' = 'pending';

	constructor(
		readonly name: string,
		private readonly bullmq: BullMQModuleLike,
		private readonly baseOptions: PersistentQueueOptions,
		private readonly options: QueueOptions<TData, TResult> = {},
	) {
		super(options.reportListenerError);
	}

	setup(client?: QueuesClientLike): void {
		if (this.state === 'ready') return;
		this.rejectUnsupportedRetryDelay(this.options.retryDelay);
		warnRetryDelayWithoutRetries(this.options.retryDelay, this.options.attempts ?? 1, `queue "${this.name}"`);
		this.state = 'ready';
		this.queue = new this.bullmq.Queue(this.name, this.baseQueueOptions());
		if (this.bullmq.QueueEvents) {
			this.queueEvents = new this.bullmq.QueueEvents(this.name, this.baseQueueOptions());
			this.wireQueueEvents();
		}
		if (this.processor) this.createWorker(client);
	}

	add<TJobName extends QueueJobName<TData>>(
		name: TJobName,
		data: QueuePayloadFor<TData, TJobName>,
		options?: JobOptions<TData, TResult>,
	): Promise<QueueJob<QueuePayloadFor<TData, TJobName>, TResult, TJobName>>;
	add(
		data: QueueJobName<TData> extends never ? TData : never,
		options?: JobOptions<TData, TResult>,
	): Promise<QueueJob<TData, TResult>>;
	add<TDynamicData = unknown, TDynamicResult = unknown>(
		name: string,
		data: TDynamicData,
		options?: JobOptions<TDynamicData, TDynamicResult>,
	): Promise<QueueJob<TDynamicData, TDynamicResult, string>>;
	async add(
		nameOrData: unknown,
		dataOrOptions?: unknown,
		maybeOptions?: JobOptions,
	): Promise<QueueJob<any, any, string>> {
		const queue = this.requireQueue();
		const { data, name, options } = parseQueueAddArgs<TData, TResult>(nameOrData, dataOrOptions, maybeOptions);
		this.rejectUnsupportedRetryDelay(options.retryDelay);
		warnRetryDelayWithoutRetries(
			options.retryDelay ?? this.options.retryDelay,
			options.attempts ?? this.options.attempts ?? 1,
			`job "${name}" on queue "${this.name}"`,
		);
		const bullOptions = this.buildJobOptions(options);
		const bullJob = await queue.add(name, data, bullOptions);
		const job = this.fromBullJob(bullJob, data, name, options);
		this.emit('added', { job });
		return job;
	}

	process(processor: QueueProcessor<TData, TResult>): this {
		this.processor = processor;
		if (this.state === 'ready') this.createWorker();
		return this;
	}

	start(): this {
		void this.requireQueue().resume?.();
		return this;
	}

	pause(): this {
		void this.requireQueue().pause?.();
		return this;
	}

	async clear(): Promise<void> {
		await this.requireQueue().obliterate?.({ force: true });
	}

	async close(): Promise<void> {
		await this.worker?.close?.();
		await this.queueEvents?.close?.();
		await this.queue?.close?.();
		this.worker = undefined;
		this.queueEvents = undefined;
		this.queue = undefined;
		this.state = 'closed';
		this.removeAllListeners();
	}

	async counts(): Promise<QueueCounts> {
		const counts = (await this.requireQueue().getJobCounts?.()) ?? {};
		const waiting = counts.waiting ?? 0;
		const delayed = counts.delayed ?? 0;
		const active = counts.active ?? 0;
		const completed = counts.completed ?? 0;
		const failed = counts.failed ?? 0;

		return {
			waiting,
			delayed,
			active,
			completed,
			failed,
			total: waiting + delayed + active + completed + failed,
		};
	}

	async getJob(id: string): Promise<QueueJob<TData, TResult> | undefined> {
		const bullJob = await this.requireQueue().getJob?.(id);
		return bullJob ? this.fromBullJob(bullJob) : undefined;
	}

	private async processBullJob(bullJob: BullJobLike): Promise<TResult> {
		if (!this.processor) throw new Error('Queue processor is not configured.');

		const job = this.fromBullJob(bullJob);
		job.status = 'active';
		this.emit('active', { job });
		this.emitWorker('active', { job });
		let completedResult: TResult | undefined;
		let completed = false;
		let failedError: unknown;

		try {
			const result = await this.processor(job);
			completedResult = result;
			completed = true;
			job.status = 'completed';
			job.result = result;
			job.updatedAt = new Date();
			return result;
		} catch (error) {
			failedError = error;
			job.status = 'failed';
			job.error = error;
			job.updatedAt = new Date();
			throw error;
		} finally {
			if (completed) {
				this.emitWorker('completed', { job, result: completedResult as TResult });
				if (!this.queueEvents) this.emit('completed', { job, result: completedResult as TResult });
			} else if (failedError !== undefined) {
				this.emitWorker('failed', { error: failedError, job });
				if (!this.queueEvents) this.emit('failed', { error: failedError, job });
			}
		}
	}

	private fromBullJob(
		bullJob: BullJobLike,
		data?: TData,
		name = bullJob.name ?? 'default',
		options: JobOptions<TData, TResult> = {},
	): QueueJob<TData, TResult, string> {
		const createdAt = new Date(bullJob.timestamp ?? Date.now());
		const runAt = new Date(createdAt.getTime() + (bullJob.opts?.delay ?? parseDuration(options.delay ?? 0)));
		const job = new QueueJob<TData, TResult, string>(
			this.name,
			String(options.id ?? bullJob.id ?? bullJob.opts?.jobId ?? ''),
			(data ?? bullJob.data) as TData,
			options.attempts ?? bullJob.opts?.attempts ?? this.options.attempts ?? 1,
			options.priority ?? bullJob.opts?.priority ?? 0,
			createdAt,
			runAt,
			name,
		);
		job.attemptsMade = bullJob.attemptsMade ?? 0;
		job.updatedAt = new Date(bullJob.finishedOn ?? bullJob.processedOn ?? bullJob.timestamp ?? Date.now());
		if (bullJob.returnvalue !== undefined) {
			job.result = bullJob.returnvalue as TResult;
			job.status = 'completed';
		}
		if (bullJob.failedReason !== undefined) {
			job.error = new Error(bullJob.failedReason);
			job.status = 'failed';
		}
		return job;
	}

	private baseQueueOptions(): Record<string, unknown> {
		return stripUndefined({
			connection: this.baseOptions.connection,
			prefix: this.baseOptions.prefix,
			...this.baseOptions.queueOptions,
			defaultJobOptions: this.baseOptions.defaultJobOptions,
		});
	}

	private baseWorkerOptions(): Record<string, unknown> {
		return stripUndefined({
			connection: this.baseOptions.connection,
			concurrency: this.options.concurrency,
			prefix: this.baseOptions.prefix,
			...this.baseOptions.workerOptions,
		});
	}

	private buildJobOptions(options: JobOptions<TData, TResult>): Record<string, unknown> {
		const retryDelay = options.retryDelay ?? this.options.retryDelay;
		const backoff = retryDelay === undefined ? undefined : this.resolvePersistentBackoff(retryDelay);
		return stripUndefined({
			...this.baseOptions.defaultJobOptions,
			attempts: options.attempts ?? this.options.attempts,
			delay: parseDuration(options.delay ?? 0),
			jobId: options.id,
			priority: options.priority,
			backoff,
		});
	}

	private resolvePersistentBackoff(retryDelay: RetryDelayResolver<TData, TResult>): unknown {
		if (typeof retryDelay === 'function') this.rejectUnsupportedRetryDelay(retryDelay);
		if (typeof retryDelay === 'object') return normalizeBackoffOptions(retryDelay);
		return { type: 'fixed', delay: parseDuration(retryDelay) };
	}

	private rejectUnsupportedRetryDelay(
		retryDelay: RetryDelayResolver<TData, TResult> | undefined,
	): asserts retryDelay is Exclude<RetryDelayResolver<TData, TResult>, Function> {
		if (typeof retryDelay !== 'function') return;
		throw new Error(
			`@slipher/queues persistent driver does not support function-form retryDelay on queue "${this.name}". Use a static duration or a BullMQ backoff config object.`,
		);
	}

	private createWorker(client?: QueuesClientLike): void {
		void this.worker?.close?.();
		this.worker = new this.bullmq.Worker(
			this.name,
			job => {
				if (client?.initialized === false) {
					defaultReportListenerError(
						`${this.name}:worker`,
						new Error(`Skipped queue job for "${this.name}" because the Seyfert client is not initialized.`),
					);
					return undefined;
				}
				return this.processBullJob(job);
			},
			this.baseWorkerOptions(),
		);
	}

	private wireQueueEvents(): void {
		this.queueEvents?.on?.('completed', event => {
			void this.emitQueueCompleted(event);
		});
		this.queueEvents?.on?.('failed', event => {
			void this.emitQueueFailed(event);
		});
	}

	private async emitQueueCompleted(event: unknown): Promise<void> {
		try {
			const record = eventRecord(event);
			const job = await this.jobFromQueueEvent(record);
			const result = (record.returnvalue ?? job.result) as TResult;
			this.emit('completed', { job, result });
		} catch (error) {
			defaultReportListenerError(`${this.name}:completed`, error);
		}
	}

	private async emitQueueFailed(event: unknown): Promise<void> {
		try {
			const record = eventRecord(event);
			const job = await this.jobFromQueueEvent(record);
			const error = job.error ?? new Error(String(record.failedReason ?? 'Queue job failed.'));
			this.emit('failed', { error, job });
		} catch (error) {
			defaultReportListenerError(`${this.name}:failed`, error);
		}
	}

	private async jobFromQueueEvent(record: Record<string, unknown>): Promise<QueueJob<TData, TResult, string>> {
		const id = String(record.jobId ?? record.id ?? '');
		const bullJob = id ? await this.queue?.getJob?.(id) : undefined;
		if (bullJob) return this.fromBullJob(bullJob);

		return this.fromBullJob({
			data: record.data,
			failedReason: typeof record.failedReason === 'string' ? record.failedReason : undefined,
			id,
			name: typeof record.name === 'string' ? record.name : 'default',
			returnvalue: record.returnvalue,
		});
	}

	private requireQueue(): BullQueueLike {
		if (this.queue) return this.queue;
		if (this.state === 'closed') throw new Error(`Queue "${this.name}" has been stopped.`);
		throw new Error(`Queue "${this.name}" is not initialized; await client.start() before producing jobs.`);
	}
}

export class PersistentQueueDriver implements QueueDriver {
	private readonly bullmq: BullMQModuleLike;
	private readonly queues = new Map<string, PersistentQueue<unknown, unknown>>();

	constructor(private readonly options: PersistentQueueOptions = {}) {
		this.bullmq = options.bullmq ?? loadBullMQ();
	}

	get<TName extends RegisteredQueueName>(name: TName, options?: QueueOptionsOf<TName>): QueueOf<TName>;
	get<TData = unknown, TResult = unknown>(name: string, options?: QueueOptions<TData, TResult>): Queue<TData, TResult>;
	get<TData = unknown, TResult = unknown>(
		name: string,
		options: QueueOptions<TData, TResult> = {},
	): Queue<TData, TResult> {
		const existing = this.queues.get(name);
		if (existing) return existing as Queue<TData, TResult>;

		const queue = new PersistentQueue<TData, TResult>(name, this.bullmq, this.options, options);
		this.queues.set(name, queue as PersistentQueue<unknown, unknown>);
		return queue;
	}

	setup(client?: QueuesClientLike): void {
		for (const queue of this.queues.values()) queue.setup(client);
	}

	async close(): Promise<void> {
		await Promise.all([...this.queues.values()].map(queue => queue.close()));
		this.queues.clear();
	}
}

export class QueuesRegistry {
	private readonly queues = new Map<string, Queue<unknown, unknown>>();
	private readonly queueOptionFingerprints = new Map<string, string | undefined>();

	constructor(private readonly options: CreateQueuesOptions) {
		if (options.processors?.length) this.register({ processors: options.processors });
	}

	register(options: QueuesRegisterOptions): this {
		for (const processor of options.processors ?? []) this.registerProcessor(processor);
		return this;
	}

	get<TName extends RegisteredQueueName>(name: TName, options?: QueueOptionsOf<TName>): QueueOf<TName>;
	get<TData = unknown, TResult = unknown>(name: string, options?: QueueOptions<TData, TResult>): Queue<TData, TResult>;
	get<TData = unknown, TResult = unknown>(name: string, options?: QueueOptions<TData, TResult>): Queue<TData, TResult> {
		return this.getOrCreateQueue(name, options);
	}

	async add<TName extends RegisteredQueueName, TJobName extends JobNameOf<TName>>(
		queueName: TName,
		name: TJobName,
		data: QueuePayloadFor<QueueRegisteredData<TName>, TJobName>,
		options?: JobOptions,
	): Promise<QueueJobOf<TName>>;
	async add<TName extends RegisteredQueueName>(
		queueName: TName,
		data: QueueData<TName>,
		options?: JobOptions,
	): Promise<QueueJobOf<TName>>;
	async add<const TName extends string, TData = unknown, TResult = unknown>(
		queueName: DynamicQueueName<TName>,
		data: TData,
		options?: JobOptions,
	): Promise<QueueJob<TData, TResult>>;
	async add(
		queueName: string,
		nameOrData: unknown,
		dataOrOptions?: unknown,
		maybeOptions?: JobOptions,
	): Promise<QueueJob<any, any, string>> {
		if (isAmbiguousQueueAddArgs(nameOrData, dataOrOptions, maybeOptions)) {
			throw new TypeError(queueAddAmbiguityMessage);
		}

		if (typeof nameOrData === 'string' && dataOrOptions !== undefined) {
			return this.get(queueName).add(nameOrData, dataOrOptions, maybeOptions);
		}

		return this.get(queueName).add(nameOrData as never, dataOrOptions as JobOptions | undefined);
	}

	async close(): Promise<void> {
		if (this.options.driver.close) await this.options.driver.close();
		else await Promise.all([...this.queues.values()].map(queue => queue.close()));
		this.queues.clear();
		this.queueOptionFingerprints.clear();
	}

	async setup(client?: QueuesClientLike): Promise<void> {
		await this.options.driver.setup?.(client);
	}

	private registerProcessor(processor: QueueConstructor): void {
		const metadata = processorMetadata.get(processor);
		if (!metadata) throw new RangeError(`Queue processor metadata missing for ${processor.name}.`);

		const instance = this.instantiate(processor);
		const prototype = processor.prototype;
		const queue = this.getOrCreateQueue(metadata.name, metadata.options);
		const processes = processMetadata.get(prototype) ?? [];
		if (processes.length !== 1) {
			throw new RangeError(`Queue processor "${metadata.name}" must declare exactly one @Process() handler.`);
		}

		const handler = this.getMethod(instance, processes[0]);

		for (const event of eventMetadata.get(prototype) ?? []) {
			const handler = this.getMethod(instance, event.method);
			const listener = (payload: unknown) => {
				handler.call(instance, payload);
			};

			if (event.scope === 'worker') {
				const workerEvents = getWorkerEventSource(queue);
				if (workerEvents) workerEvents.onWorker(event.event as WorkerEventName, listener);
				else queue.on(event.event as keyof QueueEventMap<unknown, unknown>, listener);
				continue;
			}

			queue.on(event.event as keyof QueueEventMap<unknown, unknown>, listener);
		}

		queue.process(job => {
			return handler(job as QueueJob<unknown, unknown>);
		});
	}

	private getOrCreateQueue<TData = unknown, TResult = unknown>(
		name: string,
		options?: QueueOptions<TData, TResult>,
	): Queue<TData, TResult> {
		const mergedOptions = { ...this.options.queueDefaults, ...(options ?? {}) };
		const fingerprint = fingerprintQueueOptions(mergedOptions);
		const existing = this.queues.get(name);
		if (existing) {
			const existingFingerprint = this.queueOptionFingerprints.get(name);
			if (options !== undefined && existingFingerprint !== undefined && existingFingerprint !== fingerprint) {
				throw new RangeError(`Queue already registered with different options: ${name}`);
			}
			return existing as Queue<TData, TResult>;
		}

		const queue = this.options.driver.get<TData, TResult>(name, mergedOptions as QueueOptions<TData, TResult>);
		this.queues.set(name, queue as Queue<unknown, unknown>);
		this.queueOptionFingerprints.set(name, options === undefined ? undefined : fingerprint);
		return queue;
	}

	private instantiate<T extends object>(target: QueueConstructor<T>): T {
		if (this.options.resolve) return this.options.resolve(target);

		return new target();
	}

	private getMethod(instance: object, method: QueueMethod): (...args: readonly unknown[]) => unknown {
		const value = (instance as Record<QueueMethod, unknown>)[method];
		if (typeof value !== 'function') throw new TypeError(`Queue method is not callable: ${String(method)}`);
		return value as (...args: readonly unknown[]) => unknown;
	}
}

export function createQueues(options: CreateQueuesOptions): QueuesRegistry {
	return new QueuesRegistry(options);
}

export function queues(options: QueuesPluginOptions): QueuesPlugin {
	const registry = createQueues(options);

	return {
		name: '@slipher/queues',
		registry,
		options: () => ({
			context: () => ({ queues: registry }),
		}),
		setup: async client => {
			installQueues(client, registry);
			await registry.setup(client);
		},
		teardown: async () => {
			await registry.close();
		},
	};
}

export function installQueues<TClient extends QueuesClientLike>(
	client: TClient,
	registry: QueuesRegistry,
): QueuesRegistry {
	client.queues = registry;
	return registry;
}

export function memory(options: QueueOptions = {}): QueueDriver {
	return new MemoryQueueDriver(options);
}

export function persistent(options: PersistentQueueOptions = {}): QueueDriver {
	return new PersistentQueueDriver(options);
}

export function Processor<TName extends RegisteredQueueName>(
	name: TName,
	options?: QueueOptionsOf<TName>,
): ClassDecorator;
export function Processor<TData = unknown, TResult = unknown>(
	name: string,
	options?: QueueOptions<TData, TResult>,
): ClassDecorator;
export function Processor(name: string, options?: QueueOptions): ClassDecorator {
	return target => {
		processorMetadata.set(target, { name, options });
	};
}

export function Process(): MethodDecorator {
	return (target, key) => {
		const metadata = processMetadata.get(target) ?? [];
		metadata.push(key);
		processMetadata.set(target, metadata);
	};
}

export function OnQueueEvent(event: QueueEventName): MethodDecorator {
	return (target, key) => {
		const metadata = eventMetadata.get(target) ?? [];
		metadata.push({ event, method: key, scope: 'queue' });
		eventMetadata.set(target, metadata);
	};
}

export const QueueEvent = OnQueueEvent;

export function OnWorkerEvent(event: WorkerEventName): MethodDecorator {
	return (target, key) => {
		const metadata = eventMetadata.get(target) ?? [];
		metadata.push({ event, method: key, scope: 'worker' });
		eventMetadata.set(target, metadata);
	};
}

function createJobIdGenerator() {
	let nextId = 0;
	return () => String(++nextId);
}

function loadBullMQ(): BullMQModuleLike {
	try {
		const require = createRequire(__filename);
		return require('bullmq') as BullMQModuleLike;
	} catch (error) {
		throw new Error(
			'The persistent() queue driver requires bullmq. Install bullmq or pass a structural bullmq module.',
			{
				cause: error,
			},
		);
	}
}

function getWorkerEventSource<TData, TResult>(
	queue: Queue<TData, TResult>,
): QueueWorkerEventSource<TData, TResult> | undefined {
	const candidate = queue as unknown as QueueWorkerEventSource<TData, TResult>;
	return typeof candidate.onWorker === 'function' ? candidate : undefined;
}

function parseQueueAddArgs<TData, TResult>(
	nameOrData: unknown,
	dataOrOptions?: unknown,
	maybeOptions?: JobOptions<TData, TResult>,
): { data: TData; name: string; options: JobOptions<TData, TResult> } {
	if (isAmbiguousQueueAddArgs(nameOrData, dataOrOptions, maybeOptions)) {
		throw new TypeError(queueAddAmbiguityMessage);
	}

	if (typeof nameOrData === 'string' && dataOrOptions !== undefined) {
		return {
			data: dataOrOptions as TData,
			name: nameOrData,
			options: maybeOptions ?? {},
		};
	}

	return {
		data: nameOrData as TData,
		name: 'default',
		options: (dataOrOptions ?? {}) as JobOptions<TData, TResult>,
	};
}

function resolveRetryDelayValue(
	value: Exclude<RetryDelayResolver<unknown, unknown>, Function>,
	attemptsMade: number,
): number {
	if (typeof value !== 'object') return parseDuration(value);
	const backoff = normalizeBackoffOptions(value);
	const delay = parseDuration(backoff.delay ?? 0);
	if (backoff.type === 'exponential') return delay * 2 ** Math.max(attemptsMade - 1, 0);
	return delay;
}

function normalizeBackoffOptions(value: BackoffOptions): BackoffOptions {
	return {
		...value,
		delay: value.delay === undefined ? undefined : parseDuration(value.delay),
	};
}

function warnRetryDelayWithoutRetries<TData, TResult>(
	retryDelay: RetryDelayResolver<TData, TResult> | undefined,
	attempts: number,
	scope: string,
): void {
	if (retryDelay === undefined || attempts > 1) return;
	process.emitWarning?.(`${scope} defines retryDelay but attempts is ${attempts}; no retries will be scheduled.`, {
		code: 'SLIPHER_QUEUE_RETRY_DELAY_NO_RETRIES',
	});
}

function defaultReportListenerError(event: string, error: unknown): void {
	const reason = error instanceof Error ? error.message : String(error);
	process.emitWarning?.(`Queue listener for "${event}" failed: ${reason}`, {
		code: 'SLIPHER_QUEUE_LISTENER_ERROR',
	});
}

function eventRecord(event: unknown): Record<string, unknown> {
	return event && typeof event === 'object' ? (event as Record<string, unknown>) : {};
}

function fingerprintQueueOptions(options: QueueOptions<any, any>): string {
	return JSON.stringify({
		concurrency: options.concurrency,
		attempts: options.attempts,
		retryDelay: typeof options.retryDelay === 'function' ? '[function]' : options.retryDelay,
		autostart: options.autostart,
		now: options.now ? '[function]' : undefined,
		idGenerator: options.idGenerator ? '[function]' : undefined,
	});
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
	for (const key of Object.keys(value)) {
		if (value[key] === undefined) delete value[key];
	}
	return value;
}
