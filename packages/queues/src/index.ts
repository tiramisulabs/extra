import { createPlugin } from 'seyfert';
import {
	type Awaitable,
	type CreateQueuesOptions,
	type GlobalQueueEventName,
	type PersistentQueueOptions,
	type Queue,
	type QueueConstructor,
	type QueueDriver,
	type QueueEventMap,
	QueueJob,
	type QueueListener,
	type QueueOf,
	type QueueOptions,
	type QueueOptionsOf,
	type QueuesClientLike,
	type QueuesPlugin,
	type QueuesPluginOptions,
	type QueuesRegisterOptions,
	type QueueWorkerEventMap,
	type RegisteredQueueName,
	type WorkerEventName,
} from './core';
import { sameQueueOptions } from './helpers';
import { MemoryQueueDriver } from './memory';
import { PersistentQueueDriver } from './persistent';

export * from './core';
export * from './memory';
export * from './persistent';

type QueueMethod = string | symbol;
interface ProcessorMetadata {
	name: string;
	options?: QueueOptions;
}

interface EventMetadata {
	event: GlobalQueueEventName | WorkerEventName;
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
export class QueuesRegistry {
	private readonly queues = new Map<string, Queue<unknown, unknown>>();
	private readonly queueOptions = new Map<string, QueueOptions<never, never>>();
	private closed = false;
	private closePromise?: Promise<void>;

	constructor(private readonly options: CreateQueuesOptions) {
		if (options.processors?.length) this.register({ processors: options.processors });
	}

	register(options: QueuesRegisterOptions): Awaitable<this> {
		if (this.closed) throw new Error('@slipher/queues registry is closed.');
		const registrations = (options.processors ?? []).map(processor => this.registerProcessor(processor));
		const pending = registrations.filter(isPromiseLike);
		return pending.length ? Promise.all(pending).then(() => this) : this;
	}

	get<TName extends RegisteredQueueName>(name: TName, options?: QueueOptionsOf<TName>): QueueOf<TName>;
	get<TData = unknown, TResult = unknown>(name: string, options?: QueueOptions<TData, TResult>): Queue<TData, TResult>;
	get<TData = unknown, TResult = unknown>(name: string, options?: QueueOptions<TData, TResult>): Queue<TData, TResult> {
		return this.getOrCreateQueue(name, options);
	}

	async close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		if (this.closed) return;
		this.closed = true;
		const close = (async () => {
			try {
				if (this.options.driver.close) await this.options.driver.close();
				else {
					const results = await Promise.allSettled([...this.queues.values()].map(queue => queue.close()));
					const errors = results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []));
					if (errors.length) throw new AggregateError(errors, 'Failed to close queue registry.');
				}
			} finally {
				this.queues.clear();
				this.queueOptions.clear();
			}
		})();
		this.closePromise = close;
		return close;
	}

	async setup(client?: QueuesClientLike): Promise<void> {
		if (this.closed) throw new Error('@slipher/queues registry is closed.');
		try {
			await this.options.driver.setup?.(client);
		} catch (setupError) {
			try {
				await this.close();
			} catch (closeError) {
				throw new AggregateError([setupError, closeError], '@slipher/queues setup and rollback both failed.');
			}
			throw setupError;
		}
	}

	private registerProcessor(processor: QueueConstructor): Awaitable<void> {
		const metadata = processorMetadata.get(processor);
		if (!metadata) throw new RangeError(`Queue processor metadata missing for ${processor.name}.`);

		const instance = this.instantiate(processor);
		const prototype = processor.prototype;
		const processes = processMetadata.get(prototype) ?? [];
		if (processes.length !== 1) {
			throw new RangeError(`Queue processor "${metadata.name}" must declare exactly one @Process() handler.`);
		}

		const handler = this.getMethod(instance, processes[0]);
		const handlers = (eventMetadata.get(prototype) ?? []).map(event => ({
			event,
			handler: this.getMethod(instance, event.method),
		}));
		const queue = this.getOrCreateQueue(metadata.name, metadata.options);
		const disposers: (() => void)[] = [];

		for (const { event, handler: eventHandler } of handlers) {
			const listener = (payload: unknown) => eventHandler.call(instance, payload) as Awaitable<void>;

			if (event.scope === 'worker') {
				const workerEvents = getWorkerEventSource(queue);
				if (workerEvents) disposers.push(workerEvents.onWorker(event.event as WorkerEventName, listener));
				else disposers.push(queue.on(event.event as keyof QueueEventMap<unknown, unknown>, listener));
				continue;
			}

			disposers.push(queue.on(event.event as keyof QueueEventMap<unknown, unknown>, listener));
		}

		try {
			const registration = queue.process(job => handler.call(instance, job as QueueJob<unknown, unknown>));
			if (isPromiseLike(registration)) {
				return Promise.resolve(registration).then(undefined, error => {
					for (const dispose of disposers) dispose();
					throw error;
				});
			}
		} catch (error) {
			for (const dispose of disposers) dispose();
			throw error;
		}
	}

	private getOrCreateQueue<TData = unknown, TResult = unknown>(
		name: string,
		options?: QueueOptions<TData, TResult>,
	): Queue<TData, TResult> {
		if (this.closed) throw new Error('@slipher/queues registry is closed.');
		const mergedOptions = { ...this.options.queueDefaults, ...(options ?? {}) };
		const existing = this.queues.get(name);
		if (existing) {
			const existingOptions = this.queueOptions.get(name) ?? {};
			if (options !== undefined && !sameQueueOptions(existingOptions, mergedOptions)) {
				throw new RangeError(`Queue already registered with different options: ${name}`);
			}
			return existing as Queue<TData, TResult>;
		}

		const queue = this.options.driver.get<TData, TResult>(name, mergedOptions as QueueOptions<TData, TResult>);
		this.queues.set(name, queue as Queue<unknown, unknown>);
		this.queueOptions.set(name, mergedOptions);
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

	return createPlugin({
		name: '@slipher/queues',
		registry,
		client: {
			queues: () => registry,
		},
		ctx: {
			queues: () => registry,
		},
		setup: client => registry.setup(client),
		teardown: () => registry.close(),
	});
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

export function OnQueueEvent(event: GlobalQueueEventName): MethodDecorator {
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
function getWorkerEventSource<TData, TResult>(
	queue: Queue<TData, TResult>,
): QueueWorkerEventSource<TData, TResult> | undefined {
	const candidate = queue as unknown as QueueWorkerEventSource<TData, TResult>;
	return typeof candidate.onWorker === 'function' ? candidate : undefined;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return Boolean(value && typeof (value as PromiseLike<unknown>).then === 'function');
}
