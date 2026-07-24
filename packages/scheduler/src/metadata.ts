import type {
	CronSchedulerDecoratorOptions,
	DurationInput,
	SchedulerDecoratorOptions,
	SchedulerTaskConstructor,
	SchedulerTaskSource,
} from './types';

type TaskMetadata =
	| {
			kind: 'cron';
			schedule: string;
			propertyKey: string | symbol;
			options?: CronSchedulerDecoratorOptions;
	  }
	| {
			kind: 'interval';
			schedule: DurationInput;
			propertyKey: string | symbol;
			options?: SchedulerDecoratorOptions;
	  };

const taskMetadata = new WeakMap<Function, TaskMetadata[]>();

export function addTaskMetadata(target: object, metadata: TaskMetadata) {
	const constructor = typeof target === 'function' ? target : target.constructor;
	const definitions = taskMetadata.get(constructor) ?? [];

	definitions.push(metadata);
	taskMetadata.set(constructor, definitions);
}

export function getTaskMetadata(instance: object) {
	return taskMetadata.get(instance.constructor) ?? [];
}

export function instantiateTaskSource(source: SchedulerTaskSource) {
	if (typeof source === 'function') {
		const Task = source as SchedulerTaskConstructor;

		return new Task();
	}

	return source;
}
