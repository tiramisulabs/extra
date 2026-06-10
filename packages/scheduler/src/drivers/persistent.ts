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
	private readonly jobTaskIds = new Map<string, string>();
	private readonly localQueueEventJobIds = new Set<string>();
	private readonly mirroredQueueEventStartedJobIds = new Set<string>();
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
		this.localQueueEventJobIds.clear();
		this.mirroredQueueEventStartedJobIds.clear();
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
		const jobId = jobIdFromRecord(eventRecord(job));

		if (!task) {
			throw new Error(`Scheduler task "${taskId}" is not registered`);
		}

		if (this.queueEvents && jobId) this.localQueueEventJobIds.add(jobId);

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
			const result = await queue.upsertJobScheduler(task.id, schedule.repeat, schedule.template);
			this.rememberJobTaskId(result, task.id);
			return result;
		}

		if (queue.add) {
			const result = await queue.add(task.id, schedule.template.data as Record<string, unknown>, {
				jobId: `scheduler:${task.id}`,
				repeat: schedule.repeat,
			});
			this.rememberJobTaskId(result, task.id);
			return result;
		}

		throw new Error('BullMQ Queue must expose upsertJobScheduler or add');
	}

	private async enqueueImmediateRun(task: ScheduledTask) {
		const result = await this.requireQueue().add?.(
			task.id,
			{ taskId: task.id },
			{
				delay: 0,
				jobId: `${task.id}:immediate:${this.schedulerVersion}`,
			},
		);
		this.rememberJobTaskId(result, task.id);
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
			void this.emitQueueEventStarted(event);
		});
		this.queueEvents?.on?.('completed', event => {
			void this.emitQueueEventCompleted(event);
		});
		this.queueEvents?.on?.('failed', event => {
			void this.emitQueueEventFailed(event);
		});
	}

	private async emitQueueEventStarted(event: unknown) {
		try {
			const record = eventRecord(event);
			const task = await this.taskFromQueueEvent(record);
			if (task) {
				if (this.shouldMirrorQueueEventState(record)) this.markQueueEventStarted(task, record);
				this.host?.emit('started', { task });
			}
		} catch (error) {
			this.reportQueueEventFailure('active', error);
		}
	}

	private async emitQueueEventCompleted(event: unknown) {
		try {
			const record = eventRecord(event);
			const task = await this.taskFromQueueEvent(record);
			if (task) {
				if (this.shouldMirrorQueueEventState(record)) this.markQueueEventCompleted(task, record);
				this.host?.emit('completed', { task, result: record.returnvalue });
			}
			this.clearQueueEventJob(record);
		} catch (error) {
			this.reportQueueEventFailure('completed', error);
		}
	}

	private async emitQueueEventFailed(event: unknown) {
		try {
			const record = eventRecord(event);
			const task = await this.taskFromQueueEvent(record);
			const failure = new Error(String(record.failedReason ?? 'failed'));
			if (task) {
				if (this.shouldMirrorQueueEventState(record)) this.markQueueEventFailed(task, record, failure);
				this.host?.emit('failed', { task, error: failure });
			}
			this.clearQueueEventJob(record);
		} catch (error) {
			this.reportQueueEventFailure('failed', error);
		}
	}

	private shouldMirrorQueueEventState(record: Record<string, unknown>) {
		const jobId = jobIdFromRecord(record);
		return !jobId || !this.localQueueEventJobIds.has(jobId);
	}

	private markQueueEventStarted(task: ScheduledTask, record: Record<string, unknown>) {
		const jobId = jobIdFromRecord(record);
		if (jobId && this.mirroredQueueEventStartedJobIds.has(jobId)) return;

		if (jobId) this.mirroredQueueEventStartedJobIds.add(jobId);
		task.status = 'running';
		task.runCount += 1;
		task.lastRunAt = new Date();
		task.lastError = undefined;
	}

	private markQueueEventCompleted(task: ScheduledTask, record: Record<string, unknown>) {
		this.markQueueEventFinished(task, record);
		task.status = 'completed';
		task.lastError = undefined;
	}

	private markQueueEventFailed(task: ScheduledTask, record: Record<string, unknown>, error: Error) {
		this.markQueueEventFinished(task, record);
		task.status = 'failed';
		task.lastError = error;
	}

	private markQueueEventFinished(task: ScheduledTask, record: Record<string, unknown>) {
		const jobId = jobIdFromRecord(record);
		if (jobId) {
			if (!this.mirroredQueueEventStartedJobIds.has(jobId)) this.markQueueEventStarted(task, record);
			return;
		}

		if (task.status !== 'running') this.markQueueEventStarted(task, record);
	}

	private clearQueueEventJob(record: Record<string, unknown>) {
		const jobId = jobIdFromRecord(record);
		if (!jobId) return;
		this.localQueueEventJobIds.delete(jobId);
		this.mirroredQueueEventStartedJobIds.delete(jobId);
	}

	private async taskFromQueueEvent(event: unknown) {
		const record = eventRecord(event);
		const taskId = await this.taskIdFromQueueEventRecord(record);
		return taskId ? this.tasks.get(taskId) : undefined;
	}

	private async taskIdFromQueueEventRecord(record: Record<string, unknown>) {
		if (typeof record.taskId === 'string') return record.taskId;
		if (typeof record.name === 'string' && this.tasks.has(record.name)) return record.name;
		if (typeof record.jobId !== 'string') return undefined;

		const localTaskId = this.jobTaskIds.get(record.jobId);
		if (localTaskId) return localTaskId;

		const job = await this.jobFromId(record.jobId);
		return this.taskIdFromJob(job);
	}

	private async jobFromId(jobId: string) {
		const queue = this.queue;
		const fromId = this.bullmq.Job?.fromId;
		if (!queue || !fromId) return undefined;
		return fromId(queue, jobId);
	}

	private taskIdFromJob(job: BullMQJob | null | undefined) {
		if (typeof job?.data?.taskId === 'string') return job.data.taskId;
		if (typeof job?.repeatJobKey === 'string' && this.tasks.has(job.repeatJobKey)) return job.repeatJobKey;
		if (typeof job?.name === 'string' && this.tasks.has(job.name)) return job.name;
		return undefined;
	}

	private rememberJobTaskId(job: unknown, taskId: string) {
		const id = eventRecord(job).id;
		if (typeof id === 'string') this.jobTaskIds.set(id, taskId);
	}

	private reportQueueEventFailure(event: string, error: unknown) {
		this.host?.logger?.error?.({ error, event }, 'Scheduler persistent driver failed to resolve QueueEvents task');
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

function jobIdFromRecord(record: Record<string, unknown>) {
	if (typeof record.jobId === 'string') return record.jobId;
	if (typeof record.id === 'string') return record.id;
	return undefined;
}
