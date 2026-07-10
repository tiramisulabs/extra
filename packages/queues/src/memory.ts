import {
	type JobOptions,
	type Queue,
	type QueueCounts,
	type QueueDriver,
	QueueEmitter,
	QueueJob,
	type QueueJobName,
	type QueueOf,
	type QueueOptions,
	type QueueOptionsOf,
	type QueuePayloadFor,
	type QueueProcessor,
	type RegisteredQueueName,
	type RetryDelayResolver,
} from './core';
import {
	createJobIdGenerator,
	parseDuration,
	parseQueueAddArgs,
	resolveRetryDelayValue,
	warnRetryDelayWithoutRetries,
} from './helpers';

interface QueueEntry<TData, TResult> {
	job: QueueJob<TData, TResult, string>;
	sequence: number;
}

export class MemoryQueue<TData = unknown, TResult = unknown>
	extends QueueEmitter<TData, TResult>
	implements Queue<TData, TResult>
{
	readonly concurrency: number;
	private readonly defaultAttempts: number;
	private readonly retryDelay: RetryDelayResolver<TData, TResult>;
	private readonly retryDelays = new WeakMap<QueueJob<TData, TResult>, RetryDelayResolver<TData, TResult>>();
	private readonly retention: number;
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
	private closed = false;
	private timer?: ReturnType<typeof setTimeout>;

	constructor(
		readonly name: string,
		options: QueueOptions<TData, TResult> = {},
	) {
		super(options.reportListenerError);
		this.concurrency = options.concurrency ?? 1;
		this.defaultAttempts = options.attempts ?? 1;
		this.retryDelay = options.retryDelay ?? 0;
		this.retention = options.retention ?? 1000;
		this.now = options.now ?? Date.now;
		this.idGenerator = options.idGenerator ?? createJobIdGenerator();

		if (!Number.isInteger(this.concurrency) || this.concurrency <= 0) {
			throw new RangeError('Queue concurrency must be a positive integer.');
		}
		if (!Number.isInteger(this.defaultAttempts) || this.defaultAttempts <= 0) {
			throw new RangeError('Queue attempts must be a positive integer.');
		}
		if (!Number.isInteger(this.retention) || this.retention < 0) {
			throw new RangeError('Queue retention must be a non-negative integer.');
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
		this.assertOpen();
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
		this.retryDelays.set(job, options.retryDelay ?? this.retryDelay);
		this.enqueue(job);
		this.emit('added', { job, jobId: job.id, name: job.name });
		this.schedule();
		return job;
	}

	process(processor: QueueProcessor<TData, TResult>): this {
		this.assertOpen();
		if (this.processor) throw new RangeError(`Queue "${this.name}" already has a processor.`);
		this.processor = processor;
		this.schedule();
		return this;
	}

	start(): this {
		this.assertOpen();
		this.running = true;
		this.schedule();
		return this;
	}

	pause(): this {
		this.assertOpen();
		this.running = false;
		this.clearTimer();
		return this;
	}

	clear(): void {
		this.assertOpen();
		if (this.activeJobs.size > 0) throw new RangeError('Cannot clear a queue while jobs are active.');
		this.queue.length = 0;
		this.completedJobs.clear();
		this.failedJobs.clear();
		this.idle = true;
		this.clearTimer();
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.running = false;
		this.processor = undefined;
		this.clearTimer();
		this.removeAllListeners();
	}

	counts(): QueueCounts {
		let waiting = 0;
		let delayed = 0;
		const now = this.now();

		for (const { job } of this.queue) {
			if (this.runAt(job) > now) delayed++;
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
		job.status = this.runAt(job) > this.now() ? 'delayed' : 'waiting';
		job.updatedAt = new Date(this.now());
		this.queue.push({ job, sequence: this.sequence++ });
		this.sortQueue();
	}

	private sortQueue(): void {
		const now = this.now();
		this.queue.sort((a, b) => {
			const aRunAt = this.runAt(a.job);
			const bRunAt = this.runAt(b.job);
			const aReady = aRunAt <= now;
			const bReady = bRunAt <= now;
			if (aReady !== bReady) return aReady ? -1 : 1;

			if (!(aReady && bReady)) {
				const byRunAt = aRunAt - bRunAt;
				if (byRunAt !== 0) return byRunAt;
			}

			const byPriority = a.job.priority - b.job.priority;
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

		const delay = Math.max(this.runAt(next.job) - this.now(), 0);
		this.timer = setTimeout(() => this.schedule(), delay);
	}

	private drainReadyJobs(): void {
		while (this.activeJobs.size < this.concurrency) {
			const next = this.queue[0];
			if (!next || this.runAt(next.job) > this.now()) break;

			this.queue.shift();
			void this.run(next.job);
		}
	}

	private runAt(job: QueueJob<TData, TResult>): number {
		if (!job.runAt) throw new Error(`Memory queue job "${job.id}" is missing its scheduled time.`);
		return job.runAt.getTime();
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
			this.retainJob(this.completedJobs, job);
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
				this.emit('completed', { job, jobId: job.id, result: completedResult as TResult });
				this.emitWorker('completed', { job, result: completedResult as TResult });
			} else if (failedError !== undefined) {
				this.emit('failed', { error: failedError, job, jobId: job.id });
				this.emitWorker('failed', { error: failedError, job });
			}
			this.schedule();
		}
	}

	private resolveRetryDelay(job: QueueJob<TData, TResult>, error: unknown): number {
		const retryDelay = this.retryDelays.get(job) ?? this.retryDelay;
		const delay = typeof retryDelay === 'function' ? retryDelay(job, error) : retryDelay;
		return resolveRetryDelayValue(delay, job.attemptsMade);
	}

	private failJob(job: QueueJob<TData, TResult>, error: unknown): void {
		job.error = error;
		job.status = 'failed';
		job.updatedAt = new Date(this.now());
		this.retainJob(this.failedJobs, job);
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

	private retainJob(store: Map<string, QueueJob<TData, TResult>>, job: QueueJob<TData, TResult>): void {
		if (this.retention === 0) return;
		store.set(job.id, job);
		while (store.size > this.retention) {
			const oldest = store.keys().next().value;
			if (oldest === undefined) break;
			store.delete(oldest);
		}
	}

	private assertOpen(): void {
		if (this.closed) throw new Error(`Queue "${this.name}" is closed.`);
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
