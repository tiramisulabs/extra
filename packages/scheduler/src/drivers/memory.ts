import { requireOptionalModule } from '../optional';
import { runTask, ScheduledTask } from '../task';
import type {
	Awaitable,
	CronerFactory,
	CronerJob,
	MemorySchedulerOptions,
	ScheduledTaskDefinition,
	SchedulerDriver,
	SchedulerHost,
} from '../types';

export function memory(options: MemorySchedulerOptions = {}) {
	return new MemorySchedulerDriver(options);
}

class MemorySchedulerDriver implements SchedulerDriver {
	private readonly croner: CronerFactory;
	private readonly tasks = new Map<string, ScheduledTask>();
	private readonly jobs = new Map<string, CronerJob>();
	private readonly immediateTaskIds = new Set<string>();
	private host?: SchedulerHost;
	private ready = false;

	constructor(options: MemorySchedulerOptions) {
		this.croner = options.croner ?? defaultCronerFactory;
		this.host = options.logger ? { emit: () => undefined, logger: options.logger } : undefined;
	}

	attach(host: SchedulerHost) {
		this.host = host;
	}

	setup() {
		this.ready = true;
		for (const id of [...this.immediateTaskIds]) {
			const task = this.tasks.get(id);
			const job = this.jobs.get(id);
			this.immediateTaskIds.delete(id);
			if (task && job) this.runImmediately(task, job);
		}
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
		this.tasks.set(task.id, task);
		this.jobs.set(task.id, job);

		if (task.runImmediately) {
			if (this.ready) this.runImmediately(task, job);
			else this.immediateTaskIds.add(task.id);
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
		this.tasks.delete(id);
		this.immediateTaskIds.delete(id);
	}

	async close() {
		for (const job of this.jobs.values()) {
			job.stop?.();
		}

		this.jobs.clear();
		this.tasks.clear();
		this.immediateTaskIds.clear();
		this.ready = false;
	}

	private runImmediately(task: ScheduledTask, job: CronerJob) {
		void Promise.resolve()
			.then(() => this.run(task, job))
			.catch(error => {
				this.host?.logger?.error?.({ taskId: task.id, error }, 'Scheduler memory driver failed to run immediate task');
			});
	}

	private async run(task: ScheduledTask, job?: CronerJob) {
		return runTask(task, this.host, () => job?.nextRun?.() ?? undefined);
	}
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
