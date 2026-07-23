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
import {
	type Awaitable,
	type CronerFactory,
	createScheduler,
	memory,
	persistent,
	type SchedulerRegistry,
	scheduler,
} from '../src';

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

const customCroner: CronerFactory = (expression, options, runner) => {
	expectType<string>(expression);
	expectType<string>(options.name);
	expectType<true>(options.catch);
	expectType<true>(options.paused);
	expectType<number | undefined>(options.interval);
	expectType<string | undefined>(options.timezone);
	expectType<(() => void) | undefined>(options.protect);
	expectType<Awaitable<unknown>>(runner());

	// @ts-expect-error Slipher does not pass arbitrary Croner options
	void options.unref;
	return {};
};

createScheduler({ driver: memory({ croner: customCroner }) }).cron('daily', '0 0 * * *', () => undefined, {
	overlap: 'skip',
	timezone: 'Etc/UTC',
});

createScheduler({ driver: memory() }).interval('heartbeat', '1m', () => undefined, {
	overlap: 'allow',
});

// @ts-expect-error timezone only applies to cron tasks
createScheduler({ driver: memory() }).interval('heartbeat', '1m', () => undefined, { timezone: 'Etc/UTC' });

// @ts-expect-error overlap is a closed policy
createScheduler({ driver: memory() }).cron('daily', '0 0 * * *', () => undefined, { overlap: 'queue' });
