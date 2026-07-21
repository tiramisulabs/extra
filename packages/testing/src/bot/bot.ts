import { CacheFrom, Client, type LangInstance } from 'seyfert';
import { HandleCommand } from 'seyfert/lib/commands/handle';
import {
	createCommandPathCatalog,
	installRunErrorCaptureDefaults,
	runMockClientStartup,
	shouldDeferCommandLoading,
	splitCommandClasses,
} from './bootstrap';
import type { ClientConstructorOptions, ClientOptions } from './bot-support';
import { TEST_APPLICATION_ID, TEST_BOT_ID } from './constants';
import { type MockBotOptions, type MockSubCommandClass } from './contracts';
import { registerWorldDefaults } from './defaults';
import { dispatchStore } from './dispatch-context';
import { MockGateway } from './gateway';
import { MockBot as MockBotCore } from './mock-bot';
import { type ApiRole } from './payloads';
import { MockApiHandler } from './rest';
import { asClientGateway, asUsingClient, cacheStore, clientLifecycle, eventsInternals } from './seyfert-internals';
import { WorldState, type WorldStateReader } from './state';
import { seedCachedRole, seedWorld } from './world';

export * from './contracts';
export { Dispatch, type DispatchOptions } from './dispatch';
export { WORLD_EVENT_NAMES } from './world-events';

/** Public facade kept in this module so the declaration entrypoint remains stable across internal collaborators. */
export class MockBot extends MockBotCore {
	override get world(): WorldStateReader {
		return super.world;
	}
}

