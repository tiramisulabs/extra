import type { LockManager } from '@slipher/locks';
import type { QueueEventMap, QueueEventName } from './events';
import type { JobOptions } from './job';
import { Queue, type QueueOptions } from './queue';

export interface SeyfertJobContext {
	command?: string;
	guildId?: string;
	channelId?: string;
	shardId?: number;
	userId?: string;
	username?: string;
	interactionId?: string;
	locale?: string;
}

export interface SeyfertQueueJob<TPayload = unknown> {
	name?: string;
	payload: TPayload;
	context: SeyfertJobContext;
}

export interface CreateSeyfertJobOptions {
	name?: string;
	context?: Partial<SeyfertJobContext>;
}

export interface QueueModuleOptions {
	lock?: LockManager;
	logger?: QueueModuleLogger;
	queueDefaults?: Omit<QueueOptions<SeyfertQueueJob, unknown>, 'lock'>;
	resolve?: <T>(target: QueueConstructor<T>) => T;
}

export interface QueueModuleRegisterOptions {
	processors?: readonly QueueConstructor[];
	producers?: readonly QueueConstructor[];
}

export interface QueueModuleLogger {
	debug?(...args: readonly unknown[]): unknown;
	info?(...args: readonly unknown[]): unknown;
	warn?(...args: readonly unknown[]): unknown;
	error?(...args: readonly unknown[]): unknown;
}

type QueueConstructor<T = object> = new (...args: unknown[]) => T;
type QueueMethod = string | symbol;
type QueueProcessHandler = (job: unknown) => unknown;

interface ProcessorMetadata {
	name: string;
	options?: Omit<QueueOptions<SeyfertQueueJob, unknown>, 'lock'>;
}

interface ProcessMetadata {
	name?: string;
	method: QueueMethod;
}

interface EventMetadata {
	event: QueueEventName;
	method: QueueMethod;
}

const processorMetadata = new WeakMap<Function, ProcessorMetadata>();
const processMetadata = new WeakMap<object, ProcessMetadata[]>();
const eventMetadata = new WeakMap<object, EventMetadata[]>();
const injectionMetadata = new WeakMap<Function, Map<number, string>>();

