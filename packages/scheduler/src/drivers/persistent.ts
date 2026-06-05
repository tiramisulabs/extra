import { requireOptionalModule } from '../optional';
import { runTask, ScheduledTask } from '../task';
import type {
	Awaitable,
	BullMQJob,
	BullMQModule,
	BullMQQueue,
	BullMQQueueEvents,
	BullMQWorker,
	PersistentSchedulerOptions,
	ScheduledTaskDefinition,
	SchedulerClientLike,
	SchedulerDriver,
	SchedulerHost,
} from '../types';

export function persistent(options: PersistentSchedulerOptions = {}) {
	return new PersistentSchedulerDriver(options);
}

class PersistentSchedulerDriver implements SchedulerDriver {
	private readonly tasks = new Map<string, ScheduledTask>();
	private readonly templates = new Map<
		string,
		{ repeat: Record<string, unknown>; template: Record<string, unknown> }
	>();
	private readonly bullmq: BullMQModule;
	private readonly queueName: string;
	private readonly queueOptions: Record<string, unknown>;
	private readonly purgeOrphansOnStartup: boolean;
	private queue?: BullMQQueue;
	private queueEvents?: BullMQQueueEvents;
	private schedulerVersion = 0;
	private host?: SchedulerHost;
	private state: 'pending' | 'ready' | 'closed' = 'pending';
	private worker?: BullMQWorker;

	constructor(options: PersistentSchedulerOptions) {
		this.bullmq = options.bullmq ?? loadBullMQ();
		this.queueName = options.queueName ?? 'slipher:scheduler';
		this.queueOptions = createBullMQOptions(options);
		this.host = options.logger ? { emit: () => undefined, logger: options.logger } : undefined;
		this.purgeOrphansOnStartup = options.purgeOrphansOnStartup === true;
	}

	attach(host: SchedulerHost) {
		this.host = host;
	}

	async setup(client?: SchedulerClientLike) {
		if (this.state === 'ready') return;
		if (this.state === 'closed') throw new Error('Scheduler persistent driver has been stopped.');
		this.state = 'ready';
		this.schedulerVersion += 1;
		this.queue = new this.bullmq.Queue(this.queueName, this.queueOptions);
		this.worker = new this.bullmq.Worker(this.queueName, job => this.process(job, client), this.queueOptions);
		if (this.bullmq.QueueEvents) {
			this.queueEvents = new this.bullmq.QueueEvents(this.queueName, this.queueOptions);
			this.wireQueueEvents();
		}

		this.enforceExplicitIds();
		await this.detectOrphans();

		for (const task of this.tasks.values()) {
			await this.upsertTaskScheduler(task);
			if (task.runImmediately) await this.enqueueImmediateRun(task);
		}
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
		this.templates.set(task.id, { repeat, template });
		if (this.state === 'ready') this.dispatchSchedulerWrite(task, () => this.upsertTaskScheduler(task));

		return task;
	}

	async start(id: string) {
		const task = this.requireTask(id);
		await this.upsertTaskScheduler(task);
	}

	async pause(id: string) {
		this.requireTask(id);
		await this.requireQueue().removeJobScheduler?.(id);
	}

	async remove(id: string) {
		await this.requireQueue().removeJobScheduler?.(id);
		this.tasks.delete(id);
		this.templates.delete(id);
	}

	async close() {
		await this.worker?.close?.();
		await this.queueEvents?.close?.();
		await this.queue?.close?.();
		this.worker = undefined;
		this.queueEvents = undefined;
		this.queue = undefined;
		this.state = 'closed';
	}

