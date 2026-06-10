import type {
	Client,
	Command,
	CommandContext,
	ContextMenuCommand,
	EntryPointCommand,
	HttpClient,
	PluginUsingClient,
	Register,
	RegisteredMiddlewares,
	RegisterPlugins,
	SubCommand,
	UsingClient,
	WorkerClient,
} from 'seyfert';
import { definePlugins, Middlewares } from 'seyfert';
import {
	type CooldownManager,
	type CooldownMiddleware,
	type CooldownMiddlewares,
	type CooldownProps,
	cooldown,
} from '../src';

declare function expectType<T>(value: T): void;
declare const context: CommandContext;
declare const client: Client;
declare const httpClient: HttpClient;
declare const workerClient: WorkerClient;
declare const usingClient: UsingClient;
declare const pluginClient: PluginUsingClient<typeof plugins>;
declare const command: Command;
declare const subCommand: SubCommand;
declare const contextMenuCommand: ContextMenuCommand;
declare const entryPointCommand: EntryPointCommand;
const cooldownPlugin = cooldown();
const plugins = definePlugins(cooldownPlugin);

declare module 'seyfert' {
	interface Register extends RegisterPlugins<typeof plugins> {}
	interface RegisteredMiddlewares extends CooldownMiddlewares<'commandCooldown'> {}
}

expectType<Register>({ plugins });
expectType<CooldownManager>(context.cooldown);
expectType<CooldownManager | undefined>(client.cooldown);
expectType<CooldownManager | undefined>(httpClient.cooldown);
expectType<CooldownManager | undefined>(workerClient.cooldown);
expectType<CooldownManager | undefined>(usingClient.cooldown);
expectType<CooldownManager>(pluginClient.cooldown);
expectType<CooldownProps | undefined>(command.cooldown);
expectType<CooldownProps | undefined>(subCommand.cooldown);
expectType<CooldownProps | undefined>(contextMenuCommand.cooldown);
expectType<CooldownProps | undefined>(entryPointCommand.cooldown);
expectType<CooldownMiddleware>({} as RegisteredMiddlewares['cooldown']);
expectType<CooldownMiddleware>({} as RegisteredMiddlewares['commandCooldown']);
expectType<ReturnType<typeof Middlewares>>(Middlewares(['cooldown']));
expectType<ReturnType<typeof Middlewares>>(Middlewares(['commandCooldown']));