export function Processor(
	name: string,
	options?: Omit<QueueOptions<SeyfertQueueJob, unknown>, 'lock'>,
): ClassDecorator {
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

export function QueueEvent(event: QueueEventName): MethodDecorator {
	return (target, key) => {
		const metadata = eventMetadata.get(target) ?? [];
		metadata.push({ event, method: key });
		eventMetadata.set(target, metadata);
	};
}

export function InjectQueue(name: string): ParameterDecorator {
	return (target, _propertyKey, parameterIndex) => {
		const constructor = typeof target === 'function' ? target : target.constructor;
		const metadata = injectionMetadata.get(constructor) ?? new Map<number, string>();
		metadata.set(parameterIndex, name);
		injectionMetadata.set(constructor, metadata);
	};
}

export function createSeyfertJob<TPayload>(
	context: unknown,
	payload: TPayload,
	options: CreateSeyfertJobOptions = {},
): SeyfertQueueJob<TPayload> {
	return {
		name: options.name,
		payload,
		context: {
			...extractSeyfertJobContext(context),
			...options.context,
		},
	};
}

export function extractSeyfertJobContext(context: unknown): SeyfertJobContext {
	const source = asRecord(context);
	const interaction = asRecord(source.interaction);
	const author = asRecord(source.author ?? interaction.user);
	const resolver = asRecord(source.resolver);

	return stripUndefined({
		command: getString(source.fullCommandName ?? resolver.fullCommandName ?? getStringField(source.command, 'name')),
		guildId: getString(source.guildId ?? interaction.guildId ?? interaction.guild_id),
		channelId: getString(source.channelId ?? interaction.channelId ?? interaction.channel_id),
		shardId: getNumber(source.shardId),
		userId: getString(author.id),
		username: getString(author.username),
		interactionId: getString(interaction.id),
		locale: getString(interaction.locale ?? interaction.guildLocale ?? interaction.guild_locale),
	});
}

export class QueueModule {
	private readonly queues = new Map<string, Queue<SeyfertQueueJob, unknown>>();
	private readonly queueOptionFingerprints = new Map<string, string>();
	private readonly handlers = new Map<string, QueueProcessHandler>();
	private readonly producers = new Map<QueueConstructor, object>();

	constructor(private readonly options: QueueModuleOptions = {}) {}

	register(options: QueueModuleRegisterOptions): this {
		for (const processor of options.processors ?? []) this.registerProcessor(processor);
		for (const producer of options.producers ?? []) this.registerProducer(producer);
		return this;
	}

	get<TPayload = unknown, TResult = unknown>(name: string): Queue<SeyfertQueueJob<TPayload>, TResult> {
		return this.getOrCreateQueue(name) as Queue<SeyfertQueueJob<TPayload>, TResult>;
	}

	add<TPayload = unknown, TResult = unknown>(
		queueName: string,
		jobName: string | undefined,
		context: unknown,
		payload: TPayload,
		options?: JobOptions,
	) {
		return this.get<TPayload, TResult>(queueName).add(createSeyfertJob(context, payload, { name: jobName }), options);
	}

	getProducer<T extends object>(producer: QueueConstructor<T>): T | undefined {
		return this.producers.get(producer) as T | undefined;
	}

	private registerProcessor(processor: QueueConstructor): void {
		const metadata = processorMetadata.get(processor);
		if (!metadata) throw new RangeError(`Queue processor metadata missing for ${processor.name}.`);

		const instance = this.instantiate(processor);
		const prototype = processor.prototype;
		const queue = this.getOrCreateQueue(metadata.name, metadata.options);
		this.attachDispatcher(metadata.name, queue);

		for (const process of processMetadata.get(prototype) ?? []) {
			const handler = this.getMethod(instance, process.method);
			this.handlers.set(this.getHandlerKey(metadata.name, process.name), handler.bind(instance) as QueueProcessHandler);
			this.options.logger?.info?.(
				{ queue: metadata.name, process: process.name ?? 'default' },
				'queue process registered',
			);
		}

		for (const event of eventMetadata.get(prototype) ?? []) {
			const handler = this.getMethod(instance, event.method);
			queue.on(event.event, (...args: QueueEventMap<SeyfertQueueJob, unknown>[typeof event.event]) => {
				handler.apply(instance, args);
			});
			this.options.logger?.info?.({ queue: metadata.name, event: event.event }, 'queue event registered');
		}
	}

	private registerProducer(producer: QueueConstructor): void {
		this.producers.set(producer, this.instantiate(producer));
		this.options.logger?.info?.({ producer: producer.name }, 'queue producer registered');
	}

	private attachDispatcher(name: string, queue: Queue<SeyfertQueueJob, unknown>): void {
		queue.process(job => {
			const handler = this.handlers.get(this.getHandlerKey(name, job.data.name));
			if (!handler) throw new RangeError(`Queue process not found: ${name}:${job.data.name ?? 'default'}`);
			return handler(job);
		});
	}

	private getOrCreateQueue(
		name: string,
		options?: Omit<QueueOptions<SeyfertQueueJob, unknown>, 'lock'>,
	): Queue<SeyfertQueueJob, unknown> {
		const fingerprint = fingerprintQueueOptions({
			...this.options.queueDefaults,
			...options,
		});
		const existing = this.queues.get(name);
		if (existing) {
			if (this.queueOptionFingerprints.get(name) !== fingerprint) {
				throw new RangeError(`Queue already registered with different options: ${name}`);
			}
			return existing;
		}

		const queue = new Queue<SeyfertQueueJob, unknown>(name, {
			...this.options.queueDefaults,
			...options,
			lock: this.options.lock,
		});
		this.attachLogging(name, queue);
		this.queues.set(name, queue);
		this.queueOptionFingerprints.set(name, fingerprint);
		return queue;
	}

	private attachLogging(name: string, queue: Queue<SeyfertQueueJob, unknown>): void {
		const logger = this.options.logger;
		if (!logger) return;

		queue.on('added', job => logger.debug?.({ queue: name, jobId: job.id, ...job.data.context }, 'queue job added'));
		queue.on('completed', job =>
			logger.info?.({ queue: name, jobId: job.id, process: job.data.name, ...job.data.context }, 'queue job completed'),
		);
		queue.on('failed', (job, error) =>
			logger.error?.(
				{ queue: name, jobId: job.id, process: job.data.name, error, ...job.data.context },
				'queue job failed',
			),
		);
		queue.on('skipped', (job, error) =>
			logger.warn?.(
				{ queue: name, jobId: job.id, process: job.data.name, error, ...job.data.context },
				'queue job skipped',
			),
		);
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

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function getString(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function getStringField(value: unknown, field: string): string | undefined {
	return getString(asRecord(value)[field]);
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
	for (const key of Object.keys(value)) {
		if (value[key] === undefined) delete value[key];
	}
	return value;
}

function fingerprintQueueOptions(options: Omit<QueueOptions<SeyfertQueueJob, unknown>, 'lock'>): string {
	return JSON.stringify({
		concurrency: options.concurrency,
		attempts: options.attempts,
		retryDelay: typeof options.retryDelay === 'function' ? '[function]' : options.retryDelay,
		lockKey: typeof options.lockKey === 'function' ? '[function]' : options.lockKey,
		lockOptions: typeof options.lockOptions === 'function' ? '[function]' : options.lockOptions,
		autostart: options.autostart,
		now: options.now ? '[function]' : undefined,
		idGenerator: options.idGenerator ? '[function]' : undefined,
	});
}
