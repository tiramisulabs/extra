export type Awaitable<T> = T | PromiseLike<T>;

export type DurationInput = number | string;

export type ScheduleKind = 'cron' | 'interval';

export type ScheduledTaskStatus = 'scheduled' | 'running' | 'paused' | 'completed' | 'failed' | 'removed';

export type SchedulerRunner = (task: ScheduledTask) => Awaitable<unknown>;

export interface SchedulerLogger {
	error?(...args: any[]): void;
	warn?(...args: any[]): void;
}

export interface ScheduledTaskOptions {
	data?: Record<string, unknown>;
	runImmediately?: boolean;
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
	schedule(definition: ScheduledTaskDefinition): ScheduledTask;
	start?(id: string): Awaitable<void>;
	pause?(id: string): Awaitable<void>;
	remove?(id: string): Awaitable<void>;
	close?(): Awaitable<void>;
}

export interface ScheduledTaskDefinition extends ScheduledTaskOptions {
	id: string;
	kind: ScheduleKind;
	expression?: string;
	intervalMs?: number;
	runner: SchedulerRunner;
}

export interface CreateSchedulerOptions {
	driver?: SchedulerDriver;
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

export interface SchedulerPlugin {
	name: '@slipher/scheduler';
	registry: SchedulerRegistry;
	options(client?: unknown): {
		context(client?: unknown): {
			scheduler: SchedulerRegistry;
		};
	};
	setup(client: Record<string, unknown> & { logger?: SchedulerLogger }): Awaitable<void>;
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
	queueName?: string;
	logger?: SchedulerLogger;
}

export interface BullMQModule {
	Queue: new (name: string, options?: Record<string, unknown>) => BullMQQueue;
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
	removeJobScheduler?(id: string): Awaitable<unknown>;
	close?(): Awaitable<unknown>;
}

export interface BullMQWorker {
	close?(): Awaitable<unknown>;
}

export interface BullMQJob {
	name: string;
	data?: Record<string, unknown>;
}

interface TaskMetadata {
	kind: ScheduleKind;
	schedule: DurationInput;
	propertyKey: string | symbol;
	options?: SchedulerDecoratorOptions;
}

const taskMetadata = new WeakMap<Function, TaskMetadata[]>();

const durationUnits: Record<string, number> = {
	ms: 1,
	millisecond: 1,
	milliseconds: 1,
	s: 1_000,
	sec: 1_000,
	second: 1_000,
	seconds: 1_000,
	m: 60_000,
	min: 60_000,
	minute: 60_000,
	minutes: 60_000,
	h: 3_600_000,
	hr: 3_600_000,
	hour: 3_600_000,
	hours: 3_600_000,
	d: 86_400_000,
	day: 86_400_000,
	days: 86_400_000,
};

export class ScheduledTask {
	readonly createdAt = new Date();
	readonly data?: Record<string, unknown>;
	lastError?: unknown;
	lastRunAt?: Date;
	nextRunAt?: Date;
	runCount = 0;
	status: ScheduledTaskStatus = 'scheduled';

	constructor(readonly definition: ScheduledTaskDefinition) {
		this.data = definition.data;
	}

	get id() {
		return this.definition.id;
	}

	get kind() {
		return this.definition.kind;
	}

	get expression() {
		return this.definition.expression;
	}

	get intervalMs() {
		return this.definition.intervalMs;
	}

	get runner() {
		return this.definition.runner;
	}

	get runImmediately() {
		return this.definition.runImmediately === true;
	}

	snapshot(): ScheduledTaskSnapshot {
		return {
			id: this.id,
			kind: this.kind,
			status: this.status,
			expression: this.expression,
			intervalMs: this.intervalMs,
			runCount: this.runCount,
			createdAt: this.createdAt,
			lastRunAt: this.lastRunAt,
			nextRunAt: this.nextRunAt,
			lastError: this.lastError,
			data: this.data,
		};
	}
}

class SchedulerEmitter {
	private listeners = new Map<string, Set<SchedulerListener<any>>>();

	constructor(private logger?: SchedulerLogger) {}

	setLogger(logger?: SchedulerLogger) {
		this.logger = logger;
	}

	on<TEvent extends SchedulerEventName>(event: TEvent, listener: SchedulerListener<SchedulerEventPayloads[TEvent]>) {
		const listeners = this.listeners.get(event) ?? new Set<SchedulerListener<any>>();
		listeners.add(listener as SchedulerListener<any>);
		this.listeners.set(event, listeners);

		return () => this.off(event, listener);
	}

	once<TEvent extends SchedulerEventName>(event: TEvent, listener: SchedulerListener<SchedulerEventPayloads[TEvent]>) {
		const off = this.on(event, payload => {
			off();
			return listener(payload);
		});

		return off;
	}

