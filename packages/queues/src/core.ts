import type { SeyfertPlugin } from 'seyfert';
import type { DurationInput } from './helpers';
import type { QueuesRegistry } from './index';

export { type DurationInput, InvalidDurationError } from './helpers';

export type Awaitable<T> = T | Promise<T>;
export type JobStatus = 'waiting' | 'delayed' | 'active' | 'completed' | 'failed';
export type QueueEventName = keyof QueueEventMap<unknown, unknown>;
export type GlobalQueueEventName = keyof QueueGlobalEventMap<unknown, unknown>;
export type WorkerEventName = keyof QueueWorkerEventMap<unknown, unknown>;
export type QueueListener<TPayload> = (payload: TPayload) => Awaitable<void>;
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
	retention?: number;
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
export type QueueJobName<TData> = TData extends { job: infer TJob extends string } ? TJob : never;
export type QueuePayloadFor<TData, TJob extends string> = TData extends { job: TJob } ? Omit<TData, 'job'> : never;
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
	runAt?: Date;
	name: string;
	result?: TResult;
	error?: unknown;
}

export interface QueueEventMap<TData, TResult> {
	added: { job: QueueJob<TData, TResult> | undefined; jobId: string; name?: string };
	active: { job: QueueJob<TData, TResult> };
	completed: { job: QueueJob<TData, TResult> | undefined; jobId: string; result: TResult };
	failed: { job: QueueJob<TData, TResult> | undefined; jobId: string; error: unknown };
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
	added: { job: QueueJob<TData, TResult> | undefined; jobId: string; name?: string };
	completed: { job: QueueJob<TData, TResult> | undefined; jobId: string; result: TResult };
	failed: { job: QueueJob<TData, TResult> | undefined; jobId: string; error: unknown };
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
	process(processor: QueueProcessor<TData, TResult>): Awaitable<this>;
	start(): Awaitable<this>;
	pause(): Awaitable<this>;
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
}

export interface QueuesRegisterOptions {
	processors?: readonly QueueConstructor[];
}

export interface QueuesPluginOptions extends CreateQueuesOptions {}

export interface QueuesPlugin extends SeyfertPlugin<{ queues: QueuesRegistry }, { queues: QueuesRegistry }> {
	name: '@slipher/queues';
	registry: QueuesRegistry;
}

export type QueuesClientLike = object;

export interface PersistentQueueOptions {
	bullmq?: BullMQModuleLike;
	connection?: unknown;
	prefix?: string;
	queueOptions?: Record<string, unknown>;
	queueEventsOptions?: Record<string, unknown>;
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
	client?: Awaitable<BullRedisClientLike>;
	add(name: string, data: unknown, options?: Record<string, unknown>): Awaitable<BullJobLike>;
	on?(event: string, listener: (...args: unknown[]) => void): unknown;
	getJob?(id: string): Awaitable<BullJobLike | undefined | null>;
	getJobCounts?(...types: string[]): Awaitable<Record<string, number>>;
	pause?(): Awaitable<void>;
	resume?(): Awaitable<void>;
	obliterate?(options?: Record<string, unknown>): Awaitable<void>;
	close?(): Awaitable<void>;
	waitUntilReady?(): Awaitable<unknown>;
	toKey?(type: string): string;
}

export interface BullRedisClientLike {
	zscore?(key: string, member: string): Awaitable<number | string | null>;
}

export interface BullWorkerLike {
	on?(event: string, listener: (...args: unknown[]) => void): unknown;
	close?(): Awaitable<void>;
	pause?(): Awaitable<void>;
	run?(): Awaitable<void>;
	waitUntilReady?(): Awaitable<unknown>;
}

export interface BullQueueEventsLike {
	on?(event: string, listener: (...args: unknown[]) => void): unknown;
	off?(event: string, listener: (...args: unknown[]) => void): unknown;
	close?(): Awaitable<void>;
	waitUntilReady?(): Awaitable<unknown>;
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
	delay?: number;
	returnvalue?: unknown;
	failedReason?: string;
	discarded?: boolean;
	getState?(): Awaitable<string>;
}

export type QueueConstructor<T = object> = new (...args: unknown[]) => T;

export class QueueJob<TData, TResult = unknown, TName extends string = string> {
	status: JobStatus;
	attemptsMade = 0;
	updatedAt: Date;
	runAt?: Date;
	result?: TResult;
	error?: unknown;

	constructor(
		readonly queueName: string,
		readonly id: string,
		readonly data: TData,
		readonly maxAttempts: number,
		readonly priority: number,
		readonly createdAt: Date,
		runAt: Date | undefined,
		readonly name: TName,
	) {
		this.runAt = runAt;
		this.updatedAt = createdAt;
		this.status = runAt && runAt.getTime() > createdAt.getTime() ? 'delayed' : 'waiting';
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
			return listener(payload);
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
			return listener(payload);
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

	protected reportListenerFailure(event: string, error: unknown): void {
		this.reportListenerError(event, error);
	}

	private emitTo(listenersByEvent: Map<string, Set<QueueListener<unknown>>>, event: string, payload: unknown): void {
		for (const listener of listenersByEvent.get(event) ?? []) {
			try {
				const result = listener(payload);
				if (result && typeof (result as PromiseLike<void>).then === 'function') {
					void Promise.resolve(result).catch(error => this.reportListenerError(String(event), error));
				}
			} catch (error) {
				this.reportListenerError(String(event), error);
			}
		}
	}
}

export function defaultReportListenerError(event: string, error: unknown): void {
	const reason = error instanceof Error ? error.message : String(error);
	process.emitWarning?.(`Queue listener for "${event}" failed: ${reason}`, {
		code: 'SLIPHER_QUEUE_LISTENER_ERROR',
	});
}
