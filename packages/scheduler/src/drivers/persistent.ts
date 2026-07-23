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
	PersistentSchedulerResource,
	ScheduledTaskDefinition,
	SchedulerClientLike,
	SchedulerDriver,
	SchedulerHost,
	SchedulerLogger,
} from '../types';

const MAX_TRACKED_JOB_STATES = 10_000;

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
	private readonly fallbackLogger?: SchedulerLogger;
	private readonly queueName: string;
	private readonly queueOptions: Record<string, unknown>;
	private readonly activeJobIds = new Set<string>();
	private readonly jobTaskIds = new Map<string, string>();
	private readonly localJobAttempts = new Map<string, number>();
	private readonly queueEventActiveJobIds = new Set<string>();
	private readonly queueEventAttempts = new Map<string, number>();
	private readonly terminalJobStates = new Map<string, 'completed' | 'failed'>();
	private readonly immediateRunDeduplicationMs: number;
	private readonly purgeOrphansOnStartup: boolean;
	private activationGate?: ReturnType<typeof createActivationGate>;
	private activationPromise?: Promise<void>;
	private closePromise?: Promise<void>;
	private queue?: BullMQQueue;
	private queueEventChain = Promise.resolve();
	private queueEvents?: BullMQQueueEvents;
	private preparePromise?: Promise<void>;
	private host?: SchedulerHost;
	private state: 'pending' | 'preparing' | 'prepared' | 'ready' | 'closing' | 'closed' = 'pending';
	private worker?: BullMQWorker;

	constructor(options: PersistentSchedulerOptions) {
		this.bullmq = options.bullmq ?? loadBullMQ();
		this.fallbackLogger = options.logger;
		this.queueName = options.queueName ?? 'slipher:scheduler';
		this.queueOptions = createBullMQOptions(options);
		this.host = options.logger ? { emit: () => undefined, logger: options.logger } : undefined;
		this.immediateRunDeduplicationMs = options.immediateRunDeduplicationMs ?? 60_000;
		if (!Number.isSafeInteger(this.immediateRunDeduplicationMs) || this.immediateRunDeduplicationMs <= 0) {
			throw new RangeError('Scheduler immediate run deduplication window must be a positive integer');
		}
		this.purgeOrphansOnStartup = options.purgeOrphansOnStartup === true;
	}

	attach(host: SchedulerHost) {
		host.logger ??= this.fallbackLogger;
		this.host = host;
	}

	prepare(client?: SchedulerClientLike) {
		if (this.closePromise || this.state === 'closing' || this.state === 'closed') {
			return Promise.reject(new Error('Scheduler persistent driver has been stopped.'));
		}
		if (this.state === 'prepared' || this.state === 'ready') return Promise.resolve();
		if (this.preparePromise) return this.preparePromise;

		this.preparePromise = this.initialize(client);
		return this.preparePromise;
	}

	activate(client?: SchedulerClientLike) {
		if (this.closePromise || this.state === 'closing' || this.state === 'closed') {
			return Promise.reject(new Error('Scheduler persistent driver has been stopped.'));
		}
		if (this.state === 'ready') return Promise.resolve();
		if (this.activationPromise) return this.activationPromise;

		this.activationPromise = this.activatePrepared(client);
		return this.activationPromise;
	}

	schedule(definition: ScheduledTaskDefinition) {
		if (definition.overlap === 'skip') {
			throw new Error(
				'@slipher/scheduler persistent driver does not support overlap: "skip"; use memory() or coordinate overlap inside the task',
			);
		}

		const task = new ScheduledTask(definition);
		const repeat =
			definition.kind === 'interval'
				? { every: definition.intervalMs }
				: {
						pattern: definition.expression,
						...(definition.timezone !== undefined ? { tz: definition.timezone } : {}),
					};
		const template = {
			name: definition.id,
			data: { taskId: definition.id },
		};

		this.tasks.set(task.id, task);
		this.templates.set(task.id, { repeat, template });
		if (this.state === 'prepared' || this.state === 'ready') {
			this.dispatchSchedulerWrite(task, () => this.syncScheduledTask(task));
		}

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

	close() {
		if (this.closePromise) return this.closePromise;
		if (this.state === 'closed') return Promise.resolve();

		this.state = 'closing';
		this.closePromise = this.shutdown();
		return this.closePromise;
	}

	private async shutdown() {
		if (this.activationPromise) {
			try {
				await this.activationPromise;
			} catch {
				// Activation reports its own error and leaves prepared resources for shutdown.
			}
		} else if (this.preparePromise) {
			try {
				await this.preparePromise;
			} catch {
				// initialize() already rolled back any resources it opened.
			}
		}

		const errors = await this.closeResources();
		this.state = 'closed';
		this.closePromise = undefined;
		if (errors.length) throw new AggregateError(errors, 'Scheduler persistent driver failed to close');
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

		if (!this.queueEvents || !jobId) return runTask(task, this.host);

		this.markLocalAttempt(jobId, job);
		this.startJob(task, eventRecord(job));
		try {
			const result = await runTask(task, undefined, undefined, { alreadyStarted: true });
			this.activeJobIds.delete(jobId);
			this.rememberTerminalJobState(jobId, 'completed');
			this.host?.emit('completed', { task, result });
			return result;
		} catch (error) {
			this.activeJobIds.delete(jobId);
			this.rememberTerminalJobState(jobId, 'failed');
			this.host?.emit('failed', { task, error });
			throw error;
		}
	}

	private async initialize(client?: SchedulerClientLike) {
		try {
			this.enforceExplicitIds();
			this.state = 'preparing';
			this.queue = new this.bullmq.Queue(this.queueName, this.queueOptions);
			this.wireResourceErrors(this.queue, 'queue');
			const activationGate = createActivationGate();
			this.activationGate = activationGate;
			this.worker = new this.bullmq.Worker(
				this.queueName,
				async job => {
					if (!(await activationGate.promise)) {
						throw new Error('Scheduler persistent driver stopped before task activation');
					}
					return this.process(job, client);
				},
				{
					...this.queueOptions,
					autorun: false,
				},
			);
			this.wireResourceErrors(this.worker, 'worker');
			if (this.bullmq.QueueEvents) {
				this.queueEvents = new this.bullmq.QueueEvents(this.queueName, this.queueOptions);
				this.wireResourceErrors(this.queueEvents, 'queue-events');
				this.wireQueueEvents();
			}

			await Promise.all([
				this.queue.waitUntilReady(),
				this.worker.waitUntilReady(),
				this.queueEvents?.waitUntilReady(),
			]);
			await this.detectOrphans();
			for (const task of this.tasks.values()) {
				await this.upsertTaskScheduler(task);
				if (task.runImmediately) await this.enqueueImmediateRun(task);
			}
			await this.startWorker();
			if (!this.closePromise) this.state = 'prepared';
		} catch (error) {
			const cleanupErrors = await this.closeResources();
			this.state = cleanupErrors.length ? 'closed' : 'pending';
			if (cleanupErrors.length) {
				throw new AggregateError(
					[error, ...cleanupErrors],
					'Scheduler persistent driver setup failed and cleanup was incomplete',
				);
			}
			throw error;
		} finally {
			this.preparePromise = undefined;
		}
	}

	private async activatePrepared(client?: SchedulerClientLike) {
		try {
			await this.prepare(client);
			if (this.closePromise || this.state === 'closing' || this.state === 'closed') {
				throw new Error('Scheduler persistent driver has been stopped.');
			}

			this.state = 'ready';
			this.activationGate?.activate();
		} finally {
			this.activationPromise = undefined;
		}
	}

	private async closeResources() {
		const errors: unknown[] = [];
		const worker = this.worker;
		const queueEvents = this.queueEvents;
		const queue = this.queue;
		this.activationGate?.cancel();
		this.activationGate = undefined;
		this.worker = undefined;
		this.queueEvents = undefined;

		for (const resource of [worker, queueEvents]) {
			try {
				await resource?.close?.();
			} catch (error) {
				errors.push(error);
			}
		}
		await this.queueEventChain;
		try {
			await queue?.close?.();
		} catch (error) {
			errors.push(error);
		} finally {
			if (this.queue === queue) this.queue = undefined;
		}

		this.activeJobIds.clear();
		this.jobTaskIds.clear();
		this.localJobAttempts.clear();
		this.queueEventActiveJobIds.clear();
		this.queueEventAttempts.clear();
		this.terminalJobStates.clear();
		return errors;
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

	private async syncScheduledTask(task: ScheduledTask) {
		await this.upsertTaskScheduler(task);
		if ((this.state === 'prepared' || this.state === 'ready') && task.runImmediately) {
			await this.enqueueImmediateRun(task);
		}
	}

	private async enqueueImmediateRun(task: ScheduledTask) {
		const result = await this.requireQueue().add?.(
			task.id,
			{ taskId: task.id },
			{
				deduplication: {
					id: `slipher:scheduler:immediate:${task.id}`,
					ttl: this.immediateRunDeduplicationMs,
				},
				delay: 0,
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
					`Orphaned scheduler "${id}" found in Redis. To remove: scheduler.removeOrphan('${id}'). To auto-purge on startup: persistent({ purgeOrphansOnStartup: true }).`,
				);
			}
		}
	}

	private wireResourceErrors(
		resource: Pick<BullMQQueue | BullMQQueueEvents | BullMQWorker, 'on'>,
		source: PersistentSchedulerResource,
	) {
		resource.on('error', error => this.reportResourceError(source, error));
	}

	private async startWorker() {
		const worker = this.worker;
		if (!worker) throw new Error('Scheduler persistent worker is not initialized');

		let starting = true;
		let startupError: unknown;
		try {
			const started = worker.run();
			void Promise.resolve(started).catch(error => {
				if (starting) {
					startupError = error;
					return;
				}
				this.reportWorkerRunFailure(error);
			});
		} catch (error) {
			startupError = error;
		}

		await Promise.resolve();
		await Promise.resolve();
		starting = false;
		if (startupError) {
			this.reportResourceError('worker', startupError);
			throw startupError;
		}
		if (!worker.isRunning()) {
			const error = new Error('Scheduler persistent worker failed to start');
			this.reportResourceError('worker', error);
			throw error;
		}
	}

	private reportWorkerRunFailure(error: unknown) {
		if (!this.closePromise && this.state === 'ready') this.state = 'prepared';
		this.reportResourceError('worker', error);
	}

	private reportResourceError(source: PersistentSchedulerResource, error: unknown) {
		try {
			this.host?.logger?.error?.({ source, error }, `Scheduler persistent ${source} error`);
		} catch {
			// A logger failure must not turn a handled BullMQ error into an EventEmitter crash.
		}
		try {
			this.host?.emit('error', { source, error });
		} catch {
			// Custom hosts are allowed; keep BullMQ's mandatory error listener non-throwing.
		}
	}

	private wireQueueEvents() {
		this.queueEvents?.on?.('active', event => {
			this.enqueueQueueEvent(() => this.emitQueueEventStarted(event));
		});
		this.queueEvents?.on?.('completed', event => {
			this.enqueueQueueEvent(() => this.emitQueueEventCompleted(event));
		});
		this.queueEvents?.on?.('failed', event => {
			this.enqueueQueueEvent(() => this.emitQueueEventFailed(event));
		});
		this.queueEvents?.on?.('waiting', event => {
			this.enqueueQueueEvent(() => this.markJobWaiting(event));
		});
	}

	private enqueueQueueEvent(run: () => Promise<void> | void) {
		this.queueEventChain = this.queueEventChain
			.then(run, run)
			.catch(error => this.reportQueueEventFailure('lifecycle', error));
	}

	private async emitQueueEventStarted(event: unknown) {
		try {
			const record = eventRecord(event);
			const jobId = jobIdFromRecord(record);
			if (jobId) {
				this.rememberQueueEventActiveJob(jobId);
				const attempt = (this.queueEventAttempts.get(jobId) ?? -1) + 1;
				this.queueEventAttempts.set(jobId, attempt);
				if ((this.localJobAttempts.get(jobId) ?? -1) >= attempt) return;
			}
			const task = await this.taskFromQueueEvent(record);
			if (task) this.startJob(task, record);
		} catch (error) {
			this.reportQueueEventFailure('active', error);
		}
	}

	private async emitQueueEventCompleted(event: unknown) {
		try {
			const record = eventRecord(event);
			const task = await this.taskFromQueueEvent(record);
			if (task) this.completeJob(task, record, record.returnvalue);
			this.forgetQueueEventActiveJob(record);
			this.forgetCaughtUpAttempts(record);
		} catch (error) {
			this.reportQueueEventFailure('completed', error);
		}
	}

	private async emitQueueEventFailed(event: unknown) {
		try {
			const record = eventRecord(event);
			const task = await this.taskFromQueueEvent(record);
			const failure = new Error(String(record.failedReason ?? 'failed'));
			if (task) this.failJob(task, record, failure);
			this.forgetQueueEventActiveJob(record);
			this.forgetCaughtUpAttempts(record);
		} catch (error) {
			this.reportQueueEventFailure('failed', error);
		}
	}

	private markJobWaiting(event: unknown) {
		const record = eventRecord(event);
		const jobId = jobIdFromRecord(record);
		if (!jobId) return;

		const isRetry =
			record.prev === 'active' ||
			record.prev === 'failed' ||
			record.prev === 'completed' ||
			(record.prev === 'delayed' && this.queueEventActiveJobIds.has(jobId));
		const localAttempt = this.localJobAttempts.get(jobId) ?? -1;
		const queueEventAttempt = this.queueEventAttempts.get(jobId) ?? -1;
		if (isRetry && localAttempt <= queueEventAttempt) {
			this.activeJobIds.delete(jobId);
			this.terminalJobStates.delete(jobId);
		}
	}

	private markLocalAttempt(jobId: string, job: BullMQJob) {
		if (!Number.isSafeInteger(job.attemptsMade) || job.attemptsMade! < 0) return;

		const attempt = job.attemptsMade!;
		const previousAttempt = this.localJobAttempts.get(jobId);
		if (previousAttempt !== undefined && attempt <= previousAttempt) return;

		this.localJobAttempts.set(jobId, attempt);
		if ((this.queueEventAttempts.get(jobId) ?? -1) >= attempt) return;
		this.activeJobIds.delete(jobId);
		this.terminalJobStates.delete(jobId);
	}

	private rememberQueueEventActiveJob(jobId: string) {
		this.queueEventActiveJobIds.add(jobId);
	}

	private forgetQueueEventActiveJob(record: Record<string, unknown>) {
		const jobId = jobIdFromRecord(record);
		if (jobId) this.queueEventActiveJobIds.delete(jobId);
	}

	private forgetCaughtUpAttempts(record: Record<string, unknown>) {
		const jobId = jobIdFromRecord(record);
		if (!jobId) return;

		const localAttempt = this.localJobAttempts.get(jobId) ?? -1;
		const queueEventAttempt = this.queueEventAttempts.get(jobId) ?? -1;
		if (queueEventAttempt < localAttempt) return;
		this.localJobAttempts.delete(jobId);
		this.queueEventAttempts.delete(jobId);
	}

	private startJob(task: ScheduledTask, record: Record<string, unknown>, emit = true) {
		const jobId = jobIdFromRecord(record);
		if (jobId && (this.activeJobIds.has(jobId) || this.terminalJobStates.has(jobId))) return false;

		if (jobId) this.activeJobIds.add(jobId);
		task.status = 'running';
		task.runCount += 1;
		task.lastRunAt = new Date();
		task.lastError = undefined;
		if (emit) this.host?.emit('started', { task });
		return true;
	}

	private completeJob(task: ScheduledTask, record: Record<string, unknown>, result: unknown) {
		if (!this.finishJob(task, record, 'completed')) return;
		task.status = 'completed';
		task.lastError = undefined;
		this.host?.emit('completed', { task, result });
	}

	private failJob(task: ScheduledTask, record: Record<string, unknown>, error: Error) {
		if (!this.finishJob(task, record, 'failed')) return;
		task.status = 'failed';
		task.lastError = error;
		this.host?.emit('failed', { task, error });
	}

	private finishJob(task: ScheduledTask, record: Record<string, unknown>, state: 'completed' | 'failed') {
		const jobId = jobIdFromRecord(record);
		if (jobId) {
			if (this.terminalJobStates.has(jobId)) return false;
			if (!this.activeJobIds.has(jobId)) this.startJob(task, record, false);
			this.activeJobIds.delete(jobId);
			this.rememberTerminalJobState(jobId, state);
			return true;
		}

		if (task.status !== 'running') this.startJob(task, record, false);
		return true;
	}

	private rememberTerminalJobState(jobId: string, state: 'completed' | 'failed') {
		this.terminalJobStates.delete(jobId);
		this.terminalJobStates.set(jobId, state);
		if (this.terminalJobStates.size <= MAX_TRACKED_JOB_STATES) return;

		const oldestJobId = this.terminalJobStates.keys().next().value;
		if (oldestJobId) {
			this.terminalJobStates.delete(oldestJobId);
			this.localJobAttempts.delete(oldestJobId);
			this.queueEventActiveJobIds.delete(oldestJobId);
			this.queueEventAttempts.delete(oldestJobId);
		}
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
		if (this.state === 'closing' || this.state === 'closed') {
			throw new Error('Scheduler persistent driver has been stopped.');
		}
		if (this.queue) return this.queue;
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

function createActivationGate() {
	let resolve: (active: boolean) => void = () => undefined;
	const promise = new Promise<boolean>(resolvePromise => {
		resolve = resolvePromise;
	});
	return {
		promise,
		activate: () => resolve(true),
		cancel: () => resolve(false),
	};
}

function jobIdFromRecord(record: Record<string, unknown>) {
	if (typeof record.jobId === 'string') return record.jobId;
	if (typeof record.id === 'string') return record.id;
	return undefined;
}
