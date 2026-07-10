import {
	type BullJobLike,
	type BullMQModuleLike,
	type BullQueueEventsLike,
	type BullQueueLike,
	type BullWorkerLike,
	type JobOptions,
	type PersistentQueueOptions,
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
	type QueuesClientLike,
	type RegisteredQueueName,
	type RetryDelayResolver,
} from './core';
import {
	eventRecord,
	isClientInitialized,
	loadBullMQ,
	normalizeBackoffOptions,
	normalizeBullJobState,
	parseDuration,
	parseQueueAddArgs,
	stripUndefined,
	warnRetryDelayWithoutRetries,
} from './helpers';

export class PersistentQueue<TData = unknown, TResult = unknown>
	extends QueueEmitter<TData, TResult>
	implements Queue<TData, TResult>
{
	private queue?: BullQueueLike;
	private worker?: BullWorkerLike;
	private queueEvents?: BullQueueEventsLike;
	private processor?: QueueProcessor<TData, TResult>;
	private setupClient?: QueuesClientLike;
	private setupPromise?: Promise<void>;
	private workerSetupPromise?: Promise<void>;
	private closePromise?: Promise<void>;
	private activated = false;
	private workerStarted = false;
	private state: 'pending' | 'setting-up' | 'ready' | 'closing' | 'closed' = 'pending';

	constructor(
		readonly name: string,
		private readonly bullmq: BullMQModuleLike,
		private readonly baseOptions: PersistentQueueOptions,
		private readonly options: QueueOptions<TData, TResult> = {},
	) {
		super(options.reportListenerError);
	}

	async setup(client?: QueuesClientLike): Promise<void> {
		this.activate(client);
		if (this.state === 'ready') return;
		if (this.setupPromise) return this.setupPromise;
		if (this.state === 'closing' || this.state === 'closed') {
			throw new Error(`Queue "${this.name}" is ${this.state}.`);
		}

		this.state = 'setting-up';
		this.setupClient = client;
		const setup = this.setupResources(client);
		this.setupPromise = setup;
		try {
			await setup;
			if (this.state === 'setting-up') this.state = 'ready';
		} catch (error) {
			if (this.state === 'setting-up') this.state = 'pending';
			this.setupClient = undefined;
			throw error;
		} finally {
			this.setupPromise = undefined;
		}
	}

	activate(client?: QueuesClientLike): void {
		if (this.state === 'closing' || this.state === 'closed') {
			throw new Error(`Queue "${this.name}" is ${this.state}.`);
		}
		this.activated = true;
		this.setupClient = client;
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
		const queue = await this.readyQueue();
		const { data, name, options } = parseQueueAddArgs<TData, TResult>(nameOrData, dataOrOptions, maybeOptions);
		this.rejectUnsupportedRetryDelay(options.retryDelay);
		warnRetryDelayWithoutRetries(
			options.retryDelay ?? this.options.retryDelay,
			options.attempts ?? this.options.attempts ?? this.defaultJobNumber('attempts') ?? 1,
			`job "${name}" on queue "${this.name}"`,
		);
		const bullOptions = this.buildJobOptions(options);
		const bullJob = await queue.add(name, data, bullOptions);
		const job = this.fromBullJob(bullJob, data, name, options, undefined, this.addedRunAt(bullJob, options));
		if (!this.queueEvents) this.emit('added', { job, jobId: job.id, name: job.name });
		return job;
	}

	process(processor: QueueProcessor<TData, TResult>): this | Promise<this> {
		if (this.processor) throw new RangeError(`Queue "${this.name}" already has a processor.`);
		if (this.state === 'closing' || this.state === 'closed') throw new Error(`Queue "${this.name}" is closed.`);
		this.processor = processor;
		if (!this.activated) return this;
		return this.ensureWorkerReady().then(
			() => this,
			error => {
				this.processor = undefined;
				throw error;
			},
		);
	}

	async start(): Promise<this> {
		const queue = await this.readyQueue();
		if (this.processor) await this.ensureWorkerReady();
		await queue.resume?.();
		if (this.worker && !this.workerStarted) {
			this.workerStarted = true;
			void Promise.resolve(this.worker.run?.()).catch(error => {
				this.workerStarted = false;
				this.reportListenerFailure(`${this.name}:worker`, error);
			});
		}
		return this;
	}

	async pause(): Promise<this> {
		const queue = await this.readyQueue();
		await Promise.all([queue.pause?.(), this.worker?.pause?.()]);
		this.workerStarted = false;
		return this;
	}

	async clear(): Promise<void> {
		const queue = await this.readyQueue();
		await queue.obliterate?.({ force: true });
	}

	async close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		if (this.state === 'closed') return;
		this.state = 'closing';
		const close = this.closeResources();
		this.closePromise = close;
		try {
			await close;
		} finally {
			this.state = 'closed';
			this.closePromise = undefined;
		}
	}

	async counts(): Promise<QueueCounts> {
		const queue = await this.readyQueue();
		const counts =
			(await queue.getJobCounts?.(
				'waiting',
				'prioritized',
				'paused',
				'waiting-children',
				'delayed',
				'active',
				'completed',
				'failed',
			)) ?? {};
		const waiting =
			(counts.waiting ?? 0) + (counts.prioritized ?? 0) + (counts.paused ?? 0) + (counts['waiting-children'] ?? 0);
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
		const queue = await this.readyQueue();
		const bullJob = await queue.getJob?.(id);
		if (!bullJob) return undefined;
		const state = await bullJob.getState?.();
		const normalizedState = normalizeBullJobState(state);
		const runAt = normalizedState === 'delayed' ? await this.delayedRunAt(id) : undefined;
		return this.fromBullJob(
			bullJob,
			undefined,
			undefined,
			{},
			state,
			normalizedState === 'delayed' ? (runAt ?? null) : undefined,
		);
	}

	private async setupResources(client?: QueuesClientLike): Promise<void> {
		this.rejectUnsupportedRetryDelay(this.options.retryDelay);
		warnRetryDelayWithoutRetries(
			this.options.retryDelay,
			this.options.attempts ?? this.defaultJobNumber('attempts') ?? 1,
			`queue "${this.name}"`,
		);
		let queue: BullQueueLike | undefined;
		let queueEvents: BullQueueEventsLike | undefined;
		let worker: BullWorkerLike | undefined;

		try {
			queue = new this.bullmq.Queue(this.name, this.baseQueueOptions());
			if (this.bullmq.QueueEvents) {
				queueEvents = new this.bullmq.QueueEvents(this.name, this.baseQueueEventsOptions());
			}
			if (this.processor) worker = this.createWorker(client);

			this.queue = queue;
			this.queueEvents = queueEvents;
			this.worker = worker;
			if (queueEvents) this.wireQueueEvents(queueEvents);
			if (worker) this.wireWorkerEvents(worker);
			queue.on?.('error', error => this.reportListenerFailure(`${this.name}:queue`, error));
			await Promise.all([queue.waitUntilReady?.(), queueEvents?.waitUntilReady?.(), worker?.waitUntilReady?.()]);
			this.workerStarted = Boolean(worker) && (this.options.autostart ?? true);
			if (this.state === 'setting-up') this.state = 'ready';
		} catch (error) {
			await Promise.allSettled([
				Promise.resolve().then(() => worker?.close?.()),
				Promise.resolve().then(() => queueEvents?.close?.()),
				Promise.resolve().then(() => queue?.close?.()),
			]);
			if (this.queue === queue) this.queue = undefined;
			if (this.queueEvents === queueEvents) this.queueEvents = undefined;
			if (this.worker === worker) this.worker = undefined;
			this.workerStarted = false;
			throw error;
		}
	}

	private async ensureWorkerReady(): Promise<void> {
		await this.ensureReady();
		if (this.workerSetupPromise) return this.workerSetupPromise;
		if (this.worker) return;
		if (!this.processor) throw new Error(`Queue "${this.name}" has no processor.`);

		const setup = this.setupWorker();
		this.workerSetupPromise = setup;
		try {
			await setup;
		} finally {
			this.workerSetupPromise = undefined;
		}
	}

	private async setupWorker(): Promise<void> {
		let worker: BullWorkerLike | undefined;
		try {
			worker = this.createWorker(this.setupClient);
			this.worker = worker;
			this.wireWorkerEvents(worker);
			await worker.waitUntilReady?.();
			if (this.state === 'closing' || this.state === 'closed') {
				throw new Error(`Queue "${this.name}" was closed while its worker was starting.`);
			}
			this.workerStarted = this.options.autostart ?? true;
		} catch (error) {
			await Promise.resolve().then(() => worker?.close?.());
			if (this.worker === worker) this.worker = undefined;
			this.workerStarted = false;
			throw error;
		}
	}

	private async ensureReady(): Promise<void> {
		if (this.state === 'ready') return;
		if (!this.activated) {
			throw new Error(`Queue "${this.name}" is not initialized; await client.start() before producing jobs.`);
		}
		await this.setup(this.setupClient);
	}

	private async readyQueue(): Promise<BullQueueLike> {
		await this.ensureReady();
		if (this.queue) return this.queue;
		throw new Error(`Queue "${this.name}" did not initialize its BullMQ queue.`);
	}

	private async closeResources(): Promise<void> {
		const errors: unknown[] = [];
		const workers = await Promise.allSettled([
			Promise.resolve().then(() => this.worker?.close?.()),
			Promise.resolve().then(() => this.queueEvents?.close?.()),
		]);
		for (const result of workers) if (result.status === 'rejected') errors.push(result.reason);
		try {
			await this.queue?.close?.();
		} catch (error) {
			errors.push(error);
		}

		this.worker = undefined;
		this.queueEvents = undefined;
		this.queue = undefined;
		this.setupClient = undefined;
		this.processor = undefined;
		this.workerStarted = false;
		this.removeAllListeners();
		if (errors.length) throw new AggregateError(errors, `Failed to close queue "${this.name}".`);
	}

	private async processBullJob(bullJob: BullJobLike): Promise<TResult> {
		if (!this.processor) throw new Error('Queue processor is not configured.');
		const job = this.fromBullJob(bullJob);
		job.status = 'active';
		job.error = undefined;
		return this.processor(job);
	}

	private fromBullJob(
		bullJob: BullJobLike,
		data?: TData,
		name = bullJob.name ?? 'default',
		options: JobOptions<TData, TResult> = {},
		state?: string,
		exactRunAt?: Date | null,
	): QueueJob<TData, TResult, string> {
		const createdAt = new Date(bullJob.timestamp ?? Date.now());
		const knownState = normalizeBullJobState(state);
		const runAt = exactRunAt === null ? undefined : (exactRunAt ?? this.processedAt(bullJob));
		const job = new QueueJob<TData, TResult, string>(
			this.name,
			String(options.id ?? bullJob.id ?? bullJob.opts?.jobId ?? ''),
			(data ?? bullJob.data) as TData,
			options.attempts ?? bullJob.opts?.attempts ?? this.options.attempts ?? this.defaultJobNumber('attempts') ?? 1,
			options.priority ?? bullJob.opts?.priority ?? this.defaultJobNumber('priority') ?? 0,
			createdAt,
			runAt,
			name,
		);
		job.attemptsMade = bullJob.attemptsMade ?? 0;
		job.updatedAt = new Date(bullJob.finishedOn ?? bullJob.processedOn ?? bullJob.timestamp ?? Date.now());
		if (knownState) {
			job.status = knownState;
		}
		if (job.status === 'failed' || (!knownState && bullJob.failedReason !== undefined)) {
			job.error = new Error(bullJob.failedReason);
			job.status = 'failed';
		} else if (job.status === 'completed' || (!knownState && bullJob.finishedOn !== undefined)) {
			job.result = bullJob.returnvalue as TResult;
			job.status = 'completed';
		} else if (!knownState && bullJob.processedOn !== undefined) {
			job.status = 'active';
		}
		return job;
	}

	private addedRunAt(bullJob: BullJobLike, options: JobOptions<TData, TResult>): Date {
		const configuredDelay = options.delay ?? this.defaultJobDuration('delay') ?? 0;
		const delay = bullJob.delay ?? bullJob.opts?.delay ?? parseDuration(configuredDelay);
		return new Date((bullJob.timestamp ?? Date.now()) + delay);
	}

	private processedAt(bullJob: BullJobLike): Date | undefined {
		return bullJob.processedOn === undefined ? undefined : new Date(bullJob.processedOn);
	}

	private async delayedRunAt(id: string): Promise<Date | undefined> {
		const delayedKey = this.queue?.toKey?.('delayed');
		const client = await this.queue?.client;
		if (!delayedKey || !client?.zscore) return undefined;
		const rawScore = await client.zscore(delayedKey, id);
		if (rawScore === null) return undefined;
		const score = Number(rawScore);
		if (!Number.isFinite(score) || score < 0) return undefined;
		return new Date(Math.floor(score / 0x1000));
	}

	private baseQueueOptions(): Record<string, unknown> {
		return stripUndefined({
			connection: this.baseOptions.connection,
			prefix: this.baseOptions.prefix,
			...this.baseOptions.queueOptions,
			defaultJobOptions: this.baseOptions.defaultJobOptions,
		});
	}

	private baseQueueEventsOptions(): Record<string, unknown> {
		return stripUndefined({
			connection: this.baseOptions.connection,
			prefix: this.baseOptions.prefix,
			...this.baseOptions.queueEventsOptions,
		});
	}

	private baseWorkerOptions(): Record<string, unknown> {
		return stripUndefined({
			connection: this.baseOptions.connection,
			concurrency: this.options.concurrency,
			prefix: this.baseOptions.prefix,
			...this.baseOptions.workerOptions,
			autorun: this.options.autostart ?? true,
		});
	}

	private defaultJobNumber(key: 'attempts' | 'priority'): number | undefined {
		const value = this.baseOptions.defaultJobOptions?.[key];
		return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
	}

	private defaultJobDuration(key: 'delay'): string | number | undefined {
		const value = this.baseOptions.defaultJobOptions?.[key];
		return typeof value === 'string' || typeof value === 'number' ? value : undefined;
	}

	private buildJobOptions(options: JobOptions<TData, TResult>): Record<string, unknown> {
		const retryDelay = options.retryDelay ?? this.options.retryDelay;
		const backoff = retryDelay === undefined ? undefined : this.resolvePersistentBackoff(retryDelay);
		const attempts = options.attempts ?? this.options.attempts;
		return {
			...this.baseOptions.defaultJobOptions,
			...(attempts === undefined ? {} : { attempts }),
			...(options.delay === undefined ? {} : { delay: parseDuration(options.delay) }),
			...(options.id === undefined ? {} : { jobId: options.id }),
			...(options.priority === undefined ? {} : { priority: options.priority }),
			...(backoff === undefined ? {} : { backoff }),
		};
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

	private createWorker(client?: QueuesClientLike): BullWorkerLike {
		return new this.bullmq.Worker(
			this.name,
			job => {
				if (client && !isClientInitialized(client)) {
					this.reportListenerFailure(
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

	private wireWorkerEvents(worker: BullWorkerLike): void {
		worker.on?.('active', bullJob => {
			const job = this.fromBullJob(bullJob as BullJobLike);
			job.status = 'active';
			this.emit('active', { job });
			this.emitWorker('active', { job });
		});
		worker.on?.('completed', (bullJob, result) => {
			const job = this.fromBullJob(bullJob as BullJobLike);
			job.status = 'completed';
			job.result = result as TResult;
			this.emitWorker('completed', { job, result: result as TResult });
			if (!this.queueEvents) this.emit('completed', { job, jobId: job.id, result: result as TResult });
		});
		worker.on?.('failed', (bullJob, error) => {
			if (!bullJob) {
				this.reportListenerFailure(`${this.name}:failed`, error ?? new Error('BullMQ omitted the failed job.'));
				return;
			}
			void this.handleWorkerFailure(bullJob as BullJobLike, error).catch(failure => {
				this.reportListenerFailure(`${this.name}:failed`, failure);
			});
		});
		worker.on?.('drained', () => {
			this.emit('idle', {});
			this.emitWorker('idle', {});
		});
		worker.on?.('error', error => this.reportListenerFailure(`${this.name}:worker`, error));
	}

	private async handleWorkerFailure(bullJob: BullJobLike, error: unknown): Promise<void> {
		const state = normalizeBullJobState(await bullJob.getState?.());
		const runAt = state === 'delayed' ? await this.delayedRunAt(String(bullJob.id ?? '')) : undefined;
		const job = this.fromBullJob(bullJob, undefined, undefined, {}, state, runAt ?? null);
		const failure = error ?? job.error ?? new Error('Queue job failed.');
		const terminal =
			state === 'failed' ||
			bullJob.finishedOn !== undefined ||
			bullJob.discarded === true ||
			(error instanceof Error && error.name === 'UnrecoverableError') ||
			job.attemptsMade >= job.maxAttempts;
		if (!terminal) {
			const delay = Number.isFinite(bullJob.delay) && (bullJob.delay ?? -1) >= 0 ? (bullJob.delay ?? 0) : 0;
			job.status = state === 'delayed' || state === 'waiting' ? state : delay > 0 ? 'delayed' : 'waiting';
			job.error = failure;
			this.emit('retrying', { delay, error: failure, job });
			this.emitWorker('retrying', { delay, error: failure, job });
			return;
		}
		job.status = 'failed';
		job.error = failure;
		this.emitWorker('failed', { error: failure, job });
		if (!this.queueEvents) this.emit('failed', { error: failure, job, jobId: job.id });
	}

	private wireQueueEvents(queueEvents: BullQueueEventsLike): void {
		queueEvents.on?.('added', event => {
			this.emitQueueAdded(event);
		});
		queueEvents.on?.('completed', event => {
			this.emitQueueCompleted(event);
		});
		queueEvents.on?.('failed', event => {
			this.emitQueueFailed(event);
		});
		queueEvents.on?.('error', error => this.reportListenerFailure(`${this.name}:queue-events`, error));
	}

	private emitQueueAdded(event: unknown): void {
		const record = eventRecord(event);
		const jobId = String(record.jobId ?? record.id ?? '');
		const name = typeof record.name === 'string' ? record.name : undefined;
		this.emit('added', { job: undefined, jobId, name });
	}

	private emitQueueCompleted(event: unknown): void {
		const record = eventRecord(event);
		const jobId = String(record.jobId ?? record.id ?? '');
		this.emit('completed', { job: undefined, jobId, result: record.returnvalue as TResult });
	}

	private emitQueueFailed(event: unknown): void {
		const record = eventRecord(event);
		const id = String(record.jobId ?? record.id ?? '');
		const error = new Error(String(record.failedReason ?? 'Queue job failed.'));
		this.emit('failed', { error, job: undefined, jobId: id });
	}
}

export class PersistentQueueDriver implements QueueDriver {
	private readonly bullmq: BullMQModuleLike;
	private readonly queues = new Map<string, PersistentQueue<unknown, unknown>>();
	private setupClient?: QueuesClientLike;
	private state: 'pending' | 'setting-up' | 'ready' | 'closed' = 'pending';

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
		if (this.state === 'ready' || this.state === 'setting-up') queue.activate(this.setupClient);
		return queue;
	}

	async setup(client?: QueuesClientLike): Promise<void> {
		if (this.state === 'ready') return;
		if (this.state === 'closed') throw new Error('@slipher/queues persistent driver is closed.');
		this.state = 'setting-up';
		this.setupClient = client;
		try {
			let size = -1;
			while (size !== this.queues.size) {
				size = this.queues.size;
				await Promise.all([...this.queues.values()].map(queue => queue.setup(client)));
			}
			if (this.isClosed()) throw new Error('@slipher/queues persistent driver closed during setup.');
			this.state = 'ready';
		} catch (error) {
			if (!this.isClosed()) this.state = 'pending';
			throw error;
		}
	}

	async close(): Promise<void> {
		if (this.state === 'closed') return;
		this.state = 'closed';
		try {
			const results = await Promise.allSettled([...this.queues.values()].map(queue => queue.close()));
			const errors = results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []));
			if (errors.length) throw new AggregateError(errors, 'Failed to close persistent queues.');
		} finally {
			this.queues.clear();
			this.setupClient = undefined;
		}
	}

	private isClosed(): boolean {
		return this.state === 'closed';
	}
}
