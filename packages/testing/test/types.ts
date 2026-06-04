import type { LoggerLike, QueueLike, SchedulerLike } from '@slipher/types';
import { mockLogger, mockQueues, mockScheduler } from '../src';

declare function expectType<T>(value: T): void;

const logger = mockLogger();
expectType<LoggerLike>(logger);

const queues = mockQueues();
expectType<QueueLike>(queues.get('welcome'));

const scheduler = mockScheduler();
expectType<SchedulerLike>(scheduler);
