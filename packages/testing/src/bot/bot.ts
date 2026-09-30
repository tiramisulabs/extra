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
import type { Dispatch } from './dispatch';
import { dispatchStore } from './dispatch-context';
import { MockGateway } from './gateway';
import { isEphemeral } from './message-flags';
import { messageAccess } from './message-visibility';
import { MockBot as MockBotCore } from './mock-bot';
import type {
	CommandSchema,
	MockBotEvent,
	PendingCollector,
	PendingInteractionChange,
	PendingModal,
	VisibleConversation,
	VisibleMessage,
} from './observation';
import { memberUpdateEvent } from './payload-events';
import { type ApiRole } from './payloads';
import { MockApiHandler } from './rest';
import {
	asClientGateway,
	asUsingClient,
	cacheStore,
	clientLifecycle,
	eventsInternals,
	mockClientUser,
} from './seyfert-internals';
import { type WorldSnapshot, WorldState, type WorldStateReader } from './state';
import { cloneWorld, defaultBotUser, seedCachedRole, seedWorld } from './world';

export * from './contracts';
export { Dispatch, type DispatchOptions } from './dispatch';
export { WORLD_EVENT_NAMES } from './world-events';

/** Public facade kept in this module so the declaration entrypoint remains stable across internal collaborators. */
export class MockBot extends MockBotCore {
	private readonly observers = new Set<(event: MockBotEvent) => void>();
	private readonly restSnapshots = new Map<number, WorldSnapshot>();
	private readonly startupSequence = this._world?.messageSequence ?? 0;

	override get world(): WorldStateReader {
		return super.world;
	}

	private publish(event: MockBotEvent): void {
		for (const observer of [...this.observers]) {
			try {
				observer(event);
			} catch (error) {
				console.warn('[@slipher/testing] observer failed:', error);
			}
		}
	}

	private publishDiff(before: WorldSnapshot): void {
		const diff = this._state.diff(before);
		if (Object.values(diff).some(bucket => bucket.added.length || bucket.removed.length || bucket.changed.length)) {
			this.publish({ type: 'world', diff });
		}
	}

	/** @internal Connect the existing REST notification seam after world defaults have been installed. */
	startObservingRest(): void {
		this.rest.observeActions((action, phase) => {
			if (phase === 'pending') {
				if (this.observers.size) this.restSnapshots.set(action.seq, this._state.snapshot());
				this.publish({ type: 'rest', phase: 'request', action: { ...action } });
				return;
			}
			this.publish({ type: 'rest', phase: 'settled', action: { ...action } });
			const before = this.restSnapshots.get(action.seq);
			this.restSnapshots.delete(action.seq);
			if (before) this.publishDiff(before);
		});
	}

	observe(observer: (event: MockBotEvent) => void): () => void {
		this.observers.add(observer);
		return () => {
			this.observers.delete(observer);
		};
	}

	protected override track<T>(dispatch: Dispatch<T>): Dispatch<T> {
		dispatch.observe((phase, error) => {
			if (dispatch.dispatchId === undefined) return;
			const sessionKey = this.sessions.keyForDispatch(dispatch.dispatchId);
			this.publish({
				type: 'dispatch',
				phase,
				dispatchId: dispatch.dispatchId,
				kind: dispatch.kind,
				...(error === undefined ? {} : { error }),
				...(sessionKey === undefined ? {} : { sessionKey }),
			});
		});
		return super.track(dispatch);
	}

	protected override applyWorldEvent(name: string, payload: Record<string, unknown>): void {
		const before = this.observers.size ? this._state.snapshot() : undefined;
		super.applyWorldEvent(name, payload);
		if (before) this.publishDiff(before);
	}

	protected override onInteractionChange(change: PendingInteractionChange): void {
		this.publish({ type: 'interaction', change });
	}

	inspectChannel(channelId: string): { messages: (VisibleMessage & { deleted?: boolean })[]; diagnostics: string[] } {
		const channel = this._world?.channels.find(entry => entry.id === channelId);
		if (!channel) return { messages: [], diagnostics: ['unknown-channel'] };
		const timeline = this._state.channelTimeline(channelId);
		const diagnostics = ['developer-inspection'];
		if (
			timeline.some(entry =>
				messageAccess(this._world, this._state, channelId, undefined, entry).diagnostics.includes(
					'ephemeral-owner-unknown',
				),
			)
		) {
			diagnostics.push('ephemeral-owner-unknown');
		}
		return {
			messages: timeline.map(entry => ({
				id: entry.message.id,
				channelId,
				payload: structuredClone(entry.message) as unknown as VisibleMessage['payload'],
				visibility: isEphemeral(entry.message) ? 'ephemeral' : 'public',
				sequence: entry.sequence,
				liveRecipientIds: [...(entry.liveRecipientIds ?? [])],
				isHistory: (entry.sequence ?? 0) <= this.startupSequence,
				...(entry.ownerId === undefined ? {} : { ownerId: entry.ownerId }),
				...(entry.interactionId === undefined ? {} : { interactionId: entry.interactionId }),
				...(entry.message.edited_timestamp === null ? {} : { editedAt: entry.message.edited_timestamp }),
				...(entry.deleted ? { deleted: true } : {}),
			})),
			diagnostics,
		};
	}

