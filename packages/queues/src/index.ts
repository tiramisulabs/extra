import { createRequire } from 'node:module';

export type Awaitable<T> = T | Promise<T>;
export type DurationInput = number | string;
export type JobStatus = 'waiting' | 'delayed' | 'active' | 'completed' | 'failed';
export type QueueEventName = keyof QueueEventMap<unknown, unknown>;
export type QueueListener<TArgs extends readonly unknown[]> = (...args: TArgs) => void;
export type QueueProcessor<TData, TResult> = (job: QueueJob<TData, TResult>) => Awaitable<TResult>;
export type RetryDelayResolver<TData, TResult> =
	| DurationInput
	| ((job: QueueJob<TData, TResult>, error: unknown) => DurationInput);

export interface JobOptions {
	id?: string;
	name?: string;
	delay?: DurationInput;
	attempts?: number;
	priority?: number;
}

export interface QueueOptions<TData = unknown, TResult = unknown> {
	concurrency?: number;
	attempts?: number;
	retryDelay?: RetryDelayResolver<TData, TResult>;
	autostart?: boolean;
	now?: () => number;
	idGenerator?: () => string;
}

export interface RegisteredQueues {}

export interface QueueRegistration<TData = unknown, TResult = unknown> {
	data: TData;
	result: TResult;
}

export type RegisteredQueueName = Extract<keyof RegisteredQueues, string>;
export type QueueData<TName extends string> = TName extends RegisteredQueueName
	? RegisteredQueues[TName] extends { data: infer TData }
		? TData
		: unknown
	: unknown;
export type QueueResult<TName extends string> = TName extends RegisteredQueueName
	? RegisteredQueues[TName] extends { result: infer TResult }
		? TResult
		: unknown
	: unknown;
export type QueueOf<TName extends string> = Queue<QueueData<TName>, QueueResult<TName>>;
export type QueueJobOf<TName extends string> = QueueJob<QueueData<TName>, QueueResult<TName>>;
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
	name?: string;
	result?: TResult;
	error?: unknown;
}

export interface QueueEventMap<TData, TResult> {
	added: [job: QueueJob<TData, TResult>];
	active: [job: QueueJob<TData, TResult>];
	completed: [job: QueueJob<TData, TResult>, result: TResult];
	failed: [job: QueueJob<TData, TResult>, error: unknown];
	retrying: [job: QueueJob<TData, TResult>, error: unknown, delay: number];
	idle: [];
}

export interface Queue<TData = unknown, TResult = unknown> {
	readonly name: string;
	add(data: TData, options?: JobOptions): Awaitable<QueueJob<TData, TResult>>;
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
	off<TEvent extends keyof QueueEventMap<TData, TResult>>(
		event: TEvent,
		listener: QueueListener<QueueEventMap<TData, TResult>[TEvent]>,
	): void;
}

export interface QueueDriver {
	get<TName extends RegisteredQueueName>(name: TName, options?: QueueOptionsOf<TName>): QueueOf<TName>;
	get<TData = unknown, TResult = unknown>(name: string, options?: QueueOptions<TData, TResult>): Queue<TData, TResult>;
	close?(): Awaitable<void>;
}

export interface CreateQueuesOptions {
	driver: QueueDriver;
	queueDefaults?: QueueOptions;
	processors?: readonly QueueConstructor[];
	producers?: readonly QueueConstructor[];
	resolve?: <T extends object>(target: QueueConstructor<T>) => T;
}

export interface QueuesRegisterOptions {
	processors?: readonly QueueConstructor[];
	producers?: readonly QueueConstructor[];
}

export interface QueuesPluginOptions extends CreateQueuesOptions {}

export interface QueuesPlugin {
	name: string;
	registry: QueuesRegistry;
	options?(current: Readonly<Record<string, unknown>>): QueuesPluginOptionsFragment;
	setup?(client: QueuesClientLike): Awaitable<void>;
}

export interface QueuesPluginOptionsFragment {
	context?(source: unknown): Record<string, unknown>;
}

export interface QueuesClientLike {
	queues?: unknown;
}

