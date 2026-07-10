import {
	type Client,
	type CommandContext,
	definePlugins,
	type HttpClient,
	type PluginUsingClient,
	type SeyfertRegistry,
	type UsingClient,
	type WorkerClient,
} from 'seyfert';
import { createScheduler, memory, persistent, type SchedulerRegistry, scheduler } from '../src';

declare function expectType<T>(value: T): void;
declare const context: CommandContext;
declare const client: Client;
declare const httpClient: HttpClient;
declare const workerClient: WorkerClient;
declare const usingClient: UsingClient;
declare const pluginClient: PluginUsingClient<typeof plugins>;
const schedulerPlugin = scheduler({ driver: memory() });
const plugins = definePlugins(schedulerPlugin);

declare module 'seyfert' {
	interface SeyfertRegistry {
		plugins: typeof plugins;
		client: Client;
	}
}

expectType<SeyfertRegistry>({ plugins, client });
expectType<SchedulerRegistry>(context.scheduler);
expectType<SchedulerRegistry | undefined>(client.scheduler);
expectType<SchedulerRegistry | undefined>(httpClient.scheduler);
expectType<SchedulerRegistry | undefined>(workerClient.scheduler);
expectType<SchedulerRegistry | undefined>(usingClient.scheduler);
expectType<SchedulerRegistry>(pluginClient.scheduler);

createScheduler({ driver: memory() });
scheduler({ driver: memory() });
expectType<Promise<void>>(createScheduler({ driver: memory() }).resume('task'));
expectType<Promise<void>>(createScheduler({ driver: memory() }).removeOrphan('task'));
expectType<Promise<void>>(createScheduler({ driver: memory() }).prepare());
expectType<Promise<void>>(createScheduler({ driver: memory() }).activate());

// @ts-expect-error scheduler driver is required
createScheduler({});

// @ts-expect-error scheduler plugin driver is required
scheduler({});

// @ts-expect-error orphan purging belongs to persistent driver options
createScheduler({ driver: memory(), purgeOrphansOnStartup: true });

createScheduler({ driver: persistent({ purgeOrphansOnStartup: true }) });