	off<TEvent extends SchedulerEventName>(event: TEvent, listener: SchedulerListener<SchedulerEventPayloads[TEvent]>) {
		this.listeners.get(event)?.delete(listener as SchedulerListener<any>);
	}

	emit<TEvent extends SchedulerEventName>(event: TEvent, payload: SchedulerEventPayloads[TEvent]) {
		for (const listener of this.listeners.get(event) ?? []) {
			try {
				const result = listener(payload);
				Promise.resolve(result).catch(error => this.reportListenerError(event, error));
			} catch (error) {
				this.reportListenerError(event, error);
			}
		}
	}

	private reportListenerError(event: string, error: unknown) {
		if (this.logger?.error) {
			this.logger.error({ event, error }, 'Scheduler listener failed');
			return;
		}

		if (typeof process !== 'undefined' && typeof process.emitWarning === 'function') {
			process.emitWarning(error instanceof Error ? error : String(error), {
				type: 'SchedulerListenerError',
			});
		}
	}
}

export class SchedulerRegistry extends SchedulerEmitter {
	private readonly driver: SchedulerDriver;
	private readonly host: SchedulerHost;
	private readonly tasks = new Map<string, ScheduledTask>();

	constructor(options: CreateSchedulerOptions = {}) {
		super(options.logger);

		this.host = {
			emit: (event, payload) => this.emit(event, payload),
			logger: options.logger,
		};
		this.driver = options.driver ?? memory({ logger: options.logger });
		this.driver.attach?.(this.host);

		if (options.tasks) {
			this.register(options.tasks, options.resolveTask);
		}
	}

	setLogger(logger?: SchedulerLogger) {
		super.setLogger(logger);
		this.host.logger = logger;
	}

	add(id: string, schedule: DurationInput, runner: SchedulerRunner, options?: ScheduledTaskOptions) {
		try {
			return this.interval(id, schedule, runner, options);
		} catch (error) {
			if (!(error instanceof InvalidDurationError)) {
				throw error;
			}

			if (typeof schedule !== 'string') {
				throw error;
			}

			return this.cron(id, schedule, runner, options);
		}
	}

	interval(id: string, every: DurationInput, runner: SchedulerRunner, options?: ScheduledTaskOptions) {
		const intervalMs = parseDuration(every);

		if (intervalMs <= 0) {
			throw new Error(`Scheduler interval "${id}" must be greater than 0ms`);
		}

		return this.define({
			...options,
			id,
			kind: 'interval',
			intervalMs,
			runner,
		});
	}

	cron(id: string, expression: string, runner: SchedulerRunner, options?: ScheduledTaskOptions) {
		const normalizedExpression = expression.trim();

		if (!normalizedExpression) {
			throw new Error(`Scheduler cron task "${id}" requires a cron expression`);
		}

		return this.define({
			...options,
			id,
			kind: 'cron',
			expression: normalizedExpression,
			runner,
		});
	}

	get(id: string) {
		return this.tasks.get(id);
	}

	list() {
		return [...this.tasks.values()];
	}

	snapshot() {
		return this.list().map(task => task.snapshot());
	}

	register(tasks: SchedulerTaskSource[], resolveTask?: (source: SchedulerTaskSource) => object) {
		for (const source of tasks) {
			const instance = resolveTask?.(source) ?? instantiateTaskSource(source);
			const definitions = taskMetadata.get(instance.constructor) ?? [];

			for (const definition of definitions) {
				const method = (instance as Record<string | symbol, unknown>)[definition.propertyKey];

				if (typeof method !== 'function') {
					throw new Error(`Scheduler task "${String(definition.propertyKey)}" is not a method`);
				}

				const id = definition.options?.id ?? String(definition.propertyKey);
				const runner = (task: ScheduledTask) =>
					(method as (task: ScheduledTask) => Awaitable<unknown>).call(instance, task);

				if (definition.kind === 'interval') {
					this.interval(id, definition.schedule, runner, definition.options);
				} else {
					this.cron(id, String(definition.schedule), runner, definition.options);
				}
			}
		}
	}

	async start(id: string) {
		const task = this.requireTask(id);
		await this.driver.start?.(id);
		task.status = 'scheduled';
		this.emit('resumed', { task });
	}

	async pause(id: string) {
		const task = this.requireTask(id);
		await this.driver.pause?.(id);
		task.status = 'paused';
		this.emit('paused', { task });
	}

	async remove(id: string) {
		const task = this.requireTask(id);
		await this.driver.remove?.(id);
		task.status = 'removed';
		this.tasks.delete(id);
		this.emit('removed', { task });
	}

	async close() {
		await this.driver.close?.();
	}

	private define(definition: ScheduledTaskDefinition) {
		if (this.tasks.has(definition.id)) {
			throw new Error(`Scheduler task "${definition.id}" is already registered`);
		}

		const task = this.driver.schedule(definition);
		this.tasks.set(task.id, task);
		this.emit('scheduled', { task });

		return task;
	}

