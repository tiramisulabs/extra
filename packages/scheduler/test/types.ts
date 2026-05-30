import type { Client, CommandContext, HttpClient, UsingClient, WorkerClient } from 'seyfert';
import type { SchedulerRegistry } from '../src';

declare function expectType<T>(value: T): void;
declare const context: CommandContext;
declare const client: Client;
declare const httpClient: HttpClient;
declare const workerClient: WorkerClient;
declare const usingClient: UsingClient;

expectType<SchedulerRegistry>(context.scheduler);
expectType<SchedulerRegistry>(client.scheduler);
expectType<SchedulerRegistry>(httpClient.scheduler);
expectType<SchedulerRegistry>(workerClient.scheduler);
expectType<SchedulerRegistry>(usingClient.scheduler);
