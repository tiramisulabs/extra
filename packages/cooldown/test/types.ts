import type { Client, CommandContext, HttpClient, UsingClient, WorkerClient } from 'seyfert';
import type { CooldownManager } from '../src';

declare function expectType<T>(value: T): void;
declare const context: CommandContext;
declare const client: Client;
declare const httpClient: HttpClient;
declare const workerClient: WorkerClient;
declare const usingClient: UsingClient;

expectType<CooldownManager>(context.cooldown);
expectType<CooldownManager>(client.cooldown);
expectType<CooldownManager>(httpClient.cooldown);
expectType<CooldownManager>(workerClient.cooldown);
expectType<CooldownManager>(usingClient.cooldown);