	private requireTask(id: string) {
		const task = this.tasks.get(id);

		if (!task) {
			throw new Error(`Scheduler task "${id}" is not registered`);
		}

		return task;
	}
}

export class InvalidDurationError extends Error {
	constructor(input: DurationInput) {
		super(`Invalid duration: ${String(input)}`);
		this.name = 'InvalidDurationError';
	}
}

export function parseDuration(input: DurationInput) {
	if (typeof input === 'number') {
		if (Number.isFinite(input) && input >= 0) {
			return input;
		}

		throw new InvalidDurationError(input);
	}

	const source = input.trim().toLowerCase();

	if (!source) {
		throw new InvalidDurationError(input);
	}

	let total = 0;
	let consumed = 0;
	const matcher = /\s*(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|sec|s|minutes?|min|m|hours?|hr|h|days?|d)\s*/gy;

	for (let match = matcher.exec(source); match; match = matcher.exec(source)) {
		consumed += match[0].length;
		total += Number(match[1]) * durationUnits[match[2]!]!;
	}

	if (consumed !== source.length || total <= 0) {
		throw new InvalidDurationError(input);
	}

	return total;
}

export function createScheduler(options: CreateSchedulerOptions = {}) {
	return new SchedulerRegistry(options);
}

export function scheduler(options: CreateSchedulerOptions = {}): SchedulerPlugin {
	const registry = createScheduler(options);

	return {
		name: '@slipher/scheduler',
		registry,
		options() {
			return {
				context() {
					return { scheduler: registry };
				},
			};
		},
		setup(client) {
			client.scheduler = registry;

			if (client.logger) {
				registry.setLogger(client.logger);
			}
		},
	};
}

export function Interval(schedule: DurationInput, options?: SchedulerDecoratorOptions): MethodDecorator {
	return (target, propertyKey) => {
		addTaskMetadata(target, {
			kind: 'interval',
			schedule,
			propertyKey,
			options,
		});
	};
}

export function Cron(expression: string, options?: SchedulerDecoratorOptions): MethodDecorator {
	return (target, propertyKey) => {
		addTaskMetadata(target, {
			kind: 'cron',
			schedule: expression,
			propertyKey,
			options,
		});
	};
}

export function memory(options: MemorySchedulerOptions = {}) {
	return new MemorySchedulerDriver(options);
}

export function persistent(options: PersistentSchedulerOptions = {}) {
	return new PersistentSchedulerDriver(options);
}

class MemorySchedulerDriver implements SchedulerDriver {
	private readonly croner: CronerFactory;
	private readonly jobs = new Map<string, CronerJob>();
	private host?: SchedulerHost;

	constructor(options: MemorySchedulerOptions) {
		this.croner = options.croner ?? defaultCronerFactory;
		this.host = options.logger ? { emit: () => undefined, logger: options.logger } : undefined;
	}

	attach(host: SchedulerHost) {
		this.host = host;
	}

	schedule(definition: ScheduledTaskDefinition) {
		const task = new ScheduledTask(definition);
		const expression = definition.kind === 'interval' ? '* * * * * *' : definition.expression!;
		const options: Record<string, unknown> = {
			name: definition.id,
		};

		if (definition.kind === 'interval') {
			options.interval = definition.intervalMs! / 1_000;
		}

		let job: CronerJob | undefined;
		job = this.croner(expression, options, () => this.run(task, job));
		this.jobs.set(task.id, job);

		if (task.runImmediately) {
			void Promise.resolve()
				.then(() => this.run(task, job))
				.catch(error => {
					this.host?.logger?.error?.(
						{ taskId: task.id, error },
						'Scheduler memory driver failed to run immediate task',
					);
				});
		}

		return task;
	}

	async start(id: string) {
		this.jobs.get(id)?.resume?.();
	}

	async pause(id: string) {
		this.jobs.get(id)?.pause?.();
	}

	async remove(id: string) {
		this.jobs.get(id)?.stop?.();
		this.jobs.delete(id);
	}

	async close() {
		for (const job of this.jobs.values()) {
			job.stop?.();
		}

		this.jobs.clear();
	}

	private async run(task: ScheduledTask, job?: CronerJob) {
		return runTask(task, this.host, () => job?.nextRun?.() ?? undefined);
	}
}

class PersistentSchedulerDriver implements SchedulerDriver {
	private readonly queue: BullMQQueue;
	private readonly tasks = new Map<string, ScheduledTask>();
	private readonly worker: BullMQWorker;
	private host?: SchedulerHost;

