import type { DurationInput } from '@slipher/internal';
import { addTaskMetadata } from './metadata';
import type { SchedulerDecoratorOptions } from './types';

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
