import { LockAcquireError, type LockManager, type LockOptions } from '@slipher/locks';
import { type DurationInput, parseDuration } from './duration';
import { QueueEmitter } from './events';
import { Job, type JobOptions } from './job';

export type Awaitable<T> = T | Promise<T>;
export type QueueProcessor<TData, TResult> = (job: Job<TData, TResult>) => Awaitable<TResult>;
export type RetryDelayResolver<TData, TResult> =
	| number
	| string
	| ((job: Job<TData, TResult>, error: unknown) => DurationInput);
export type QueueLockKeyResolver<TData, TResult> = string | ((job: Job<TData, TResult>) => Awaitable<string>);
export type QueueLockOptionsResolver<TData, TResult> =
	| LockOptions
	| ((job: Job<TData, TResult>) => Awaitable<LockOptions>);

export interface QueueOptions<TData, TResult> {
	concurrency?: number;
	attempts?: number;
	retryDelay?: RetryDelayResolver<TData, TResult>;
	lock?: LockManager;
	lockKey?: QueueLockKeyResolver<TData, TResult>;
	lockOptions?: QueueLockOptionsResolver<TData, TResult>;
	autostart?: boolean;
	now?: () => number;
	idGenerator?: () => string;
}

export interface QueueCounts {
	waiting: number;
	delayed: number;
	active: number;
	completed: number;
	failed: number;
	skipped: number;
	total: number;
}

interface QueueEntry<TData, TResult> {
	job: Job<TData, TResult>;
	sequence: number;
}

export class Queue<TData = unknown, TResult = unknown> extends QueueEmitter<TData, TResult> {
	readonly name: string;
	readonly concurrency: number;
	private readonly defaultAttempts: number;
	private readonly retryDelay: RetryDelayResolver<TData, TResult>;
	private readonly lock?: LockManager;
	private readonly lockKey?: QueueLockKeyResolver<TData, TResult>;
	private readonly lockOptions?: QueueLockOptionsResolver<TData, TResult>;
	private readonly now: () => number;
	private readonly idGenerator: () => string;
	private readonly queue: QueueEntry<TData, TResult>[] = [];
	private readonly activeJobs = new Map<string, Job<TData, TResult>>();
	private readonly completedJobs = new Map<string, Job<TData, TResult>>();
	private readonly failedJobs = new Map<string, Job<TData, TResult>>();
	private readonly skippedJobs = new Map<string, Job<TData, TResult>>();
	private processor?: QueueProcessor<TData, TResult>;
	private sequence = 0;
	private idle = true;
	private running = false;
	private timer?: NodeJS.Timeout;

	constructor(name: string, options: QueueOptions<TData, TResult> = {}) {
		super();
		this.name = name;
		this.concurrency = options.concurrency ?? 1;
		this.defaultAttempts = options.attempts ?? 1;
		this.retryDelay = options.retryDelay ?? 0;
		this.lock = options.lock;
		this.lockKey = options.lockKey;
		this.lockOptions = options.lockOptions;
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

	add(data: TData, options: JobOptions = {}): Job<TData, TResult> {
		const now = this.now();
		const delay = parseDuration(options.delay ?? 0);
		const attempts = options.attempts ?? this.defaultAttempts;
		if (!Number.isInteger(attempts) || attempts <= 0) throw new RangeError('Job attempts must be a positive integer.');
		const jobId = options.id ?? this.generateJobId();
		if (this.getJob(jobId)) throw new RangeError(`Job with id "${jobId}" already exists.`);

		const job = new Job<TData, TResult>(
			jobId,
			data,
			attempts,
			options.priority ?? 0,
			new Date(now),
			new Date(now + delay),
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
		this.skippedJobs.clear();
		this.idle = true;
		this.clearTimer();
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
			skipped: this.skippedJobs.size,
			total:
				this.queue.length +
				this.activeJobs.size +
				this.completedJobs.size +
				this.failedJobs.size +
				this.skippedJobs.size,
		};
	}

	getJob(id: string): Job<TData, TResult> | undefined {
		return (
			this.activeJobs.get(id) ??
			this.completedJobs.get(id) ??
			this.failedJobs.get(id) ??
			this.skippedJobs.get(id) ??
			this.queue.find(entry => entry.job.id === id)?.job
		);
	}

	private enqueue(job: Job<TData, TResult>): void {
		job.status = job.runAt.getTime() > this.now() ? 'delayed' : 'waiting';
		job.updatedAt = new Date(this.now());
		this.queue.push({ job, sequence: this.sequence++ });
		this.sortQueue();
	}

	private sortQueue(): void {
		this.queue.sort((a, b) => {
			const byRunAt = a.job.runAt.getTime() - b.job.runAt.getTime();
			if (byRunAt !== 0) return byRunAt;
			const byPriority = b.job.priority - a.job.priority;
			if (byPriority !== 0) return byPriority;
			return a.sequence - b.sequence;
		});
	}

	private schedule(): void {
		this.clearTimer();
		if (!(this.running && this.processor)) return;

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

	private async run(job: Job<TData, TResult>): Promise<void> {
		if (!this.processor) return;
		job.status = 'active';
		job.attemptsMade++;
		job.updatedAt = new Date(this.now());
		this.activeJobs.set(job.id, job);
		this.emit('active', job);

		try {
			const result = await this.processLocked(job);
			job.error = undefined;
			job.result = result;
			job.status = 'completed';
			job.updatedAt = new Date(this.now());
			this.completedJobs.set(job.id, job);
			this.emit('completed', job, result);
		} catch (error) {
			job.error = error;
			job.updatedAt = new Date(this.now());

			if (error instanceof LockAcquireError) {
				job.status = 'skipped';
				this.skippedJobs.set(job.id, job);
				this.emit('skipped', job, error);
				return;
			}

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

	private resolveRetryDelay(job: Job<TData, TResult>, error: unknown): number {
		const delay = typeof this.retryDelay === 'function' ? this.retryDelay(job, error) : this.retryDelay;
		return parseDuration(delay);
	}

	private failJob(job: Job<TData, TResult>, error: unknown): void {
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

	private async processLocked(job: Job<TData, TResult>): Promise<TResult> {
		if (!this.processor) throw new Error('Queue processor is not configured.');
		if (!this.lock) return this.processor(job);

		return this.lock.withLock(
			await this.resolveLockKey(job),
			() => this.processor!(job),
			await this.resolveLockOptions(job),
		);
	}

	private async resolveLockKey(job: Job<TData, TResult>): Promise<string> {
		if (typeof this.lockKey === 'function') return this.lockKey(job);
		return this.lockKey ?? `queue:${this.name}:${job.id}`;
	}

	private async resolveLockOptions(job: Job<TData, TResult>): Promise<LockOptions> {
		if (typeof this.lockOptions === 'function') return this.lockOptions(job);
		return this.lockOptions ?? {};
	}

	private clearTimer(): void {
		if (!this.timer) return;
		clearTimeout(this.timer);
		this.timer = undefined;
	}
}

function createJobIdGenerator() {
	let nextId = 0;
	return () => String(++nextId);
}