	conversation(query: { userId: string; channelId: string }): VisibleConversation {
		const channelAccess = messageAccess(this._world, this._state, query.channelId, query.userId);
		if (!channelAccess.visible) {
			return { channelId: query.channelId, messages: [], diagnostics: channelAccess.diagnostics };
		}
		const diagnostics = [...channelAccess.diagnostics];
		const visibleIds = new Set<string>();
		let hiddenUnknownOwnerCount = 0;
		let hiddenHistoryCount = 0;
		for (const entry of this._state.channelTimeline(query.channelId)) {
			if (entry.deleted) continue;
			const access = messageAccess(this._world, this._state, query.channelId, query.userId, entry);
			if (access.visible) visibleIds.add(entry.message.id);
			if (access.diagnostics.includes('ephemeral-owner-unknown')) hiddenUnknownOwnerCount++;
			if (access.diagnostics.includes('history-hidden')) hiddenHistoryCount++;
		}
		if (hiddenUnknownOwnerCount) diagnostics.push(`ephemeral-owner-unknown:${hiddenUnknownOwnerCount}-hidden`);
		if (hiddenHistoryCount) diagnostics.push(`history-hidden:${hiddenHistoryCount}`);
		return {
			channelId: query.channelId,
			messages: this.inspectChannel(query.channelId)
				.messages.filter(message => !message.deleted && visibleIds.has(message.id))
				.map(
					({ deleted: _deleted, isHistory: _isHistory, liveRecipientIds: _liveRecipientIds, ...message }) => message,
				),
			diagnostics,
		};
	}

	pendingInteractions(): { modals: PendingModal[]; collectors: PendingCollector[] } {
		return {
			modals: [...this.displayedModals.values()].flatMap(value =>
				value.pending ? [structuredClone(value.pending)] : [],
			),
			collectors: [...this.pendingCollectors].map(value => structuredClone(value)),
		};
	}

	/** Loads any deferred directory commands before returning their full Seyfert JSON schemas. */
	async commandSchemas(): Promise<CommandSchema[]> {
		await this.ensureAllCommandsLoaded();
		const commands = [...this.client.commands.values];
		const entryPoint = (
			this.client.commands as typeof this.client.commands & { entryPoint?: (typeof commands)[number] | null }
		).entryPoint;
		if (entryPoint) commands.push(entryPoint);
		return commands.map(command => command.toJSON() as CommandSchema);
	}

	readonly admin = {
		addMemberRole: async (input: { guildId: string; userId: string; roleId: string }): Promise<void> =>
			this.changeMemberRole(input, true),
		removeMemberRole: async (input: { guildId: string; userId: string; roleId: string }): Promise<void> =>
			this.changeMemberRole(input, false),
	};

	private async changeMemberRole(
		input: { guildId: string; userId: string; roleId: string },
		add: boolean,
	): Promise<void> {
		const guild = this._world?.guilds.find(entry => entry.id === input.guildId);
		if (!guild) throw new TypeError(`admin: guild "${input.guildId}" is not in the world.`);
		const member = this._world?.members.find(
			entry => entry.guildId === input.guildId && entry.member.user.id === input.userId,
		);
		if (!member) throw new TypeError(`admin: member "${input.userId}" is not in guild "${input.guildId}".`);
		if (!this._world?.roles.some(entry => entry.guildId === input.guildId && entry.role.id === input.roleId)) {
			throw new TypeError(`admin: role "${input.roleId}" is not in guild "${input.guildId}".`);
		}
		const roles = add
			? [...new Set([...member.member.roles, input.roleId])]
			: member.member.roles.filter(roleId => roleId !== input.roleId);
		await this.emit('GUILD_MEMBER_UPDATE', memberUpdateEvent(member.member, { guildId: guild.id, roles }), {
			allowNoHandler: true,
		});
	}
}

export async function createMockBot(options: MockBotOptions = {}): Promise<MockBot> {
	const rest = new MockApiHandler({ onUnhandledRest: options.onUnhandledRest });
	// Reconcile before the clone: adoptBotId rewrites the seeded bot member on the live world, so the
	// ApiMember registerBotMember already returned points at the same id the client will run as.
	const profileId = options.botUser?.id;
	if (profileId !== undefined && options.botId !== undefined && profileId !== options.botId)
		throw new TypeError(`createMockBot: botUser id "${profileId}" conflicts with botId "${options.botId}".`);
	if (options.world && options.botUser) options.world.botUser(options.botUser);
	const statedBotId = options.world
		? options.world.adoptBotId(options.botId ?? profileId)
		: (options.botId ?? profileId);
	const botId = statedBotId ?? TEST_BOT_ID;
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
	client.botId = statedBotId ?? ((options.client && client.botId) || botId);
	client.applicationId = options.applicationId ?? ((options.client && client.applicationId) || TEST_APPLICATION_ID);
	options.world?.adoptBotId(client.botId);
	const botUser = options.world?.botUser() ?? defaultBotUser({ ...options.botUser, id: client.botId });
	const built = options.world?.build();
	const world = built ? cloneWorld(built, 'createMockBot') : undefined;
	client.me = mockClientUser(client, botUser, client.applicationId);

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
	else await client.cache.users?.set(CacheFrom.Test, botUser.id, botUser);
	const state = new WorldState(world, { botId: client.botId, botUser });
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
	bot.startObservingRest();
	bot.validateSubcommandClasses(requestedSubcommands);
	return bot;
}
