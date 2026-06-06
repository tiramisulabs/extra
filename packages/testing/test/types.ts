import type { LoggerLike, QueueLike, SchedulerLike } from '@slipher/types';
import { mockCommandContext, mockLogger, mockQueues, mockScheduler } from '../src';

declare function expectType<T>(value: T): void;

const logger = mockLogger();
expectType<LoggerLike>(logger);

const queues = mockQueues();
expectType<QueueLike>(queues.get('welcome'));

const scheduler = mockScheduler();
expectType<SchedulerLike>(scheduler);

const typedContext = mockCommandContext<{ reason: string; count: number }>({
	options: { reason: 'spam', count: 2 },
});
expectType<string>(typedContext.options.reason);
expectType<number>(typedContext.options.count);
