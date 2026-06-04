import type { SchedulerRegistry } from './manager';
import type { ScheduledTask } from './task';

export type Awaitable<T> = T | PromiseLike<T>;

export type ScheduleKind = 'cron' | 'interval';

export type ScheduledTaskStatus = 'scheduled' | 'running' | 'paused' | 'completed' | 'failed' | 'removed';

export type SchedulerRunner = (task: ScheduledTask) => Awaitable<unknown>;

export interface SchedulerLogger {
	error?(...args: any[]): void;
	info?(...args: any[]): void;
	warn?(...args: any[]): void;
}

export interface ScheduledTaskOptions {
	data?: Record<string, unknown>;
	explicitId?: boolean;
	runImmediately?: boolean;
	source?: string;
}

export interface ScheduledTaskSnapshot {
	id: string;
	kind: ScheduleKind;
	status: ScheduledTaskStatus;
	expression?: string;
	intervalMs?: number;
	runCount: number;
	createdAt: Date;
	lastRunAt?: Date;
	nextRunAt?: Date;
	lastError?: unknown;
	data?: Record<string, unknown>;
}

export interface SchedulerEventPayloads {
	scheduled: { task: ScheduledTask };
	started: { task: ScheduledTask };
	completed: { task: ScheduledTask; result: unknown };
	failed: { task: ScheduledTask; error: unknown };
	paused: { task: ScheduledTask };
	resumed: { task: ScheduledTask };
	removed: { task: ScheduledTask };
}

export type SchedulerEventName = keyof SchedulerEventPayloads;

export type SchedulerListener<TPayload = unknown> = (payload: TPayload) => Awaitable<void>;

export interface SchedulerHost {
	emit<TEvent extends SchedulerEventName>(event: TEvent, payload: SchedulerEventPayloads[TEvent]): void;
	logger?: SchedulerLogger;
}

export interface SchedulerDriver {
	attach?(host: SchedulerHost): void;
	setup?(client?: SchedulerClientLike): Awaitable<void>;
	schedule(definition: ScheduledTaskDefinition): ScheduledTask;
	start?(id: string): Awaitable<void>;
	pause?(id: string): Awaitable<void>;
	remove?(id: string): Awaitable<void>;
	close?(): Awaitable<void>;
}

export interface ScheduledTaskDefinition extends ScheduledTaskOptions {
	id: string;
	explicitId?: boolean;
	kind: ScheduleKind;
	expression?: string;
	intervalMs?: number;
	runner: SchedulerRunner;
	source?: string;
}

export interface CreateSchedulerOptions {
	driver: SchedulerDriver;
	logger?: SchedulerLogger;
	purgeOrphansOnStartup?: boolean;
	tasks?: SchedulerTaskSource[];
	resolveTask?: (source: SchedulerTaskSource) => object;
}

export interface SchedulerTaskConstructor {
	new (): object;
}

export type SchedulerTaskSource = SchedulerTaskConstructor | object;

export interface SchedulerDecoratorOptions extends ScheduledTaskOptions {
	id?: string;
}

export interface SchedulerPlugin {
	name: '@slipher/scheduler';
	registry: SchedulerRegistry;
	options(client?: unknown): {
		context(client?: unknown): {
			scheduler: SchedulerRegistry;
		};
	};
	setup(client: SchedulerClientLike): Awaitable<void>;
	teardown(client: SchedulerClientLike): Awaitable<void>;
}

export interface SchedulerClientLike extends Record<string, unknown> {
	initialized?: boolean;
	logger?: SchedulerLogger;
	scheduler?: SchedulerRegistry;
}

export interface MemorySchedulerOptions {
	croner?: CronerFactory;
	logger?: SchedulerLogger;
}

export interface CronerJob {
	pause?(): void;
	resume?(): void;
	stop?(): void;
	nextRun?(): Date | null | undefined;
}

export type CronerFactory = (
	expression: string,
	options: Record<string, unknown>,
	runner: () => Awaitable<unknown>,
) => CronerJob;

export interface PersistentSchedulerOptions {
	bullmq?: BullMQModule;
	connection?: unknown;
	prefix?: string;
	purgeOrphansOnStartup?: boolean;
	queueName?: string;
	logger?: SchedulerLogger;
}

export interface BullMQModule {
	Queue: new (name: string, options?: Record<string, unknown>) => BullMQQueue;
	QueueEvents?: new (name: string, options?: Record<string, unknown>) => BullMQQueueEvents;
	Worker: new (
		name: string,
		processor: (job: BullMQJob) => Awaitable<unknown>,
		options?: Record<string, unknown>,
	) => BullMQWorker;
}

export interface BullMQQueue {
	upsertJobScheduler?(
		id: string,
		repeat: Record<string, unknown>,
		template: Record<string, unknown>,
	): Awaitable<unknown>;
	add?(name: string, data: Record<string, unknown>, options: Record<string, unknown>): Awaitable<unknown>;
	getJobSchedulers?(): Awaitable<Array<{ id?: string; key?: string; name?: string }>>;
	removeJobScheduler?(id: string): Awaitable<unknown>;
	close?(): Awaitable<unknown>;
}

export interface BullMQWorker {
	close?(): Awaitable<unknown>;
}

export interface BullMQQueueEvents {
	on?(event: string, listener: (...args: unknown[]) => void): unknown;
	close?(): Awaitable<unknown>;
}

export interface BullMQJob {
	name: string;
	data?: Record<string, unknown>;
}