	private async process(job: BullMQJob, client?: SchedulerClientLike) {
		if (client?.initialized === false) {
			this.host?.logger?.warn?.(
				{ jobName: job.name, taskId: job.data?.taskId },
				'Scheduler persistent driver skipped a task because the Seyfert client is not initialized',
			);
			return undefined;
		}

		const taskId = typeof job.data?.taskId === 'string' ? job.data.taskId : job.name;
		const task = this.tasks.get(taskId);

		if (!task) {
			throw new Error(`Scheduler task "${taskId}" is not registered`);
		}

		return runTask(task, this.queueEvents ? undefined : this.host);
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

	private async upsertTaskScheduler(task: ScheduledTask) {
		const schedule = this.templates.get(task.id);
		if (!schedule) throw new Error(`Scheduler task "${task.id}" is not registered`);
		const queue = this.requireQueue();

		if (queue.upsertJobScheduler) {
			return queue.upsertJobScheduler(task.id, schedule.repeat, schedule.template);
		}

		if (queue.add) {
			return queue.add(task.id, schedule.template.data as Record<string, unknown>, {
				jobId: `scheduler:${task.id}`,
				repeat: schedule.repeat,
			});
		}

		throw new Error('BullMQ Queue must expose upsertJobScheduler or add');
	}

	private async enqueueImmediateRun(task: ScheduledTask) {
		await this.requireQueue().add?.(
			task.id,
			{ taskId: task.id },
			{
				delay: 0,
				jobId: `${task.id}:immediate:${this.schedulerVersion}`,
			},
		);
	}

	private enforceExplicitIds() {
		const offenders = [...this.tasks.values()].filter(task => task.definition.explicitId !== true);
		if (!offenders.length) return;

		const names = offenders.map(task => task.definition.source ?? task.id);
		throw new Error(
			`@slipher/scheduler persistent driver requires explicit task ids. The following tasks fall back to their method name: ${names.join(
				', ',
			)}. Add { id: 'stable-task-name' } to each scheduler decorator.`,
		);
	}

	private async detectOrphans() {
		const schedulers = (await this.queue?.getJobSchedulers?.()) ?? [];
		const registered = new Set(this.tasks.keys());
		const orphans = schedulers
			.map(scheduler => scheduler.id ?? scheduler.key ?? scheduler.name)
			.filter((id): id is string => typeof id === 'string' && !registered.has(id));

		for (const id of orphans) {
			if (this.purgeOrphansOnStartup) {
				await this.queue?.removeJobScheduler?.(id);
				this.host?.logger?.info?.({ taskId: id }, 'Purged orphaned scheduler from Redis');
			} else {
				this.host?.logger?.warn?.(
					{ taskId: id },
					`Orphaned scheduler "${id}" found in Redis. To remove: scheduler.remove('${id}'). To auto-purge on startup: persistent({ purgeOrphansOnStartup: true }).`,
				);
			}
		}
	}

	private wireQueueEvents() {
		this.queueEvents?.on?.('active', event => {
			const task = this.taskFromQueueEvent(event);
			if (task) this.host?.emit('started', { task });
		});
		this.queueEvents?.on?.('completed', event => {
			const task = this.taskFromQueueEvent(event);
			if (task) this.host?.emit('completed', { task, result: eventRecord(event).returnvalue });
		});
		this.queueEvents?.on?.('failed', event => {
			const task = this.taskFromQueueEvent(event);
			if (task)
				this.host?.emit('failed', { task, error: new Error(String(eventRecord(event).failedReason ?? 'failed')) });
		});
	}

	private taskFromQueueEvent(event: unknown) {
		const record = eventRecord(event);
		const taskId = this.taskIdFromQueueEventRecord(record);
		return taskId ? this.tasks.get(taskId) : undefined;
	}

	private taskIdFromQueueEventRecord(record: Record<string, unknown>) {
		if (typeof record.taskId === 'string') return record.taskId;
		if (typeof record.name === 'string' && this.tasks.has(record.name)) return record.name;
		if (typeof record.jobId !== 'string') return undefined;

		return this.taskIdFromJobId(record.jobId);
	}

	private taskIdFromJobId(jobId: string) {
		if (this.tasks.has(jobId)) return jobId;

		if (jobId.startsWith('repeat:')) {
			const repeated = jobId.slice('repeat:'.length);
			const timestampSeparator = repeated.lastIndexOf(':');
			const schedulerId = timestampSeparator === -1 ? repeated : repeated.slice(0, timestampSeparator);
			if (this.tasks.has(schedulerId)) return schedulerId;
		}

		if (jobId.startsWith('scheduler:')) {
			const schedulerId = jobId.slice('scheduler:'.length);
			if (this.tasks.has(schedulerId)) return schedulerId;
		}

		const immediateRunSeparator = jobId.lastIndexOf(':immediate:');
		if (immediateRunSeparator > 0) {
			const taskId = jobId.slice(0, immediateRunSeparator);
			if (this.tasks.has(taskId)) return taskId;
		}

		return undefined;
	}

	private requireTask(id: string) {
		const task = this.tasks.get(id);
		if (!task) throw new Error(`Scheduler task "${id}" is not registered`);
		return task;
	}

	private requireQueue() {
		if (this.queue) return this.queue;
		if (this.state === 'closed') throw new Error('Scheduler persistent driver has been stopped.');
		throw new Error('Scheduler persistent driver is not initialized; await client.start() before using it.');
	}
}

function loadBullMQ() {
	return requireOptionalModule(
		'bullmq',
		'@slipher/scheduler persistent() requires "bullmq"; install it in the application using the persistent scheduler driver',
	) as BullMQModule;
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

function eventRecord(event: unknown): Record<string, unknown> {
	return event && typeof event === 'object' ? (event as Record<string, unknown>) : {};
}
