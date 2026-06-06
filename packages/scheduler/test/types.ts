import type { SchedulerLike } from '@slipher/types';
import type { Client, CommandContext, HttpClient, UsingClient, WorkerClient } from 'seyfert';
import { createScheduler, memory, persistent, type ScheduledTask, type SchedulerRegistry, scheduler } from '../src';

declare function expectType<T>(value: T): void;
declare const context: CommandContext;
declare const client: Client;
declare const httpClient: HttpClient;
declare const workerClient: WorkerClient;
declare const usingClient: UsingClient;

expectType<SchedulerRegistry>(context.scheduler);
expectType<SchedulerRegistry | undefined>(client.scheduler);
expectType<SchedulerRegistry | undefined>(httpClient.scheduler);
expectType<SchedulerRegistry | undefined>(workerClient.scheduler);
expectType<SchedulerRegistry | undefined>(usingClient.scheduler);

createScheduler({ driver: memory() });
scheduler({ driver: memory() });
expectType<SchedulerLike<ScheduledTask>>(createScheduler({ driver: memory() }));
expectType<Promise<void>>(createScheduler({ driver: memory() }).resume('task'));

// @ts-expect-error scheduler driver is required
createScheduler({});

// @ts-expect-error scheduler plugin driver is required
scheduler({});

// @ts-expect-error orphan purging belongs to persistent driver options
createScheduler({ driver: memory(), purgeOrphansOnStartup: true });

createScheduler({ driver: persistent({ purgeOrphansOnStartup: true }) });