export async function createMockBot(options: MockBotOptions = {}): Promise<MockBot> {
	const rest = new MockApiHandler({ onUnhandledRest: options.onUnhandledRest });
	const built = options.world?.build();
	const world = built ? structuredClone(built) : undefined;
	const botId = options.botId ?? TEST_BOT_ID;
	const prefixList = [...(options.prefixes ?? []), ...(options.mentionAsPrefix ? [`<@${botId}>`, `<@!${botId}>`] : [])];
	const clientOptionsBase: ClientOptions | undefined = options.clientOptions
		? { ...(options.clientOptions as ClientOptions) }
		: undefined;
	if (clientOptionsBase) delete clientOptionsBase.plugins;
	if (options.client && options.plugins?.length) {
		console.warn(
			'[@slipher/testing] createMockBot({ client, plugins }) ignores the passed plugins because Seyfert ' +
				'resolves plugins in the Client constructor. Construct the Client with plugins instead: ' +
				'new Client({ plugins }).',
		);
	}
	const clientOptions: ClientConstructorOptions =
		prefixList.length || options.globalMiddlewares || options.plugins
			? {
					...clientOptionsBase,
					...(options.plugins ? { plugins: options.plugins } : {}),
					...(options.globalMiddlewares ? { globalMiddlewares: options.globalMiddlewares } : {}),
					...(prefixList.length
						? {
								commands: {
									...clientOptionsBase?.commands,
									prefix: async () => prefixList,
								},
							}
						: {}),
				}
			: clientOptionsBase;
	const client = options.client ?? new Client(clientOptions);
	installRunErrorCaptureDefaults(client, options);
	// Events use a different seam (reportEventFailure, not an options hook). Wrap it to capture a thrown event
	// handler error into the active dispatch context so emit fails loud too, instead of seyfert swallowing it.
	const eventsHandler = eventsInternals(client);
	if (typeof eventsHandler.reportEventFailure === 'function') {
		eventsHandler.reportEventFailure = (_name: string, error: unknown) => {
			const ctx = dispatchStore.getStore();
			if (ctx && ctx.error === undefined) ctx.error = error;
			return undefined;
		};
	}
	const gateway = new MockGateway(options.shards ?? 1, options.shardLatency ?? 0);
	// Client#setServices wraps the custom gateway's existing send hook; seed it from clientOptions first.
	if (options.clientOptions?.handleSendPayload)
		gateway.options.handleSendPayload = options.clientOptions.handleSendPayload;

	client.setServices({
		rest,
		// ShardManager is a concrete class in Seyfert; MockGateway mirrors the runtime surface bots test against.
		gateway: asClientGateway(gateway),
		handleCommand: HandleCommand,
		...(options.middlewares ? { middlewares: options.middlewares } : {}),
	});
	if (options.langs) {
		const localeNames = Object.keys(options.langs);
		client.langs.set(
			Object.entries(options.langs).map(
				([name, file]): LangInstance => ({
					name,
					file: { default: file } as LangInstance['file'],
					path: `${name}.ts`,
				}),
			),
		);
		client.langs.defaultLang = options.defaultLang ?? (localeNames.includes('en-US') ? 'en-US' : localeNames[0]);
		clientLifecycle(client).langBaseValues = structuredClone(client.langs.values);
	}
	if (options.defaultLang) {
		client.langs.defaultLang = options.defaultLang;
	}
	client.botId = options.botId ?? ((options.client && client.botId) || botId);
	client.applicationId = options.applicationId ?? ((options.client && client.applicationId) || TEST_APPLICATION_ID);

	let requestedSubcommands: MockSubCommandClass[] = [];
	if (options.commands) {
		const commands = Array.isArray(options.commands) ? options.commands : [options.commands];
		const split = splitCommandClasses(commands);
		requestedSubcommands = split.subcommands;
		// Seyfert's command handler accepts constructor arrays at runtime, but its type expects loaded command metadata.
		if (split.topLevel.length)
			client.commands.set(split.topLevel as unknown as Parameters<Client['commands']['set']>[0]);
	}
	if (options.components) client.components.set(options.components);
	if (options.events) {
		const events = options.events.map(event => ({ ...event, data: { once: false, ...event.data } }));
		// Tests pass public event definitions; Seyfert fills the internal loader-only fields when executing.
		client.events.set(events as Parameters<Client['events']['set']>[0]);
	}
	const commandCatalog = await createCommandPathCatalog(client, options);
	// Drive the production startup plugin lifecycle without opening a gateway connection or requiring a token/config.
	await runMockClientStartup(client, options, commandCatalog);
	// seedWorld only needs the UsingClient cache/rest surface already installed above.
	if (world) await seedWorld(asUsingClient(client), world);
	const state = new WorldState(world, { botId: client.botId });
	registerWorldDefaults(rest, world, {
		emit: (name, payload) => client.events.runEvent(name, client, payload, -1, true) as Promise<void>,
		removeCachedMember: async (guildId, userId) => {
			await client.cache.members?.remove(userId, guildId);
		},
		setCachedMember: async (guildId, userId, member) => {
			await client.cache.members?.set(CacheFrom.Test, userId, guildId, member);
		},
		cacheSet: async (resource, id, guildId, data) => {
			if (
				resource === 'roles' &&
				data &&
				typeof data === 'object' &&
				typeof (data as { id?: unknown }).id === 'string'
			) {
				await seedCachedRole(asUsingClient(client), guildId, data as ApiRole);
				return;
			}
			await cacheStore(client, resource)?.set?.(CacheFrom.Test, id, guildId, data);
		},
		cacheRemove: async (resource, id, guildId) => {
			await cacheStore(client, resource)?.remove?.(id, guildId);
		},
		simulateGateway: options.simulateGateway ?? true,
		state,
		botId: client.botId,
		applicationId: client.applicationId,
	});
	rest.markDefaultsBaseline();

	const bot = new MockBot(
		client,
		rest,
		gateway,
		world,
		state,
		options.validateOptions ?? true,
		options.timers,
		options.onCommandError ?? 'throw',
		shouldDeferCommandLoading(options) ? { commandsDir: options.commandsDir } : undefined,
		commandCatalog,
	);
	bot.installDispatchHooks();
	bot.validateSubcommandClasses(requestedSubcommands);
	return bot;
}
