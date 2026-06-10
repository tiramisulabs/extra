import type {
	Client,
	Command,
	CommandContext,
	ContextMenuCommand,
	EntryPointCommand,
	HttpClient,
	PluginMiddlewaresMapOf,
	PluginUsingClient,
	Register,
	RegisteredMiddlewares,
	RegisterPlugins,
	ResolvedRegisteredMiddlewares,
	SubCommand,
	UsingClient,
	WorkerClient,
} from 'seyfert';
import { definePlugins, Middlewares } from 'seyfert';
import * as cooldownExports from '../src';
import {
	Cooldown,
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
declare const manager: CooldownManager;
const pluginWithoutMiddleware = cooldown();
const pluginWithDisabledMiddleware = cooldown({ middleware: false });
const pluginWithConfiguredMiddleware = cooldown({ middleware: { global: true } });
const cooldownPlugin = cooldown({ middleware: true });
const plugins = definePlugins(cooldownPlugin);
const pluginsWithoutMiddleware = definePlugins(pluginWithoutMiddleware);
const pluginsWithDisabledMiddleware = definePlugins(pluginWithDisabledMiddleware);
const pluginsWithConfiguredMiddleware = definePlugins(pluginWithConfiguredMiddleware);

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
expectType<CooldownMiddlewares>({} as PluginMiddlewaresMapOf<typeof plugins>);
expectType<never>({} as keyof PluginMiddlewaresMapOf<typeof pluginsWithoutMiddleware>);
expectType<never>({} as keyof PluginMiddlewaresMapOf<typeof pluginsWithDisabledMiddleware>);
expectType<never>({} as keyof PluginMiddlewaresMapOf<typeof pluginsWithConfiguredMiddleware>);
expectType<CooldownMiddleware>({} as ResolvedRegisteredMiddlewares['cooldown']);
expectType<CooldownMiddleware>({} as RegisteredMiddlewares['commandCooldown']);
expectType<ReturnType<typeof Middlewares>>(Middlewares(['cooldown']));
expectType<ReturnType<typeof Middlewares>>(Middlewares(['commandCooldown']));
// @ts-expect-error the default middleware is provided by the registered plugin, not a global augmentation
expectType<CooldownMiddleware>({} as RegisteredMiddlewares['cooldown']);

manager.consume();
manager.consume({ cost: 2 });
manager.consume({ name: 'ping', target: 'u1', guildId: 'g1', cost: 2 });
manager.check();
manager.check({ cost: 2 });
manager.check({ name: 'ping', target: 'u1', guildId: 'g1', cost: 2 });
manager.reset();
manager.reset({ name: 'ping', target: 'u1', guildId: 'g1' });

expectType<ClassDecorator>(Cooldown.user(5_000));
expectType<ClassDecorator>(Cooldown.guild(5_000, { uses: 3, group: 'moderation' }));
expectType<ClassDecorator>(Cooldown.custom(() => 'target', 5_000, { group: 'custom' }));

const props: CooldownProps = { type: 'user', interval: 5_000, uses: 3, group: 'mod' };
expectType<CooldownProps>(props);

// @ts-expect-error low-level set is intentionally not public
manager.set({ key: 'ping:user:u1', interval: 1_000, remaining: 1 });
// @ts-expect-error context() was replaced by zero-arg verbs
manager.context();
// @ts-expect-error ALS plumbing is private
cooldownExports.runWithCooldownContext;
// @ts-expect-error ALS plumbing is private
cooldownExports.useCooldownContext;
// @ts-expect-error resource internals are not exported from the root package
cooldownExports.CooldownType;
