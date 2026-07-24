import type { SeyfertPlugin } from 'seyfert';
import type { SchedulerRegistry } from './manager';
import type { ScheduledTask } from './task';

export type { DurationInput } from './duration';

export type Awaitable<T> = T | Promise<T>;

export type ScheduleKind = 'cron' | 'interval';

export type SchedulerOverlapPolicy = 'allow' | 'skip';

export type ScheduledTaskStatus = 'scheduled' | 'running' | 'paused' | 'completed' | 'failed' | 'removed';

export type SchedulerRunner = (task: ScheduledTask) => Awaitable<unknown>;

export type PersistentSchedulerResource = 'queue' | 'queue-events' | 'worker';

export interface SchedulerLogger {
	error?(...args: any[]): void;
	info?(...args: any[]): void;
	warn?(...args: any[]): void;
}

export interface ScheduledTaskOptions {
	data?: Record<string, unknown>;
	explicitId?: boolean;
	overlap?: SchedulerOverlapPolicy;
	runImmediately?: boolean;
	source?: string;
}

export interface CronScheduledTaskOptions extends ScheduledTaskOptions {
	timezone?: string;
}

export interface ScheduledTaskSnapshot {
	id: string;
	kind: ScheduleKind;
	status: ScheduledTaskStatus;
	expression?: string;
	intervalMs?: number;
	overlap: SchedulerOverlapPolicy;
	timezone?: string;
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
	skipped: { task: ScheduledTask; reason: 'overlap' };
	paused: { task: ScheduledTask };
	resumed: { task: ScheduledTask };
	removed: { task: ScheduledTask };
	error: { source: PersistentSchedulerResource; error: unknown };
}

export type SchedulerEventName = keyof SchedulerEventPayloads;

export type SchedulerListener<TPayload = unknown> = (payload: TPayload) => Awaitable<void>;

export interface SchedulerHost {
	emit<TEvent extends SchedulerEventName>(event: TEvent, payload: SchedulerEventPayloads[TEvent]): void;
	logger?: SchedulerLogger;
}

export interface SchedulerDriver {
	attach?(host: SchedulerHost): void;
	prepare?(client?: SchedulerClientLike): Awaitable<void>;
	activate?(client?: SchedulerClientLike): Awaitable<void>;
	/** @deprecated Implement prepare() and activate() for lifecycle-aware drivers. */
	setup?(client?: SchedulerClientLike): Awaitable<void>;
	schedule(definition: ScheduledTaskDefinition): ScheduledTask;
	start?(id: string): Awaitable<void>;
	pause?(id: string): Awaitable<void>;
	remove?(id: string): Awaitable<void>;
	close?(): Awaitable<void>;
}

export interface ScheduledTaskDefinition extends CronScheduledTaskOptions {
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

export interface CronSchedulerDecoratorOptions extends SchedulerDecoratorOptions {
	timezone?: string;
}

export interface SchedulerPlugin
	extends SeyfertPlugin<{ scheduler: SchedulerRegistry }, { scheduler: SchedulerRegistry }> {
	name: '@slipher/scheduler';
	registry: SchedulerRegistry;
	setup(client: SchedulerClientLike): Awaitable<void>;
	teardown(client: SchedulerClientLike): Awaitable<void>;
}

export interface SchedulerClientLike {
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

export interface CronerFactoryOptions {
	/** Keeps runTask() failures observable through "failed" while allowing Croner to release its internal run state. */
	catch: true;
	interval?: number;
	name: string;
	paused: true;
	protect?: () => void;
	timezone?: string;
}

export type CronerFactory = (
	expression: string,
	options: CronerFactoryOptions,
	runner: () => Awaitable<unknown>,
) => CronerJob;

export interface PersistentSchedulerOptions {
	bullmq?: BullMQModule;
	connection?: unknown;
	immediateRunDeduplicationMs?: number;
	prefix?: string;
	purgeOrphansOnStartup?: boolean;
	queueName?: string;
	logger?: SchedulerLogger;
}

export interface BullMQModule {
	Job?: {
		fromId(queue: BullMQQueue, id: string): Awaitable<BullMQJob | null | undefined>;
	};
	Queue: new (name: string, options?: Record<string, unknown>) => BullMQQueue;
	QueueEvents?: new (name: string, options?: Record<string, unknown>) => BullMQQueueEvents;
	Worker: new (
		name: string,
		processor: (job: BullMQJob) => Awaitable<unknown>,
		options?: Record<string, unknown>,
	) => BullMQWorker;
}

export interface BullMQQueue {
	on(event: string, listener: (...args: unknown[]) => void): unknown;
	waitUntilReady(): Awaitable<unknown>;
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
	on(event: string, listener: (...args: unknown[]) => void): unknown;
	waitUntilReady(): Awaitable<unknown>;
	isRunning(): boolean;
	run(): Awaitable<unknown>;
	close?(): Awaitable<unknown>;
}

export interface BullMQQueueEvents {
	on(event: string, listener: (...args: unknown[]) => void): unknown;
	waitUntilReady(): Awaitable<unknown>;
	close?(): Awaitable<unknown>;
}

export interface BullMQJob {
	attemptsMade?: number;
	id?: string;
	name: string;
	data?: Record<string, unknown>;
	repeatJobKey?: string;
}
