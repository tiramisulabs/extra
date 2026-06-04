import type { Client, CommandContext, HttpClient, UsingClient, WorkerClient } from 'seyfert';
import type { CooldownManager } from '../src';

declare function expectType<T>(value: T): void;
declare const context: CommandContext;
declare const client: Client;
declare const httpClient: HttpClient;
declare const workerClient: WorkerClient;
declare const usingClient: UsingClient;

expectType<CooldownManager | undefined>(context.cooldown);
expectType<CooldownManager | undefined>(client.cooldown);
expectType<CooldownManager | undefined>(httpClient.cooldown);
expectType<CooldownManager | undefined>(workerClient.cooldown);
expectType<CooldownManager | undefined>(usingClient.cooldown);
