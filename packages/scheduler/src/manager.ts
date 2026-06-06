import { type DurationInput, InvalidDurationError, parseDuration } from './duration';
import { SchedulerEmitter } from './events';
import { getTaskMetadata, instantiateTaskSource } from './metadata';
import { ScheduledTask } from './task';
import type {
	Awaitable,
	CreateSchedulerOptions,
	ScheduledTaskDefinition,
	ScheduledTaskOptions,
	SchedulerClientLike,
	SchedulerDriver,
	SchedulerHost,
	SchedulerPlugin,
	SchedulerRunner,
	SchedulerTaskSource,
} from './types';

export class SchedulerRegistry extends SchedulerEmitter {
	private readonly driver: SchedulerDriver;
	private readonly host: SchedulerHost;
	private readonly tasks = new Map<string, ScheduledTask>();

	constructor(options: CreateSchedulerOptions) {
		super(options.logger);

		this.host = {
			emit: (event, payload) => this.emit(event, payload),
			logger: options.logger,
		};
		this.driver = options.driver;
		this.driver.attach?.(this.host);

		if (options.tasks) {
			this.register(options.tasks, options.resolveTask);
		}
	}

	setLogger(logger?: SchedulerClientLike['logger']) {
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

			try {
				return this.cron(id, schedule, runner, options);
			} catch (cronError) {
				throw new Error(
					`Scheduler schedule "${String(schedule)}" for task "${id}" is not a valid duration or cron expression.`,
					{ cause: cronError },
				);
			}
		}
	}

	interval(id: string, every: DurationInput, runner: SchedulerRunner, options?: ScheduledTaskOptions) {
		const intervalMs = parseDuration(every);

		if (intervalMs <= 0) {
			throw new Error(`Scheduler interval "${id}" must be greater than 0ms`);
		}

		return this.define({
			...options,
			explicitId: options?.explicitId ?? true,
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
			explicitId: options?.explicitId ?? true,
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
			const definitions = getTaskMetadata(instance);

			for (const definition of definitions) {
				const method = (instance as Record<string | symbol, unknown>)[definition.propertyKey];

				if (typeof method !== 'function') {
					throw new Error(`Scheduler task "${String(definition.propertyKey)}" is not a method`);
				}

				const explicitId = typeof definition.options?.id === 'string' && definition.options.id.length > 0;
				const id = explicitId ? definition.options!.id! : String(definition.propertyKey);
				const runner = (task: ScheduledTask) =>
					(method as (task: ScheduledTask) => Awaitable<unknown>).call(instance, task);

				if (definition.kind === 'interval') {
					this.interval(id, definition.schedule, runner, {
						...definition.options,
						explicitId,
						source: `${instance.constructor.name}.${String(definition.propertyKey)}`,
					});
				} else {
					this.cron(id, String(definition.schedule), runner, {
						...definition.options,
						explicitId,
						source: `${instance.constructor.name}.${String(definition.propertyKey)}`,
					});
				}
			}
		}
	}

	async resume(id: string) {
		const task = this.requireTask(id);
		await this.driver.start?.(id);
		task.status = 'scheduled';
		this.emit('resumed', { task });
	}

	/** @deprecated Use resume(id), which matches the emitted "resumed" event. */
	async start(id: string) {
		return this.resume(id);
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

	async setup(client?: SchedulerClientLike) {
		await this.driver.setup?.(client);
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

export function createScheduler(options: CreateSchedulerOptions) {
	return new SchedulerRegistry(options);
}

export function scheduler(options: CreateSchedulerOptions): SchedulerPlugin {
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
		async setup(client) {
			client.scheduler = registry;

			if (client.logger) {
				registry.setLogger(client.logger);
			}

			await registry.setup(client);
		},
		async teardown() {
			await registry.close();
		},
	};
}