export interface PersistentQueueOptions {
	bullmq?: BullMQModuleLike;
	connection?: unknown;
	prefix?: string;
	queueOptions?: Record<string, unknown>;
	workerOptions?: Record<string, unknown>;
}

export interface BullMQModuleLike {
	Queue: new (name: string, options?: Record<string, unknown>) => BullQueueLike;
	Worker: new (
		name: string,
		processor: (job: BullJobLike) => Awaitable<unknown>,
		options?: Record<string, unknown>,
	) => BullWorkerLike;
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

export interface BullJobLike {
	id?: string | number;
	name?: string;
	data?: unknown;
	opts?: {
		attempts?: number;
		delay?: number;
		jobId?: string;
		priority?: number;
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
type QueueProcessHandler = (job: QueueJob<unknown, unknown>) => unknown;
type DynamicQueueName<TName extends string> = string extends TName
	? TName
	: TName extends RegisteredQueueName
		? never
		: TName;

interface QueueEntry<TData, TResult> {
	job: QueueJob<TData, TResult>;
	sequence: number;
}

interface ProcessorMetadata {
	name: string;
	options?: QueueOptions;
}

interface ProcessMetadata {
	name?: string;
	method: QueueMethod;
}

interface EventMetadata {
	event: QueueEventName;
	method: QueueMethod;
}

const durationPattern = /(-?\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec|seconds?|m|min|minutes?|h|hr|hours?)/gi;
const durationUnits = new Map<string, number>([
	['ms', 1],
	['millisecond', 1],
	['milliseconds', 1],
	['s', 1000],
	['sec', 1000],
	['second', 1000],
	['seconds', 1000],
	['m', 60_000],
	['min', 60_000],
	['minute', 60_000],
	['minutes', 60_000],
	['h', 3_600_000],
	['hr', 3_600_000],
	['hour', 3_600_000],
	['hours', 3_600_000],
]);

const processorMetadata = new WeakMap<Function, ProcessorMetadata>();
const processMetadata = new WeakMap<object, ProcessMetadata[]>();
const eventMetadata = new WeakMap<object, EventMetadata[]>();
const injectionMetadata = new WeakMap<Function, Map<number, string>>();

export class QueueJob<TData, TResult = unknown> {
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
		readonly name?: string,
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
	private readonly listeners = new Map<QueueEventName, Set<QueueListener<readonly unknown[]>>>();

	on<TEvent extends keyof QueueEventMap<TData, TResult>>(
		event: TEvent,
		listener: QueueListener<QueueEventMap<TData, TResult>[TEvent]>,
	): () => void {
		const listeners = this.listeners.get(event) ?? new Set<QueueListener<readonly unknown[]>>();
		listeners.add(listener as QueueListener<readonly unknown[]>);
		this.listeners.set(event, listeners);

		return () => this.off(event, listener);
	}

	off<TEvent extends keyof QueueEventMap<TData, TResult>>(
		event: TEvent,
		listener: QueueListener<QueueEventMap<TData, TResult>[TEvent]>,
	): void {
		this.listeners.get(event)?.delete(listener as QueueListener<readonly unknown[]>);
	}

	emit<TEvent extends keyof QueueEventMap<TData, TResult>>(
		event: TEvent,
		...args: QueueEventMap<TData, TResult>[TEvent]
	): void {
		for (const listener of this.listeners.get(event) ?? []) listener(...args);
	}

	removeAllListeners(): void {
		this.listeners.clear();
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
		super();
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
		this.running = options.autostart ?? true;
	}

	add(data: TData, options: JobOptions = {}): QueueJob<TData, TResult> {
		const now = this.now();
		const delay = parseDuration(options.delay ?? 0);
		const attempts = options.attempts ?? this.defaultAttempts;
		if (!Number.isInteger(attempts) || attempts <= 0) throw new RangeError('Job attempts must be a positive integer.');
		const jobId = options.id ?? this.generateJobId();
		if (this.getJob(jobId)) throw new RangeError(`Job with id "${jobId}" already exists.`);

		const job = new QueueJob<TData, TResult>(
			this.name,
			jobId,
			data,
			attempts,
			options.priority ?? 0,
			new Date(now),
			new Date(now + delay),
			options.name,
		);

		this.idle = false;
		this.enqueue(job);
		this.emit('added', job);
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
				this.emit('idle');
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
		this.emit('active', job);

		try {
			const result = await this.processor(job);
			job.error = undefined;
			job.result = result;
			job.status = 'completed';
			job.updatedAt = new Date(this.now());
			this.completedJobs.set(job.id, job);
			this.emit('completed', job, result);
		} catch (error) {
			job.error = error;
			job.updatedAt = new Date(this.now());

			if (job.attemptsMade < job.maxAttempts) {
				let delay: number;
				try {
					delay = this.resolveRetryDelay(job, error);
				} catch (retryError) {
					this.failJob(
						job,
						new AggregateError([error, retryError], 'Queue job failed and retry delay resolution also failed.'),
					);
					return;
				}

				job.runAt = new Date(this.now() + delay);
				this.idle = false;
				this.emit('retrying', job, error, delay);
				this.enqueue(job);
			} else {
				this.failJob(job, error);
			}
		} finally {
			this.activeJobs.delete(job.id);
			this.schedule();
		}
	}

	private resolveRetryDelay(job: QueueJob<TData, TResult>, error: unknown): number {
		const delay = typeof this.retryDelay === 'function' ? this.retryDelay(job, error) : this.retryDelay;
		return parseDuration(delay);
	}

	private failJob(job: QueueJob<TData, TResult>, error: unknown): void {
		job.error = error;
		job.status = 'failed';
		job.updatedAt = new Date(this.now());
		this.failedJobs.set(job.id, job);
		this.emit('failed', job, error);
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
	private readonly queue: BullQueueLike;
	private worker?: BullWorkerLike;
	private processor?: QueueProcessor<TData, TResult>;

	constructor(
		readonly name: string,
		private readonly bullmq: BullMQModuleLike,
		private readonly baseOptions: PersistentQueueOptions,
		private readonly options: QueueOptions<TData, TResult> = {},
	) {
		super();
		this.queue = new bullmq.Queue(name, this.baseQueueOptions());
	}

	async add(data: TData, options: JobOptions = {}): Promise<QueueJob<TData, TResult>> {
		const jobName = options.name ?? 'default';
		const bullOptions = stripUndefined({
			...this.baseOptions.queueOptions,
			attempts: options.attempts ?? this.options.attempts,
			delay: parseDuration(options.delay ?? 0),
			jobId: options.id,
			priority: options.priority,
		});
		const bullJob = await this.queue.add(jobName, data, bullOptions);
		const job = this.fromBullJob(bullJob, data, options);
		this.emit('added', job);
		return job;
	}

	process(processor: QueueProcessor<TData, TResult>): this {
		this.processor = processor;
		this.worker?.close?.();
		this.worker = new this.bullmq.Worker(this.name, job => this.processBullJob(job), this.baseWorkerOptions());
		return this;
	}

	start(): this {
		void this.queue.resume?.();
		return this;
	}

	pause(): this {
		void this.queue.pause?.();
		return this;
	}

	async clear(): Promise<void> {
		await this.queue.obliterate?.({ force: true });
	}

	async close(): Promise<void> {
		await this.worker?.close?.();
		await this.queue.close?.();
		this.removeAllListeners();
	}

	async counts(): Promise<QueueCounts> {
		const counts = (await this.queue.getJobCounts?.()) ?? {};
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
		const bullJob = await this.queue.getJob?.(id);
		return bullJob ? this.fromBullJob(bullJob) : undefined;
	}

	private async processBullJob(bullJob: BullJobLike): Promise<TResult> {
		if (!this.processor) throw new Error('Queue processor is not configured.');

		const job = this.fromBullJob(bullJob);
		job.status = 'active';
		this.emit('active', job);

		try {
			const result = await this.processor(job);
			job.status = 'completed';
			job.result = result;
			job.updatedAt = new Date();
			this.emit('completed', job, result);
			return result;
		} catch (error) {
			job.status = 'failed';
			job.error = error;
			job.updatedAt = new Date();
			this.emit('failed', job, error);
			throw error;
		}
	}

	private fromBullJob(bullJob: BullJobLike, data?: TData, options: JobOptions = {}): QueueJob<TData, TResult> {
		const createdAt = new Date(bullJob.timestamp ?? Date.now());
		const runAt = new Date(createdAt.getTime() + (bullJob.opts?.delay ?? parseDuration(options.delay ?? 0)));
		const job = new QueueJob<TData, TResult>(
			this.name,
			String(options.id ?? bullJob.id ?? bullJob.opts?.jobId ?? ''),
			(data ?? bullJob.data) as TData,
			options.attempts ?? bullJob.opts?.attempts ?? this.options.attempts ?? 1,
			options.priority ?? bullJob.opts?.priority ?? 0,
			createdAt,
			runAt,
			options.name ?? bullJob.name,
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

	async close(): Promise<void> {
		await Promise.all([...this.queues.values()].map(queue => queue.close()));
		this.queues.clear();
	}
}

export class QueuesRegistry {
	private readonly queues = new Map<string, Queue<unknown, unknown>>();
	private readonly queueOptionFingerprints = new Map<string, string>();
	private readonly handlers = new Map<string, QueueProcessHandler>();
	private readonly producers = new Map<QueueConstructor, object>();

	constructor(private readonly options: CreateQueuesOptions) {
		if (options.processors?.length || options.producers?.length) {
			this.register({ processors: options.processors, producers: options.producers });
		}
	}

	register(options: QueuesRegisterOptions): this {
		for (const processor of options.processors ?? []) this.registerProcessor(processor);
		for (const producer of options.producers ?? []) this.registerProducer(producer);
		return this;
	}

	get<TName extends RegisteredQueueName>(name: TName, options?: QueueOptionsOf<TName>): QueueOf<TName>;
	get<TData = unknown, TResult = unknown>(name: string, options?: QueueOptions<TData, TResult>): Queue<TData, TResult>;
	get<TData = unknown, TResult = unknown>(
		name: string,
		options: QueueOptions<TData, TResult> = {},
	): Queue<TData, TResult> {
		return this.getOrCreateQueue(name, options);
	}

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
	async add(queueName: string, data: unknown, options?: JobOptions): Promise<QueueJob<unknown, unknown>> {
		return this.get(queueName).add(data, options);
	}

	getProducer<T extends object>(producer: QueueConstructor<T>): T | undefined {
		return this.producers.get(producer) as T | undefined;
	}

	async close(): Promise<void> {
		if (this.options.driver.close) await this.options.driver.close();
		else await Promise.all([...this.queues.values()].map(queue => queue.close()));
		this.queues.clear();
		this.handlers.clear();
		this.producers.clear();
		this.queueOptionFingerprints.clear();
	}

	private registerProcessor(processor: QueueConstructor): void {
		const metadata = processorMetadata.get(processor);
		if (!metadata) throw new RangeError(`Queue processor metadata missing for ${processor.name}.`);

		const instance = this.instantiate(processor);
		const prototype = processor.prototype;
		const queue = this.getOrCreateQueue(metadata.name, metadata.options);

		for (const process of processMetadata.get(prototype) ?? []) {
			const handler = this.getMethod(instance, process.method);
			this.handlers.set(this.getHandlerKey(metadata.name, process.name), handler.bind(instance) as QueueProcessHandler);
		}

		for (const event of eventMetadata.get(prototype) ?? []) {
			const handler = this.getMethod(instance, event.method);
			queue.on(event.event, (...args: QueueEventMap<unknown, unknown>[typeof event.event]) => {
				handler.apply(instance, args);
			});
		}

		queue.process(job => {
			const handler = this.handlers.get(this.getHandlerKey(metadata.name, job.name));
			if (!handler) throw new RangeError(`Queue process not found: ${metadata.name}:${job.name ?? 'default'}`);
			return handler(job as QueueJob<unknown, unknown>);
		});
	}

	private registerProducer(producer: QueueConstructor): void {
		this.producers.set(producer, this.instantiate(producer));
	}

	private getOrCreateQueue<TData = unknown, TResult = unknown>(
		name: string,
		options: QueueOptions<TData, TResult> = {},
	): Queue<TData, TResult> {
		const mergedOptions = { ...this.options.queueDefaults, ...options };
		const fingerprint = fingerprintQueueOptions(mergedOptions);
		const existing = this.queues.get(name);
		if (existing) {
			if (this.queueOptionFingerprints.get(name) !== fingerprint) {
				throw new RangeError(`Queue already registered with different options: ${name}`);
			}
			return existing as Queue<TData, TResult>;
		}

		const queue = this.options.driver.get<TData, TResult>(name, mergedOptions as QueueOptions<TData, TResult>);
		this.queues.set(name, queue as Queue<unknown, unknown>);
		this.queueOptionFingerprints.set(name, fingerprint);
		return queue;
	}

	private instantiate<T extends object>(target: QueueConstructor<T>): T {
		if (this.options.resolve) return this.options.resolve(target);

		const injections = injectionMetadata.get(target) ?? new Map<number, string>();
		const args: unknown[] = [];
		for (const [index, name] of injections) args[index] = this.get(name);
		return new target(...args);
	}

	private getMethod(instance: object, method: QueueMethod): (...args: readonly unknown[]) => unknown {
		const value = (instance as Record<QueueMethod, unknown>)[method];
		if (typeof value !== 'function') throw new TypeError(`Queue method is not callable: ${String(method)}`);
		return value as (...args: readonly unknown[]) => unknown;
	}

	private getHandlerKey(queueName: string, processName?: string): string {
		return `${queueName}:${processName ?? 'default'}`;
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
		setup: client => {
			installQueues(client, registry);
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

export function Process(name?: string): MethodDecorator {
	return (target, key) => {
		const metadata = processMetadata.get(target) ?? [];
		metadata.push({ name, method: key });
		processMetadata.set(target, metadata);
	};
}

export function OnQueueEvent(event: QueueEventName): MethodDecorator {
	return (target, key) => {
		const metadata = eventMetadata.get(target) ?? [];
		metadata.push({ event, method: key });
		eventMetadata.set(target, metadata);
	};
}

export const QueueEvent = OnQueueEvent;

export function InjectQueue<TName extends RegisteredQueueName>(name: TName): ParameterDecorator;
export function InjectQueue(name: string): ParameterDecorator {
	return (target, _propertyKey, parameterIndex) => {
		const constructor = typeof target === 'function' ? target : target.constructor;
		const metadata = injectionMetadata.get(constructor) ?? new Map<number, string>();
		metadata.set(parameterIndex, name);
		injectionMetadata.set(constructor, metadata);
	};
}

export function parseDuration(value: DurationInput): number {
	if (typeof value === 'number') {
		if (!Number.isFinite(value) || value < 0) throw new RangeError('Duration must be a finite non-negative number.');
		return value;
	}

	const normalized = value.trim();
	if (!normalized) throw new RangeError('Duration string cannot be empty.');

	const numeric = Number(normalized);
	if (Number.isFinite(numeric) && numeric >= 0) return numeric;

	let total = 0;
	let lastIndex = 0;
	let matched = false;

	for (const match of normalized.matchAll(durationPattern)) {
		const gap = normalized.slice(lastIndex, match.index);
		if (gap.trim()) throw new RangeError(`Invalid duration segment: ${gap.trim()}`);

		matched = true;
		lastIndex = match.index + match[0].length;

		const amount = Number(match[1]);
		const unit = durationUnits.get(match[2].toLowerCase());

		if (!Number.isFinite(amount) || amount < 0 || !unit) throw new RangeError(`Invalid duration segment: ${match[0]}`);

		total += amount * unit;
	}

	const tail = normalized.slice(lastIndex);
	if (tail.trim()) throw new RangeError(`Invalid duration segment: ${tail.trim()}`);
	if (!matched || total < 0) throw new RangeError(`Invalid duration: ${value}`);

	return total;
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