	constructor(options: PersistentSchedulerOptions) {
		const bullmq = options.bullmq ?? loadBullMQ();
		const queueOptions = createBullMQOptions(options);
		const queueName = options.queueName ?? 'slipher:scheduler';

		this.queue = new bullmq.Queue(queueName, queueOptions);
		this.worker = new bullmq.Worker(queueName, job => this.process(job), queueOptions);
		this.host = options.logger ? { emit: () => undefined, logger: options.logger } : undefined;
	}

	attach(host: SchedulerHost) {
		this.host = host;
	}

	schedule(definition: ScheduledTaskDefinition) {
		const task = new ScheduledTask(definition);
		const repeat =
			definition.kind === 'interval' ? { every: definition.intervalMs! } : { pattern: definition.expression! };
		const template = {
			name: definition.id,
			data: { taskId: definition.id },
		};

		this.tasks.set(task.id, task);
		this.dispatchSchedulerWrite(task, () => {
			if (this.queue.upsertJobScheduler) {
				return this.queue.upsertJobScheduler(definition.id, repeat, template);
			}

			if (this.queue.add) {
				return this.queue.add(definition.id, template.data, {
					jobId: `scheduler:${definition.id}`,
					repeat,
				});
			}

			throw new Error('BullMQ Queue must expose upsertJobScheduler or add');
		});

		return task;
	}

	async remove(id: string) {
		await this.queue.removeJobScheduler?.(id);
		this.tasks.delete(id);
	}

	async close() {
		await this.worker.close?.();
		await this.queue.close?.();
	}

	private async process(job: BullMQJob) {
		const taskId = typeof job.data?.taskId === 'string' ? job.data.taskId : job.name;
		const task = this.tasks.get(taskId);

		if (!task) {
			throw new Error(`Scheduler task "${taskId}" is not registered`);
		}

		return runTask(task, this.host);
	}

	private dispatchSchedulerWrite(task: ScheduledTask, write: () => Awaitable<unknown>) {
		try {
			Promise.resolve(write()).catch(error => this.reportSchedulerWriteFailure(task, error));
		} catch (error) {
			this.reportSchedulerWriteFailure(task, error);
		}
	}

	private reportSchedulerWriteFailure(task: ScheduledTask, error: unknown) {
		task.status = 'failed';
		task.lastError = error;
		this.host?.logger?.error?.({ taskId: task.id, error }, 'Scheduler persistent driver failed to schedule task');
		this.host?.emit('failed', { task, error });
	}
}

async function runTask(task: ScheduledTask, host?: SchedulerHost, nextRun?: () => Date | null | undefined) {
	task.status = 'running';
	task.runCount += 1;
	task.lastRunAt = new Date();
	task.lastError = undefined;
	host?.emit('started', { task });

	try {
		const result = await task.runner(task);
		task.status = 'completed';
		task.nextRunAt = nextRun?.() ?? undefined;
		host?.emit('completed', { task, result });

		return result;
	} catch (error) {
		task.status = 'failed';
		task.lastError = error;
		task.nextRunAt = nextRun?.() ?? undefined;
		host?.emit('failed', { task, error });
		throw error;
	}
}

function addTaskMetadata(target: object, metadata: TaskMetadata) {
	const constructor = typeof target === 'function' ? target : target.constructor;
	const definitions = taskMetadata.get(constructor) ?? [];

	definitions.push(metadata);
	taskMetadata.set(constructor, definitions);
}

function instantiateTaskSource(source: SchedulerTaskSource) {
	if (typeof source === 'function') {
		const Task = source as SchedulerTaskConstructor;

		return new Task();
	}

	return source;
}

function defaultCronerFactory(expression: string, options: Record<string, unknown>, runner: () => Awaitable<unknown>) {
	const croner = loadCroner();
	const Cron = croner.Cron;

	return new Cron(expression, options, runner) as CronerJob;
}

function loadCroner() {
	return requireOptionalModule('croner', '@slipher/scheduler requires "croner" for the memory driver') as {
		Cron: new (expression: string, options: Record<string, unknown>, runner: () => Awaitable<unknown>) => unknown;
	};
}

function loadBullMQ() {
	return requireOptionalModule(
		'bullmq',
		'@slipher/scheduler persistent() requires "bullmq"; install it in the application using the persistent scheduler driver',
	) as BullMQModule;
}

function requireOptionalModule(id: string, message: string) {
	if (typeof require !== 'function') {
		throw new Error(message);
	}

	try {
		return require(id);
	} catch (error) {
		const missing = error instanceof Error && 'code' in error && error.code === 'MODULE_NOT_FOUND';

		if (missing) {
			throw new Error(message);
		}

		throw error;
	}
}

function createBullMQOptions(options: PersistentSchedulerOptions) {
	const queueOptions: Record<string, unknown> = {};

	if (options.connection) {
		queueOptions.connection = options.connection;
	}

	if (options.prefix) {
		queueOptions.prefix = options.prefix;
	}

	return queueOptions;
}
