import {
	Client,
	type Command,
	type ContextMenuCommand,
	type EntryPointCommand,
	ModalCommand,
	type UsingClient,
} from 'seyfert';
import { CacheFrom } from 'seyfert/lib/cache';
import { HandleCommand } from 'seyfert/lib/commands/handle';
import type { ClientEvent } from 'seyfert/lib/events/event';
import type { LangInstance } from 'seyfert/lib/langs/handler';
import {
	type APIInteraction,
	type APIInteractionResponse,
	ApplicationCommandType,
	type GatewayDispatchPayload,
	InteractionResponseType,
	InteractionType,
} from 'seyfert/lib/types';
import { resetMockIds } from '../id';
import { TEST_APPLICATION_ID, TEST_BOT_ID, TEST_CHANNEL_ID, TEST_GUILD_ID, TEST_USER_ID } from './constants';
import { registerWorldDefaults } from './defaults';
import { Dispatch } from './dispatch';
import { type DispatchContext, dispatchStore, nextDispatchId, resetDispatchIds } from './dispatch-context';
import { MockGateway } from './gateway';
import {
	type ApiInteractionPayload,
	type AutocompleteInteractionOptions,
	autocompleteInteraction,
	type BaseInteractionOptions,
	type ButtonInteractionOptions,
	buttonInteraction,
	type ChatInputInteractionOptions,
	chatInputInteraction,
	DEFAULT_PERMISSIONS,
	type EntryPointInteractionOptions,
	entryPointInteraction,
	type MessageCommandInteractionOptions,
	type ModalSubmitInteractionOptions,
	messageCommandInteraction,
	modalSubmitInteraction,
	type OptionInput,
	type OptionInputBag,
	type SelectMenuInteractionOptions,
	selectMenuInteraction,
	type UserCommandInteractionOptions,
	userCommandInteraction,
} from './interactions';
import {
	type ApiChannel,
	type ApiMember,
	type ApiMemberOptions,
	type ApiMessage,
	type ApiUser,
	apiMember,
	apiMessage,
	apiUser,
} from './payloads';
import { computeChannelPermissions } from './permissions';
import {
	type ActionFilter,
	type ActionMatcher,
	type ActionPredicate,
	isOutgoingMessagePost,
	type MatchedAction,
	MockApiHandler,
	type RecordedAction,
	type RouteActionFilter,
	type RouteMatcher,
} from './rest';
import { FOLLOWUP_ROUTE, WEBHOOK_MESSAGE_ROUTE } from './routes';
import { type ChannelView, type GuildView, WorldState } from './state';
import { type MockWorld, seedWorld, type WorldBuilder } from './world';

export { Dispatch } from './dispatch';

type ClientConstructorOptions = ConstructorParameters<typeof Client>[0];
type ClientOptions = NonNullable<ClientConstructorOptions>;
type ServicesOptions = Parameters<Client['setServices']>[0];

const CommandOptionType = {
	SubCommand: 1,
	SubCommandGroup: 2,
	String: 3,
	Integer: 4,
	Boolean: 5,
	User: 6,
	Channel: 7,
	Role: 8,
	Mentionable: 9,
	Number: 10,
	Attachment: 11,
} as const;

interface CommandOptionDefinition {
	name: string;
	type: number;
	/** Set on a SubCommand instance when it belongs to a group; seyfert keys group membership here, not via a nested type-2 option. */
	group?: string;
	required?: boolean;
	choices?: { name: string; value: string | number }[];
	min_value?: number;
	max_value?: number;
	min_length?: number;
	max_length?: number;
	channel_types?: number[];
	options?: CommandOptionDefinition[];
}

interface CommandWithOptions {
	name: string;
	type: ApplicationCommandType;
	options?: CommandOptionDefinition[];
}

interface EncodedOptionLike {
	__slipherOption: true;
	type: number;
	value: string | number | boolean;
	resolved?: {
		channels?: Record<string, { type?: number }>;
	};
}

function isEncodedOption(value: OptionInput): value is EncodedOptionLike {
	return typeof value === 'object' && value !== null && '__slipherOption' in value;
}

type MiddlewareControl = (...args: never[]) => unknown;
interface MiddlewareControls {
	context: unknown;
	next: MiddlewareControl;
	stop: MiddlewareControl;
	pass: MiddlewareControl;
}
type WrappedMiddleware = (controls: MiddlewareControls) => unknown;

function optionEntries(options: OptionInputBag | undefined): [string, OptionInput][] {
	if (!options) return [];
	return Array.isArray(options) ? options.map(option => [option.name, option.value]) : Object.entries(options);
}

export interface CapturedReply {
	/** Discord interaction callback body captured before it would be sent. */
	body: APIInteractionResponse;
	/** Raw files passed with the reply, if any. */
	files?: unknown;
}

/** Message-shaped body sent through followups, edits, prefix commands, or REST echoes. */
export interface OutgoingMessage {
	content?: string;
	embeds?: unknown[];
	components?: unknown[];
	files?: unknown[];
	[key: string]: unknown;
}

/** Semantic result produced by interaction dispatchers. */
export interface DispatchResult {
	/** Immediate interaction callback replies, in order. */
	replies: CapturedReply[];
	/** The first immediate interaction callback, when present. */
	reply?: CapturedReply;
	/** True when the interaction deferred before sending final content. */
	deferred: boolean;
	/** True only when the interaction deferred a reply (type 5, DeferredChannelMessageWithSource). */
	deferredReply: boolean;
	/** True only when the interaction deferred a message update (type 6, DeferredMessageUpdate). */
	deferredUpdate: boolean;
	/** True when the immediate response carried Discord's ephemeral flag. */
	ephemeral: boolean;
	/** Modal metadata when the interaction opened a modal. */
	modal?: { customId?: string; title?: string };
	/** Original-response edits made during the dispatch. */
	edits: OutgoingMessage[];
	/** Followup messages sent during the dispatch. */
	followups: OutgoingMessage[];
	/** User-visible messages produced by replies, updates, edits, and followups in dispatch order. */
	messages: OutgoingMessage[];
	/** Embeds flattened from `messages`, in dispatch order. */
	embeds: unknown[];
	/** First embed from `embeds`, for simple one-embed assertions. */
	embed?: unknown;
	/** Files flattened from `messages`, in dispatch order. */
	files: unknown[];
	/** REST actions scoped to this dispatch. */
	actions: RecordedAction[];
	/** Best-effort latest user-visible content across replies, edits, and followups. */
	content?: string;
	/** Command leaf that handled the dispatch (chat input & context menus); undefined for components/modals. */
	command?: { name: string; group?: string; subcommand?: string };
	/** Resolved context-menu target; undefined for non-menu dispatches. */
	target?: {
		id: string;
		kind: 'user' | 'message';
		user?: ApiUser;
		member?: ApiMember;
		message?: ApiMessage;
	};
}

/** userMenu/menu(UserCommand) result: `target` is always present, so no optional chaining is needed. */
export interface UserMenuResult extends DispatchResult {
	target: { id: string; kind: 'user'; user: ApiUser; member?: ApiMember };
}

/** messageMenu/menu(MessageCommand) result: `target` is always present, so no optional chaining is needed. */
export interface MessageMenuResult extends DispatchResult {
	target: { id: string; kind: 'message'; message: ApiMessage; member?: ApiMember };
}

/**
 * Identity bag for say() uses the same field names as interaction dispatchers,
 * so copied `user` and `channel` test setup stays meaningful.
 */
export interface DispatchMessageOptions {
	/** The message author; equivalent to `user` on every interaction dispatcher. */
	user?: ApiUser;
	member?: Omit<ApiMemberOptions, 'user'>;
	/** Pass null for a DM message. */
	guildId?: string | null;
	channel?: ApiChannel;
}

export interface MessageResultBase {
	actions: RecordedAction[];
	messages: OutgoingMessage[];
	embeds: unknown[];
	embed?: unknown;
	files: unknown[];
	content?: string;
}

export interface SayResult extends MessageResultBase {}

/** Result of emitEvent: REST the event handler produced, derived from channel-message writes. */
export interface EventDispatchResult extends MessageResultBase {}

function messageParts(actions: RecordedAction[], messages: OutgoingMessage[]): MessageResultBase {
	const embeds = messages.flatMap(message => message.embeds ?? []);
	const files = messages.flatMap(message => message.files ?? []);
	return {
		actions,
		messages,
		embeds,
		files,
		content: messages.at(-1)?.content,
		get embed() {
			return embeds[0];
		},
	};
}

/** Identity and location bound to an Actor for repeated multi-step flows. */
export interface ActorOptions {
	user?: ApiUser;
	/**
	 * Full world member, including user. Dispatcher `member` bags intentionally
	 * use member options without a user; actor() accepts the seeded world shape.
	 */
	member?: ApiMember;
	guildId?: string | null;
	channel?: ApiChannel;
}

/** Bound dispatcher facade that reuses one identity across a flow. */
export interface Actor {
	slash(options: ChatInputInteractionOptions): Dispatch<DispatchResult>;
	autocomplete(options: AutocompleteInteractionOptions): Dispatch<AutocompleteResult>;
	userMenu(options: UserCommandInteractionOptions): Dispatch<UserMenuResult>;
	messageMenu(options: MessageCommandInteractionOptions): Dispatch<MessageMenuResult>;
	menu<C extends MenuCommandClass>(command: C, options?: MenuOptions<C>): Dispatch<MenuResultFor<C>>;
	entryPoint(options?: EntryPointInteractionOptions): Dispatch<DispatchResult>;
	fillModal(
		customId: string,
		fields?: Record<string, string>,
		options?: Omit<ModalSubmitInteractionOptions, 'customId' | 'fields'>,
	): Dispatch<DispatchResult>;
	clickButton(customId: string, options?: Parameters<MockBot['clickButton']>[1]): Dispatch<DispatchResult>;
	selectMenu(
		customId: string,
		values: string[],
		options?: Parameters<MockBot['selectMenu']>[2],
	): Dispatch<DispatchResult>;
	say(content: string, options?: DispatchMessageOptions): Dispatch<SayResult>;
	emitEvent<TName extends GatewayDispatchPayload['t']>(
		name: TName,
		payload?: Partial<Extract<GatewayDispatchPayload, { t: TName }>['d']>,
		options?: { updateCache?: boolean },
	): Dispatch<EventDispatchResult>;
	emitEvent(name: string, payload?: object, options?: { updateCache?: boolean }): Dispatch<EventDispatchResult>;
}

/** Autocomplete dispatch result with the responded choices lifted out semantically. */
export interface AutocompleteResult extends DispatchResult {
	choices?: { name: string; value: string | number }[];
}

/**
 * Canonical user-action dispatcher list. Add a matrix row whenever this grows.
 */
export const DISPATCHER_VERBS = [
	'slash',
	'clickButton',
	'selectMenu',
	'fillModal',
	'say',
	'autocomplete',
	'userMenu',
	'messageMenu',
	'entryPoint',
] as const satisfies readonly (keyof MockBot)[];

export type MockCommandClass = new () => Command | ContextMenuCommand | EntryPointCommand;

export type MenuCommandClass = new () => ContextMenuCommand;

/** Resolves a menu command class to its target type: User menus take an ApiUser, Message menus an ApiMessage. */
export type TargetFor<C extends MenuCommandClass> =
	InstanceType<C> extends { type: infer T }
		? [T] extends [ApplicationCommandType.User]
			? ApiUser
			: [T] extends [ApplicationCommandType.Message]
				? ApiMessage
				: ApiUser | ApiMessage
		: ApiUser | ApiMessage;

export type MenuOptions<C extends MenuCommandClass> = Omit<
	UserCommandInteractionOptions & MessageCommandInteractionOptions,
	'name' | 'target'
> & { target?: TargetFor<C> };

/** Resolves a menu command class to its dispatch result, so `result.target` is correctly typed and non-optional. */
export type MenuResultFor<C extends MenuCommandClass> =
	TargetFor<C> extends ApiUser ? UserMenuResult : TargetFor<C> extends ApiMessage ? MessageMenuResult : DispatchResult;
export type MockEvent = Omit<ClientEvent, 'data'> & {
	data: Omit<ClientEvent['data'], 'once'> & { once?: boolean };
};

/** Options used to boot an in-process Seyfert client without network transport. */
export interface MockBotOptions {
	/** Command classes to register directly. */
	commands?: MockCommandClass[];
	/** Component and modal command classes to register directly. */
	components?: Parameters<Client['components']['set']>[0];
	/** Event definitions to register directly. */
	events?: MockEvent[];
	/** Middleware registry passed to client.setServices(). */
	middlewares?: ServicesOptions['middlewares'];
	/** World entities to clone into the client cache and REST defaults. */
	world?: MockWorld | WorldBuilder;
	/** How unmatched fallback GET requests are handled. */
	onUnhandledRest?: 'warn' | 'error' | 'silent';
	/** Emit matching cache/gateway events for stateful REST mutations. */
	simulateGateway?: boolean;
	/** Number of mock gateway shards to expose. */
	shards?: number;
	/** Latency value reported by each mock shard. */
	shardLatency?: number;
	/** Bot user id used by the mock client identity. */
	botId?: string;
	/** Application id used for interactions and webhook routes. */
	applicationId?: string;
	/**
	 * Use this already-constructed Client instead of creating one. The mock REST and gateway are installed
	 * onto it, so a bot's module-level `client` singleton becomes the same instance the dispatchers drive —
	 * REST/cache through that singleton is captured. Pass an unstarted client; `clientOptions`/prefixes are ignored.
	 */
	client?: Client;
	/** Raw Seyfert client constructor options. */
	clientOptions?: ClientConstructorOptions;
	/** Global middlewares forwarded to the real Seyfert client. */
	globalMiddlewares?: ClientOptions['globalMiddlewares'];
	/** Prefixes enabled for message command dispatch through say(). */
	prefixes?: string[];
	/** Include bot mentions as valid prefixes for say(). */
	mentionAsPrefix?: boolean;
	/** Translations keyed by locale, e.g. { 'en-US': { greeting: 'Hello!' } }. */
	langs?: Record<string, Record<string, unknown>>;
	/** Fallback locale when the interaction's locale has no langs entry. */
	defaultLang?: string;
	/** Validate supplied slash options against registered command metadata before dispatching. */
	validateOptions?: boolean;
	/**
	 * Load the real bot from its seyfert.config locations before plugin setup.
	 */
	loadFromConfig?: boolean;
	/** Explicit commands directory; overrides config-resolved command locations. */
	commandsDir?: string;
	/** Explicit components directory; overrides config-resolved component locations. */
	componentsDir?: string;
	/** Explicit events directory; overrides config-resolved event locations. */
	eventsDir?: string;
	/** Explicit langs directory; overrides config-resolved lang locations. */
	langsDir?: string;
}

type WorldEventMutator = (state: WorldState, d: Record<string, unknown>) => void;

const WORLD_EVENT_MUTATORS: Record<string, WorldEventMutator> = {
	GUILD_MEMBER_ADD: (state, d) => {
		const guildId = typeof d.guild_id === 'string' ? d.guild_id : undefined;
		if (guildId) state.addMember(guildId, d);
	},
	GUILD_MEMBER_REMOVE: (state, d) => {
		const guildId = typeof d.guild_id === 'string' ? d.guild_id : undefined;
		const user = d.user as { id?: string } | undefined;
		if (guildId && user?.id) state.removeMember(guildId, user.id, false);
	},
	GUILD_MEMBER_UPDATE: (state, d) => {
		const guildId = typeof d.guild_id === 'string' ? d.guild_id : undefined;
		const user = d.user as { id?: string } | undefined;
		if (guildId && user?.id) {
			state.patchMember(guildId, user.id, {
				...('nick' in d ? { nick: d.nick as string | null } : {}),
				...(Array.isArray(d.roles) ? { roles: d.roles.map(String) } : {}),
				...('communication_disabled_until' in d
					? { communication_disabled_until: d.communication_disabled_until as string | null }
					: {}),
			});
		}
	},
	CHANNEL_CREATE: (state, d) => state.addChannel(typeof d.guild_id === 'string' ? d.guild_id : undefined, d),
	CHANNEL_DELETE: (state, d) => {
		if (typeof d.id === 'string') state.removeChannel(d.id);
	},
	MESSAGE_CREATE: (state, d) => {
		if (typeof d.channel_id === 'string') state.addMessage(d.channel_id, d);
	},
	MESSAGE_DELETE: (state, d) => {
		if (typeof d.channel_id === 'string' && typeof d.id === 'string') state.deleteMessage(d.channel_id, d.id);
	},
};

export const WORLD_EVENT_NAMES = Object.keys(WORLD_EVENT_MUTATORS) as readonly string[];

export class MockBot {
	readonly defaultUser: ApiUser = apiUser({ id: TEST_USER_ID, username: 'slipher-tester' });
	private readonly unregisteredMemberWarnings = new Set<string>();
	private readonly dispatches: Dispatch<unknown>[] = [];
	private closed = false;
	/** The most recent interaction-original message, used to resolve a collector source for an immediate reply. */
	private lastInteractionMessage?: { id: string; channel_id?: string };
	/** Component/modal detection capabilities, fixed at install time from the client's component surface. */
	private canDetectComponentCommand = false;
	private canDetectCollector = false;
	private canDetectModalCollector = false;

	constructor(
		readonly client: Client,
		readonly rest: MockApiHandler,
		readonly gateway: MockGateway,
		protected readonly world?: MockWorld,
		readonly state: WorldState = new WorldState(world),
		private readonly validateOptions = false,
	) {}

	private assertOpen(verb: string): void {
		if (this.closed) throw new Error(`${verb}: MockBot is closed.`);
	}

	private track<T>(dispatch: Dispatch<T>): Dispatch<T> {
		this.dispatches.push(dispatch as Dispatch<unknown>);
		return dispatch;
	}

	private applyWorldPermissions<T extends BaseInteractionOptions>(options: T): T {
		if (
			!this.world ||
			options.guildId === null ||
			options.guildId === undefined ||
			options.permissions !== undefined ||
			options.memberPermissions !== undefined ||
			options.memberRoles !== undefined
		) {
			return options;
		}

		const guild = this.world.guilds.find(entry => entry.id === options.guildId);
		if (!guild) {
			const seeded = this.world.guilds.map(entry => entry.id).join(', ') || '(none)';
			throw new TypeError(
				`applyWorldPermissions: guild "${options.guildId}" is not in the world. Seeded guilds: ${seeded}.`,
			);
		}

		const user = options.user ?? this.defaultUser;
		const memberEntry = this.world.members.find(
			entry => entry.guildId === guild.id && entry.member.user.id === user.id,
		);
		if (!memberEntry) {
			const key = `${guild.id}:${user.id}`;
			if (!this.unregisteredMemberWarnings.has(key)) {
				this.unregisteredMemberWarnings.add(key);
				const memberIds = this.world.members
					.filter(entry => entry.guildId === guild.id)
					.map(entry => entry.member.user.id)
					.join(', ');
				console.warn(
					`[@slipher/testing] applyWorldPermissions: user "${user.id}" is not registered in guild "${guild.id}". ` +
						`Seeded members: ${memberIds || '(none)'}. Register the user with world.registerMember(), ` +
						`dispatch as a registered user, or pass explicit memberPermissions.`,
				);
			}
			return options;
		}

		const guildRoles = this.world.roles.filter(entry => entry.guildId === guild.id).map(entry => entry.role);
		const seededChannel = options.channel
			? this.world.channels.find(channel => channel.id === options.channel?.id)
			: undefined;
		const channel = seededChannel ?? options.channel;
		const memberPermissions = computeChannelPermissions({
			guild,
			roles: guildRoles,
			member: {
				userId: memberEntry.member.user.id,
				roles: memberEntry.member.roles,
				communicationDisabledUntil: memberEntry.member.communication_disabled_until,
			},
			channel,
		});
		const next: T = {
			...options,
			user: memberEntry.member.user,
			member: {
				...(options.member ?? {}),
				roles: [...memberEntry.member.roles],
				communicationDisabledUntil: memberEntry.member.communication_disabled_until,
			},
			memberPermissions,
		};

		const botEntry = this.world.members.find(
			entry => entry.guildId === guild.id && entry.member.user.id === this.client.botId,
		);
		if (botEntry) {
			next.permissions = computeChannelPermissions({
				guild,
				roles: guildRoles,
				member: {
					userId: botEntry.member.user.id,
					roles: botEntry.member.roles,
					communicationDisabledUntil: botEntry.member.communication_disabled_until,
				},
				channel,
			});
		}

		return next;
	}

	private chatCommand(name: string): CommandWithOptions | undefined {
		return this.client.commands.values.find(
			command => command.type === ApplicationCommandType.ChatInput && command.name === name,
		) as CommandWithOptions | undefined;
	}

	// seyfert stores subcommands flat on `command.options`, each carrying `.group` for its group; the type-2
	// SubcommandGroup wrapper only exists in the wire payload, never in the registered command metadata.
	private subcommandsOf(name: string): CommandOptionDefinition[] {
		return (this.chatCommand(name)?.options ?? []).filter(option => option.type === CommandOptionType.SubCommand);
	}

	private optionDefinitionsFor(options: Pick<ChatInputInteractionOptions, 'name' | 'group' | 'subcommand'>) {
		let definitions = this.chatCommand(options.name)?.options ?? [];
		if (options.subcommand) {
			const sub = this.subcommandsOf(options.name).find(
				option =>
					option.name === options.subcommand && (options.group ? option.group === options.group : !option.group),
			);
			definitions = sub?.options ?? [];
		}
		return definitions.filter(
			option => option.type !== CommandOptionType.SubCommand && option.type !== CommandOptionType.SubCommandGroup,
		);
	}

	private assertSubcommandTarget(options: Pick<ChatInputInteractionOptions, 'name' | 'group' | 'subcommand'>): void {
		if (!options.group && !options.subcommand) return;
		const subcommands = this.subcommandsOf(options.name);
		if (options.group && !subcommands.some(sub => sub.group === options.group)) {
			throw new TypeError(`slash: subcommand group "${options.group}" is not registered on "${options.name}".`);
		}
		if (!options.subcommand) return;
		const found = subcommands.some(
			sub => sub.name === options.subcommand && (options.group ? sub.group === options.group : !sub.group),
		);
		if (!found) {
			const where = options.group ? `group "${options.group}"` : `"${options.name}"`;
			throw new TypeError(`slash: subcommand "${options.subcommand}" is not registered on ${where}.`);
		}
	}

	private optionTypesFor(definitions: CommandOptionDefinition[]): Record<string, number> {
		return Object.fromEntries(definitions.map(option => [option.name, option.type]));
	}

	private validateChatInputOptions(options: ChatInputInteractionOptions, definitions: CommandOptionDefinition[]): void {
		const entries = new Map(optionEntries(options.options));
		for (const definition of definitions) {
			const input = entries.get(definition.name);
			if (input === undefined) {
				if (definition.required) throw new TypeError(`slash: option "${definition.name}" is required.`);
				continue;
			}

			const actualType = isEncodedOption(input) ? input.type : undefined;
			const value = isEncodedOption(input) ? input.value : input;
			if (actualType !== undefined && actualType !== definition.type) {
				throw new TypeError(`slash: option "${definition.name}" has type ${actualType}, expected ${definition.type}.`);
			}
			if (definition.choices?.length && !definition.choices.some(choice => Object.is(choice.value, value))) {
				throw new TypeError(
					`slash: option "${definition.name}" must be one of: ${definition.choices
						.map(choice => String(choice.value))
						.join(', ')}.`,
				);
			}

			if (definition.type === CommandOptionType.String) {
				if (typeof value !== 'string') throw new TypeError(`slash: option "${definition.name}" must be a string.`);
				if (definition.min_length !== undefined && value.length < definition.min_length) {
					throw new TypeError(`slash: option "${definition.name}" is shorter than ${definition.min_length}.`);
				}
				if (definition.max_length !== undefined && value.length > definition.max_length) {
					throw new TypeError(`slash: option "${definition.name}" is longer than ${definition.max_length}.`);
				}
				continue;
			}

			if (definition.type === CommandOptionType.Integer || definition.type === CommandOptionType.Number) {
				if (typeof value !== 'number') throw new TypeError(`slash: option "${definition.name}" must be a number.`);
				if (definition.type === CommandOptionType.Integer && !Number.isInteger(value)) {
					throw new TypeError(`slash: option "${definition.name}" must be an integer.`);
				}
				if (definition.min_value !== undefined && value < definition.min_value) {
					throw new TypeError(`slash: option "${definition.name}" is less than ${definition.min_value}.`);
				}
				if (definition.max_value !== undefined && value > definition.max_value) {
					throw new TypeError(`slash: option "${definition.name}" is greater than ${definition.max_value}.`);
				}
				continue;
			}

			if (definition.type === CommandOptionType.Channel && definition.channel_types?.length && isEncodedOption(input)) {
				const channel = input.resolved?.channels?.[String(input.value)];
				if (channel?.type !== undefined && !definition.channel_types.includes(channel.type)) {
					throw new TypeError(
						`slash: option "${definition.name}" channel type ${channel.type} is not allowed. ` +
							`Allowed: ${definition.channel_types.join(', ')}.`,
					);
				}
			}
		}
	}

	private prepareChatInputOptions(options: ChatInputInteractionOptions): ChatInputInteractionOptions {
		this.assertSubcommandTarget(options);
		const definitions = this.optionDefinitionsFor(options);
		if (this.validateOptions) this.validateChatInputOptions(options, definitions);
		return {
			...options,
			optionTypes: {
				...(options.optionTypes ?? {}),
				...this.optionTypesFor(definitions),
			},
		};
	}

	private componentCommands(): readonly unknown[] {
		return this.client.components.commands;
	}

	private hasComponentCommand(): boolean {
		return this.componentCommands().some(command => !(command instanceof ModalCommand));
	}

	private hasModalCommand(): boolean {
		return this.componentCommands().some(command => command instanceof ModalCommand);
	}

	private assertComponentHandleable(verb: string, customId: string, message?: { id: string }): void {
		if (message || this.hasComponentCommand()) return;
		throw new TypeError(
			`${verb}: no source message resolved for "${customId}" and no ComponentCommand is registered. ` +
				`Send or pass a source message for collectors, or register a ComponentCommand handler.`,
		);
	}

	private assertModalHandleable(customId: string, userId: string): void {
		if (this.client.components.modals.has(userId) || this.hasModalCommand()) return;
		throw new TypeError(
			`fillModal: no modal "${customId}" is waiting for user "${userId}" and no ModalCommand is registered. ` +
				`Did you pass the same 'user' as the dispatch that opened the modal?`,
		);
	}

	lastSentMessage(): { id: string; channel_id?: string } | undefined {
		for (let i = this.rest.actions.length - 1; i >= 0; i--) {
			const action = this.rest.actions[i];
			const response = action.response as { id?: unknown; channel_id?: unknown } | undefined;
			if (response && typeof response.id === 'string' && /\/messages(\/|$)|\/webhooks\//.test(action.route)) {
				return {
					id: response.id,
					...(typeof response.channel_id === 'string' ? { channel_id: response.channel_id } : {}),
				};
			}
		}
		return undefined;
	}

	private resolveMessageSource(source?: string | RecordedAction): { id: string; channel_id?: string } | undefined {
		if (typeof source === 'string') return { id: source };
		if (source) {
			const response = source.response as { id?: unknown; channel_id?: unknown } | undefined;
			if (response && typeof response.id === 'string') {
				return {
					id: response.id,
					...(typeof response.channel_id === 'string' ? { channel_id: response.channel_id } : {}),
				};
			}
		}
		// Fall back to the most recent interaction-original message so a collector attached to an immediate
		// reply (which produces no channel-message REST action) still has a resolvable source.
		return this.lastSentMessage() ?? this.lastInteractionMessage;
	}

	private hydrateSourceMessage(source: { id: string; channel_id?: string }): ApiMessage {
		const stored = source.channel_id
			? this.state.rawMessage(source.channel_id, source.id)
			: this.state.rawMessageById(source.id);
		if (stored) return stored as unknown as ApiMessage;
		return apiMessage({ id: source.id, channelId: source.channel_id });
	}

	private worldMemberFor(guildId: string | null | undefined, user: ApiUser | undefined): ApiMember | undefined {
		if (!this.world || !guildId || !user) return undefined;
		return this.world.members.find(entry => entry.guildId === guildId && entry.member.user.id === user.id)?.member;
	}

	private normalizedSelectType(componentType: SelectMenuInteractionOptions['componentType']): 3 | 5 | 6 | 7 | 8 {
		if (componentType === undefined || componentType === 'string') return 3;
		if (componentType === 'user') return 5;
		if (componentType === 'role') return 6;
		if (componentType === 'mentionable') return 7;
		if (componentType === 'channel') return 8;
		return componentType;
	}

	private unknownSelectId(kind: string, customId: string, value: string, seeded: string[]): never {
		throw new TypeError(
			`selectMenu: unknown ${kind} id "${value}" for "${customId}". Seeded ${kind}s: ${seeded.join(', ') || '(none)'}.`,
		);
	}

	private resolveSelectResolved(
		customId: string,
		values: string[],
		options: Omit<SelectMenuInteractionOptions, 'customId' | 'values' | 'message'>,
	): SelectMenuInteractionOptions['resolved'] {
		if (options.resolved) return options.resolved;
		const type = this.normalizedSelectType(options.componentType);
		if (type === 3) return undefined;
		if (!this.world) {
			throw new TypeError(`selectMenu: "${customId}" is an entity select but no world or resolved data was provided.`);
		}

		if (type === 6) {
			const roles = this.world.roles.map(entry => entry.role);
			return {
				roles: Object.fromEntries(
					values.map(value => {
						const role = roles.find(entry => entry.id === value);
						if (!role)
							this.unknownSelectId(
								'role',
								customId,
								value,
								roles.map(entry => entry.id),
							);
						return [value, role];
					}),
				),
			};
		}

		if (type === 8) {
			const channels = this.world.channels;
			return {
				channels: Object.fromEntries(
					values.map(value => {
						const channel = channels.find(entry => entry.id === value);
						if (!channel)
							this.unknownSelectId(
								'channel',
								customId,
								value,
								channels.map(entry => entry.id),
							);
						return [value, { ...channel, permissions: DEFAULT_PERMISSIONS }];
					}),
				),
			};
		}

		const users: Record<string, unknown> = {};
		const members: Record<string, unknown> = {};
		const roles: Record<string, unknown> = {};
		for (const value of values) {
			const role = this.world.roles.find(entry => entry.role.id === value)?.role;
			const user = this.world.users.find(entry => entry.id === value);
			const member = this.world.members.find(
				entry =>
					entry.member.user.id === value &&
					(options.guildId === undefined || options.guildId === null || entry.guildId === options.guildId),
			);
			if (type === 5) {
				const resolvedUser = user ?? member?.member.user;
				if (!resolvedUser)
					this.unknownSelectId(
						'user',
						customId,
						value,
						this.world.users.map(entry => entry.id),
					);
				users[value] = resolvedUser;
				if (member) members[value] = { permissions: DEFAULT_PERMISSIONS, ...member.member };
				continue;
			}
			if (role) {
				roles[value] = role;
				continue;
			}
			const resolvedUser = user ?? member?.member.user;
			if (resolvedUser) {
				users[value] = resolvedUser;
				if (member) members[value] = { permissions: DEFAULT_PERMISSIONS, ...member.member };
				continue;
			}
			this.unknownSelectId('mentionable', customId, value, [
				...this.world.roles.map(entry => entry.role.id),
				...this.world.users.map(entry => entry.id),
				...this.world.members.map(entry => entry.member.user.id),
			]);
		}

		return {
			...(Object.keys(users).length ? { users } : {}),
			...(Object.keys(members).length ? { members } : {}),
			...(Object.keys(roles).length ? { roles } : {}),
		};
	}

	get actions(): readonly RecordedAction[] {
		return this.rest.actions;
	}

	waitForAction(
		matcherOrPredicate: RouteMatcher | ActionFilter | ActionPredicate,
		timeoutMs?: number,
	): Promise<RecordedAction> {
		if (typeof matcherOrPredicate === 'function') return this.rest.waitForAction(matcherOrPredicate, timeoutMs);
		return this.rest.waitForAction(matcherOrPredicate, timeoutMs);
	}

	findCalls(matcher: RouteMatcher | ActionPredicate, params?: Record<string, string>): MatchedAction[];
	findCalls(matcher: RouteMatcher, filter: RouteActionFilter): MatchedAction[];
	findCalls(matcher: ActionFilter | ActionPredicate): MatchedAction[];
	findCalls(matcher: ActionMatcher, paramsOrFilter?: Record<string, string> | RouteActionFilter): MatchedAction[];
	findCalls(matcher: ActionMatcher, paramsOrFilter?: Record<string, string> | RouteActionFilter): MatchedAction[] {
		return this.rest.findCalls(matcher, paramsOrFilter);
	}

	findCall(matcher: RouteMatcher | ActionPredicate, params?: Record<string, string>): MatchedAction | undefined;
	findCall(matcher: RouteMatcher, filter: RouteActionFilter): MatchedAction | undefined;
	findCall(matcher: ActionFilter | ActionPredicate): MatchedAction | undefined;
	findCall(
		matcher: ActionMatcher,
		paramsOrFilter?: Record<string, string> | RouteActionFilter,
	): MatchedAction | undefined;
	findCall(
		matcher: ActionMatcher,
		paramsOrFilter?: Record<string, string> | RouteActionFilter,
	): MatchedAction | undefined {
		return this.rest.findCall(matcher, paramsOrFilter);
	}

	clearActions(): void {
		this.rest.clearActions();
	}

	cachedGuild(guildId: string): GuildView | undefined {
		return this.state.guild(guildId);
	}

	/** The current world member for a guild/user, or undefined when absent (e.g. after a kick). */
	cachedMember(guildId: string, userId: string): ApiMember | undefined {
		return this.world?.members.find(entry => entry.guildId === guildId && entry.member.user.id === userId)?.member;
	}

	cachedDm(userId: string): ChannelView | undefined {
		return this.state.dm(userId);
	}

	dispatchInteraction(payload: ApiInteractionPayload): Dispatch<DispatchResult> {
		this.assertOpen('dispatchInteraction');
		const userId = payload.member?.user.id ?? payload.user?.id;
		const dispatchId = nextDispatchId();
		return this.track(new Dispatch(this.rest, this.client, userId, () => this.runInteraction(payload, dispatchId)));
	}

	private materializeInteractionResponse(payload: ApiInteractionPayload, body: APIInteractionResponse): void {
		if (body.type === 4) {
			// The callback interceptor already materialized the original; point lastInteractionMessage at it
			// so a collector created on the immediate reply (with no explicit source) resolves to the same id.
			const original = this.state.messageForToken(payload.token);
			const id = typeof original?.id === 'string' ? original.id : undefined;
			if (id) this.lastInteractionMessage = { id, channel_id: payload.channel_id };
			return;
		}
		if (body.type === 7 && payload.message) {
			const data = 'data' in body ? ((body.data ?? {}) as Record<string, unknown>) : {};
			this.state.editMessage(payload.message.channel_id, payload.message.id, data);
			this.lastInteractionMessage = { id: payload.message.id, channel_id: payload.message.channel_id };
		}
	}

	private commandLeaf(payload: ApiInteractionPayload): DispatchResult['command'] {
		if (
			payload.type !== InteractionType.ApplicationCommand &&
			payload.type !== InteractionType.ApplicationCommandAutocomplete
		) {
			return undefined;
		}
		const data = payload.data as
			| { name?: string; options?: { name: string; type: number; options?: { name: string; type: number }[] }[] }
			| undefined;
		if (!data?.name) return undefined;
		let group: string | undefined;
		let subcommand: string | undefined;
		const first = Array.isArray(data.options) ? data.options[0] : undefined;
		if (first?.type === CommandOptionType.SubCommandGroup) {
			group = first.name;
			const nested = first.options?.[0];
			if (nested?.type === CommandOptionType.SubCommand) subcommand = nested.name;
		} else if (first?.type === CommandOptionType.SubCommand) {
			subcommand = first.name;
		}
		return { name: data.name, ...(group ? { group } : {}), ...(subcommand ? { subcommand } : {}) };
	}

	private commandTarget(payload: ApiInteractionPayload): DispatchResult['target'] {
		const data = payload.data;
		const targetId = data.target_id;
		if (!targetId) return undefined;
		const resolved = data.resolved;
		if (data.type === 2) {
			const user = resolved?.users?.[targetId] as ApiUser | undefined;
			const member = resolved?.members?.[targetId] as ApiMember | undefined;
			return { id: targetId, kind: 'user', ...(user ? { user } : {}), ...(member ? { member } : {}) };
		}
		if (data.type === 3) {
			const message = resolved?.messages?.[targetId] as ApiMessage | undefined;
			const member = message ? (resolved?.members?.[message.author.id] as ApiMember | undefined) : undefined;
			return { id: targetId, kind: 'message', ...(message ? { message } : {}), ...(member ? { member } : {}) };
		}
		return undefined;
	}

	/**
	 * Wait until the mock REST surface stops changing: the recorded-action count must hold steady across a
	 * macrotask AND no request may be in flight. This replaces a fixed single-tick guess so a denial guard whose
	 * reply needs multiple async hops (or whose REST responder awaits) still records before the dispatch settles.
	 * Bounded by `timeoutMs` so a guard that genuinely never replies cannot hang the dispatch.
	 */
	private async drainUntilQuiescent(
		dispatchId: number | undefined,
		aborted: () => boolean,
		timeoutMs = 2000,
	): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		let lastCount = -1;
		while (!aborted()) {
			const count = this.rest.actions.filter(action => action.dispatchId === dispatchId).length;
			const quiet = count === lastCount && !this.rest.hasPendingRequests(dispatchId);
			if (quiet) return;
			lastCount = count;
			if (Date.now() > deadline) return;
			await new Promise<void>(resolve => setImmediate(resolve));
		}
	}

	/**
	 * Install the component/middleware wrappers ONCE on the shared client singletons. Each wrapper reads the
	 * active dispatch via AsyncLocalStorage (dispatchStore.getStore()) instead of closing over per-dispatch
	 * call-local flags, so concurrent dispatches never clobber each other's resolution state.
	 *
	 * @internal Called once by createMockBot after setup; not part of the public surface.
	 */
	installDispatchHooks(): void {
		const componentHooks = this.client.components as unknown as {
			execute?: (...args: unknown[]) => Promise<unknown>;
			onComponent?: (id: string, interaction: { customId: string }) => Promise<unknown>;
			hasComponent?: (id: string, customId: string) => boolean | undefined;
			onModalSubmit?: (interaction: { user: { id: string } }) => unknown;
		};
		this.canDetectComponentCommand = typeof componentHooks.execute === 'function';
		this.canDetectCollector =
			typeof componentHooks.onComponent === 'function' && typeof componentHooks.hasComponent === 'function';
		this.canDetectModalCollector = typeof componentHooks.onModalSubmit === 'function';

		if (this.canDetectComponentCommand) {
			const execute = componentHooks.execute?.bind(componentHooks);
			componentHooks.execute = async (...args: unknown[]) => {
				const ctx = dispatchStore.getStore();
				if (ctx) ctx.componentCommandExecuted = true;
				return execute?.(...args);
			};
		}
		if (this.canDetectCollector) {
			const onComponent = componentHooks.onComponent?.bind(componentHooks);
			componentHooks.onComponent = async (id, interaction) => {
				const ctx = dispatchStore.getStore();
				if (ctx) ctx.collectorMatched = Boolean(componentHooks.hasComponent?.(id, interaction.customId));
				return onComponent?.(id, interaction);
			};
		}
		if (this.canDetectModalCollector) {
			const onModalSubmit = componentHooks.onModalSubmit?.bind(componentHooks);
			componentHooks.onModalSubmit = interaction => {
				const ctx = dispatchStore.getStore();
				if (ctx) ctx.modalMatched = true;
				return onModalSubmit?.(interaction);
			};
		}
		// Denial detection: seyfert's __runMiddlewares only resolves on next()/stop()/pass(). A guard that
		// replies and returns without calling any of them leaves the chain pending forever, so command.run is
		// structurally never reached and handleCommand.interaction never settles. Wrap each middleware to notice
		// when it terminates the chain and settle the dispatch with whatever was already captured.
		const middlewares = this.client.middlewares as Record<string, WrappedMiddleware> | undefined;
		if (middlewares) {
			for (const key of Object.keys(middlewares)) {
				const real = middlewares[key];
				middlewares[key] = (controls: MiddlewareControls) => {
					const ctx = dispatchStore.getStore();
					// progressed is per-invocation: a middleware chain runs sequentially, so each invocation
					// gets its own flag. It must NOT be hoisted into the shared dispatch context.
					let progressed = false;
					const mark =
						(fn: MiddlewareControl): MiddlewareControl =>
						(...args) => {
							progressed = true;
							return fn(...args);
						};
					const result = real({
						...controls,
						next: mark(controls.next),
						stop: mark(controls.stop),
						pass: mark(controls.pass),
					});
					Promise.resolve(result).then(
						() => {
							if (progressed) return;
							// The middleware denied (replied + returned without next/stop/pass). Its reply may still be
							// recording through async REST hops, so don't settle after a single tick. Drain until this
							// dispatch's REST surface is quiescent: action count stable across a tick AND none in flight.
							void this.drainUntilQuiescent(ctx?.dispatchId, () => progressed).then(() => {
								if (!progressed) ctx?.resolveDenial?.();
							});
						},
						() => {},
					);
					return result;
				};
			}
		}
	}

	private async runInteraction(payload: ApiInteractionPayload, dispatchId: number): Promise<DispatchResult> {
		const replies: CapturedReply[] = [];
		const isComponentPayload = payload.type === InteractionType.MessageComponent;
		const isModalPayload = payload.type === InteractionType.ModalSubmit;
		const ctx: DispatchContext = {
			dispatchId,
			componentCommandExecuted: false,
			collectorMatched: false,
			modalMatched: false,
		};
		// Denial detection: seyfert's __runMiddlewares only resolves on next()/stop()/pass(). A guard that
		// replies and returns without calling any of them leaves the chain pending forever, so command.run is
		// structurally never reached and handleCommand.interaction never settles. The installed middleware
		// wrappers settle this promise once a denying middleware's REST surface goes quiescent.
		const denialSettled = new Promise<void>(resolve => {
			ctx.resolveDenial = resolve;
		});
		this.state.registerInteractionToken(payload.token, payload.channel_id);
		// The builders preserve Discord's payload shape while exposing a wider test input type.
		await dispatchStore.run(ctx, async () => {
			await Promise.race([
				// No __reply callback: seyfert takes its gateway reply branch and posts the interaction callback
				// through the mock REST (intercepted in defaults), so it returns a real message for with_response
				// exactly like a gateway bot. Replies are captured from that recorded callback action below.
				this.client.handleCommand.interaction(payload as unknown as APIInteraction, -1),
				denialSettled,
			]);
		});
		const { componentCommandExecuted, collectorMatched, modalMatched } = ctx;
		if (
			isComponentPayload &&
			this.canDetectCollector &&
			this.canDetectComponentCommand &&
			!collectorMatched &&
			!componentCommandExecuted
		) {
			throw new TypeError(
				`clickButton/selectMenu: no component handler resolved for "${payload.data.custom_id ?? '(unknown)'}".`,
			);
		}
		if (
			isModalPayload &&
			this.canDetectModalCollector &&
			this.canDetectComponentCommand &&
			!modalMatched &&
			!componentCommandExecuted
		) {
			throw new TypeError(`fillModal: no modal handler resolved for "${payload.data.custom_id ?? '(unknown)'}".`);
		}
		// This dispatch owns the actions it stamped, plus any interaction-token-routed action (callback, followups,
		// original-response edits) for THIS interaction's token. The latter may be emitted from a different async
		// frame — e.g. a modal submit whose reply is written inside the opener command's resumed continuation — so
		// the token, which is unique per interaction, is the reliable owner key for those responses.
		const actions = this.rest.actions.filter(
			action => action.dispatchId === dispatchId || action.route.includes(payload.token),
		);
		if (replies.length === 0) {
			const callback = actions.find(
				action => action.method === 'POST' && action.route === `/interactions/${payload.id}/${payload.token}/callback`,
			);
			if (callback?.body) {
				// Seyfert's callback body is the same interaction response union after transport shaping.
				const reply = { body: callback.body as unknown as APIInteractionResponse, files: callback.files };
				replies.push(reply);
				this.materializeInteractionResponse(payload, reply.body);
			}
		}
		const toOutgoingMessage = (action: RecordedAction): OutgoingMessage => ({
			...((action.body ?? {}) as OutgoingMessage),
			...(action.files ? { files: action.files } : {}),
		});
		const normalizeFiles = (files: unknown): unknown[] | undefined => {
			if (files === undefined) return undefined;
			return Array.isArray(files) ? files : [files];
		};
		const replyToMessage = (reply: CapturedReply): OutgoingMessage | undefined => {
			const body = reply.body;
			if (
				body.type !== InteractionResponseType.ChannelMessageWithSource &&
				body.type !== InteractionResponseType.UpdateMessage
			) {
				return undefined;
			}
			const data = 'data' in body ? ((body.data ?? {}) as OutgoingMessage) : {};
			return {
				...data,
				...(reply.files ? { files: normalizeFiles(reply.files) } : {}),
			};
		};
		const isWebhookMessageEdit = (action: RecordedAction) =>
			action.method === 'PATCH' && WEBHOOK_MESSAGE_ROUTE.test(action.route) && action.route.includes(payload.token);
		const isFollowup = (action: RecordedAction) =>
			action.method === 'POST' && FOLLOWUP_ROUTE.test(action.route) && action.route.includes(payload.token);
		const edits = actions.filter(isWebhookMessageEdit).map(toOutgoingMessage);
		const followups = actions.filter(isFollowup).map(toOutgoingMessage);
		const messages = [
			...replies.map(replyToMessage).filter((message): message is OutgoingMessage => message !== undefined),
			...actions.filter(action => isWebhookMessageEdit(action) || isFollowup(action)).map(toOutgoingMessage),
		];
		const embeds = messages.flatMap(message => message.embeds ?? []);
		const files = messages.flatMap(message => message.files ?? []);
		const command = this.commandLeaf(payload);
		const target = this.commandTarget(payload);

		return {
			replies,
			edits,
			followups,
			messages,
			embeds,
			files,
			actions,
			command,
			target,
			get reply() {
				return replies[0];
			},
			get deferred() {
				return replies[0]?.body.type === 5 || replies[0]?.body.type === 6;
			},
			get deferredReply() {
				return replies[0]?.body.type === 5;
			},
			get deferredUpdate() {
				return replies[0]?.body.type === 6;
			},
			get ephemeral() {
				const replyEphemeral = replies.some(reply => {
					const data = 'data' in reply.body ? (reply.body.data as { flags?: number } | undefined) : undefined;
					return Boolean(typeof data?.flags === 'number' && data.flags & 64);
				});
				return (
					replyEphemeral || messages.some(message => Boolean(typeof message.flags === 'number' && message.flags & 64))
				);
			},
			get embed() {
				return embeds[0];
			},
			get modal() {
				const body = replies[0]?.body;
				if (body?.type !== 9) return undefined;
				const data = body.data as { custom_id?: string; title?: string } | undefined;
				return { customId: data?.custom_id, title: data?.title };
			},
			get content() {
				return [...messages].reverse().find(message => typeof message.content === 'string')?.content;
			},
		};
	}

	private assertCommandRegistered(name: string, type: ApplicationCommandType, verb: string): void {
		const registered = this.client.commands.values
			.filter(command => command.type === type)
			.map(command => command.name);
		if (!registered.includes(name)) {
			const typeName = ApplicationCommandType[type] ?? String(type);
			throw new TypeError(
				`${verb}: command "${name}" is not registered as ${typeName}. ` +
					`Registered ${typeName} commands: ${registered.join(', ') || '(none)'}`,
			);
		}
	}

	private dispatchVia<O extends BaseInteractionOptions, R = DispatchResult>(
		verb: string,
		options: O,
		build: (prepared: O) => ApiInteractionPayload,
	): Dispatch<R> {
		this.assertOpen(verb);
		const prepared = this.applyWorldPermissions({ user: this.defaultUser, ...options });
		return this.dispatchInteraction(build(prepared)) as Dispatch<R>;
	}

	slash(options: ChatInputInteractionOptions): Dispatch<DispatchResult> {
		this.assertCommandRegistered(options.name, ApplicationCommandType.ChatInput, 'slash');
		return this.dispatchVia('slash', this.prepareChatInputOptions(options), chatInputInteraction);
	}

	autocomplete(options: AutocompleteInteractionOptions): Dispatch<AutocompleteResult> {
		this.assertOpen('autocomplete');
		this.assertCommandRegistered(options.name, ApplicationCommandType.ChatInput, 'autocomplete');
		const definitions = this.optionDefinitionsFor(options);
		const payload = autocompleteInteraction(
			this.applyWorldPermissions({
				user: this.defaultUser,
				...options,
				optionTypes: { ...(options.optionTypes ?? {}), ...this.optionTypesFor(definitions) },
			}),
		);
		const userId = payload.member?.user.id ?? payload.user?.id;
		const dispatchId = nextDispatchId();
		return this.track(
			new Dispatch(this.rest, this.client, userId, async () => {
				const result = await this.runInteraction(payload, dispatchId);
				const body = result.reply?.body;
				return { ...result, choices: body?.type === 8 ? body.data?.choices : undefined };
			}),
		);
	}

	userMenu(options: UserCommandInteractionOptions): Dispatch<UserMenuResult> {
		this.assertCommandRegistered(options.name, ApplicationCommandType.User, 'userMenu');
		return this.dispatchVia<UserCommandInteractionOptions, UserMenuResult>('userMenu', options, prepared => {
			const targetMember = options.targetMember ?? this.worldMemberFor(prepared.guildId, prepared.target);
			return userCommandInteraction({ ...prepared, ...(targetMember ? { targetMember } : {}) });
		});
	}

	messageMenu(options: MessageCommandInteractionOptions): Dispatch<MessageMenuResult> {
		this.assertCommandRegistered(options.name, ApplicationCommandType.Message, 'messageMenu');
		return this.dispatchVia<MessageCommandInteractionOptions, MessageMenuResult>('messageMenu', options, prepared => {
			const targetMember = options.targetMember ?? this.worldMemberFor(prepared.guildId, prepared.target?.author);
			return messageCommandInteraction({ ...prepared, ...(targetMember ? { targetMember } : {}) });
		});
	}

	menu<C extends MenuCommandClass>(command: C, options: MenuOptions<C> = {}): Dispatch<MenuResultFor<C>> {
		const instance = new command();
		if (instance.type === ApplicationCommandType.User) {
			return this.userMenu({
				...options,
				name: instance.name,
			} as UserCommandInteractionOptions) as Dispatch<MenuResultFor<C>>;
		}
		return this.messageMenu({
			...(options as MessageCommandInteractionOptions),
			name: instance.name,
		}) as Dispatch<MenuResultFor<C>>;
	}

	entryPoint(options: EntryPointInteractionOptions = {}): Dispatch<DispatchResult> {
		return this.dispatchVia('entryPoint', options, entryPointInteraction);
	}

	clickButton(
		customId: string,
		options: Omit<ButtonInteractionOptions, 'customId' | 'message'> & { source?: string | RecordedAction } = {},
	): Dispatch<DispatchResult> {
		const { source, ...rest } = options;
		const opts: ButtonInteractionOptions = { ...rest, customId };
		return this.dispatchVia('clickButton', opts, prepared => {
			const message = this.resolveMessageSource(source);
			this.assertComponentHandleable('clickButton', customId, message);
			return buttonInteraction({
				...prepared,
				...(message?.id ? { message: this.hydrateSourceMessage(message) } : {}),
			});
		});
	}

	selectMenu(
		customId: string,
		values: string[],
		options: Omit<SelectMenuInteractionOptions, 'customId' | 'values' | 'message'> & {
			source?: string | RecordedAction;
		} = {},
	): Dispatch<DispatchResult> {
		const { source, ...rest } = options;
		const opts: SelectMenuInteractionOptions = { ...rest, customId, values };
		return this.dispatchVia('selectMenu', opts, prepared => {
			const message = this.resolveMessageSource(source);
			this.assertComponentHandleable('selectMenu', customId, message);
			const resolved = this.resolveSelectResolved(customId, values, prepared);
			return selectMenuInteraction({
				...prepared,
				...(resolved ? { resolved } : {}),
				...(message?.id ? { message: this.hydrateSourceMessage(message) } : {}),
			});
		});
	}

	fillModal(
		customId: string,
		fields: Record<string, string> = {},
		extra: Omit<ModalSubmitInteractionOptions, 'customId' | 'fields'> = {},
	): Dispatch<DispatchResult> {
		const opts: ModalSubmitInteractionOptions = { ...extra, customId, fields };
		return this.dispatchVia('fillModal', opts, prepared => {
			this.assertModalHandleable(customId, prepared.user?.id ?? this.defaultUser.id);
			return modalSubmitInteraction(prepared);
		});
	}

	say(content: string, options: DispatchMessageOptions = {}): Dispatch<SayResult> {
		this.assertOpen('say');
		const author = options.user ?? this.defaultUser;
		const dm = options.guildId === null;
		const guildId = dm ? undefined : (options.guildId ?? options.channel?.guild_id ?? TEST_GUILD_ID);
		const member = apiMember({ user: author, ...(options.member ?? {}) });
		const { user: _user, ...gatewayMember } = member;
		const raw = {
			...apiMessage({
				author,
				content,
				channelId: options.channel?.id ?? TEST_CHANNEL_ID,
				...(guildId ? { guildId } : {}),
			}),
			...(dm ? {} : { member: gatewayMember }),
		};

		const dispatchId = nextDispatchId();
		return this.track(
			new Dispatch(this.rest, this.client, author.id, async () => {
				await dispatchStore.run(
					{ dispatchId, componentCommandExecuted: false, collectorMatched: false, modalMatched: false },
					() => this.client.handleCommand.message(raw as Parameters<HandleCommand['message']>[0], -1),
				);
				const actions = this.rest.actions.filter(action => action.dispatchId === dispatchId);
				const messages = actions.filter(isOutgoingMessagePost).map(action => (action.body ?? {}) as OutgoingMessage);
				return messageParts(actions, messages);
			}),
		);
	}

	actor(options: ActorOptions): Actor {
		const entry = options.member
			? this.world?.members.find(candidate => candidate.member.user.id === options.member?.user.id)
			: undefined;
		const user = options.user ?? options.member?.user;
		const guildId = options.guildId ?? entry?.guildId ?? options.channel?.guild_id ?? TEST_GUILD_ID;
		const channel =
			options.channel ??
			(entry ? this.world?.channels.find(candidate => candidate.guild_id === entry.guildId) : undefined);
		const base = { user, guildId, channel };

		return {
			slash: options => this.slash({ ...base, ...options }),
			autocomplete: options => this.autocomplete({ ...base, ...options }),
			userMenu: options => this.userMenu({ ...base, ...options }),
			messageMenu: options => this.messageMenu({ ...base, ...options }),
			menu: (command, options) => this.menu(command, { ...base, ...options } as MenuOptions<typeof command>),
			entryPoint: options => this.entryPoint({ ...base, ...options }),
			fillModal: (customId, fields, options = {}) => this.fillModal(customId, fields, { ...base, ...options }),
			clickButton: (customId, options = {}) => this.clickButton(customId, { ...base, ...options }),
			selectMenu: (customId, values, options = {}) => this.selectMenu(customId, values, { ...base, ...options }),
			say: (content, options = {}) => this.say(content, { ...base, ...options }),
			emitEvent: (name: string, payload: Record<string, unknown> = {}, options?: { updateCache?: boolean }) => {
				const merged: Record<string, unknown> = {
					...(guildId ? { guild_id: guildId } : {}),
					...(user ? { user } : {}),
					...payload,
				};
				return this.emitEvent(name as GatewayDispatchPayload['t'], merged, options);
			},
		};
	}

	emitEvent<TName extends GatewayDispatchPayload['t']>(
		name: TName,
		payload: Partial<Extract<GatewayDispatchPayload, { t: TName }>['d']>,
		options?: { updateCache?: boolean },
	): Dispatch<EventDispatchResult>;
	emitEvent(name: string, payload: object, options?: { updateCache?: boolean }): Dispatch<EventDispatchResult>;
	emitEvent(
		name: string,
		payload: object,
		{ updateCache = true }: { updateCache?: boolean } = {},
	): Dispatch<EventDispatchResult> {
		this.assertOpen('emitEvent');
		const d = payload as Record<string, unknown>;
		const dispatchId = nextDispatchId();
		return this.track(
			new Dispatch<EventDispatchResult>(this.rest, this.client, undefined, async () => {
				if (updateCache) this.applyWorldEvent(name, d);
				await dispatchStore.run(
					{ dispatchId, componentCommandExecuted: false, collectorMatched: false, modalMatched: false },
					() =>
						this.client.events.runEvent(
							name as Parameters<Client['events']['runEvent']>[0],
							this.client,
							d,
							-1,
							updateCache,
						),
				);
				const actions = this.rest.actions.filter(action => action.dispatchId === dispatchId);
				const messages = actions.filter(isOutgoingMessagePost).map(action => (action.body ?? {}) as OutgoingMessage);
				return messageParts(actions, messages);
			}),
		);
	}

	private applyWorldEvent(name: string, d: Record<string, unknown>): void {
		WORLD_EVENT_MUTATORS[name]?.(this.state, d);
	}

	reset(): void {
		this.assertOpen('reset');
		this.rest.clearActions();
		this.rest.releasePending();
		this.rest.resetInterceptors();
		this.dispatches.length = 0;
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		const unstarted = this.dispatches.filter(dispatch => !dispatch.started);
		if (unstarted.length) {
			console.warn(`[@slipher/testing] ${unstarted.length} dispatch(es) were created but never awaited or stepped.`);
		}
		this.rest.releasePending();
		await this.client.close();
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.close();
	}
}

export async function createMockBot(options: MockBotOptions = {}): Promise<MockBot> {
	resetMockIds();
	resetDispatchIds();
	const rest = new MockApiHandler({ onUnhandledRest: options.onUnhandledRest });
	const built =
		options.world && typeof (options.world as WorldBuilder).build === 'function'
			? (options.world as WorldBuilder).build()
			: (options.world as MockWorld | undefined);
	const world = built ? structuredClone(built) : undefined;
	const botId = options.botId ?? TEST_BOT_ID;
	const prefixList = [...(options.prefixes ?? []), ...(options.mentionAsPrefix ? [`<@${botId}>`, `<@!${botId}>`] : [])];
	const clientOptions: ClientConstructorOptions =
		prefixList.length || options.globalMiddlewares
			? {
					...options.clientOptions,
					...(options.globalMiddlewares ? { globalMiddlewares: options.globalMiddlewares } : {}),
					...(prefixList.length
						? {
								commands: {
									...options.clientOptions?.commands,
									prefix: async () => prefixList,
								},
							}
						: {}),
				}
			: options.clientOptions;
	const client = options.client ?? new Client(clientOptions);
	const gateway = new MockGateway(options.shards ?? 1, options.shardLatency ?? 0);
	// Client#setServices wraps the custom gateway's existing send hook; seed it from clientOptions first.
	if (options.clientOptions?.handleSendPayload)
		gateway.options.handleSendPayload = options.clientOptions.handleSendPayload;

	client.setServices({
		rest,
		// ShardManager is a concrete class in Seyfert; MockGateway mirrors the runtime surface bots test against.
		gateway: gateway as unknown as Client['gateway'],
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
		(client as unknown as { langBaseValues: typeof client.langs.values }).langBaseValues = structuredClone(
			client.langs.values,
		);
	}
	if (options.defaultLang) {
		client.langs.defaultLang = options.defaultLang;
	}
	client.botId = options.botId ?? ((options.client && client.botId) || botId);
	client.applicationId = options.applicationId ?? ((options.client && client.applicationId) || TEST_APPLICATION_ID);

	if (options.commands) {
		// Seyfert's command handler accepts constructor arrays at runtime, but its type expects loaded command metadata.
		client.commands.set(options.commands as unknown as Parameters<Client['commands']['set']>[0]);
	}
	if (options.components) client.components.set(options.components);
	if (options.events) {
		const events = options.events.map(event => ({ ...event, data: { once: false, ...event.data } }));
		// Tests pass public event definitions; Seyfert fills the internal loader-only fields when executing.
		client.events.set(events as Parameters<Client['events']['set']>[0]);
	}
	const loadFromConfig = options.loadFromConfig === true;
	if (loadFromConfig || options.commandsDir) await client.loadCommands(options.commandsDir);
	if (loadFromConfig || options.componentsDir) await client.loadComponents(options.componentsDir);
	if (loadFromConfig || options.eventsDir) await client.loadEvents(options.eventsDir);
	if (loadFromConfig || options.langsDir) await client.loadLangs(options.langsDir);

	// Plugin setup/contribution refresh are intentionally not public on Client, but production start() calls them.
	await (client as unknown as { setupPlugins(): Promise<void> }).setupPlugins();
	await (client as unknown as { reloadPluginContributions(): Promise<void> }).reloadPluginContributions();
	// seedWorld only needs the UsingClient cache/rest surface already installed above.
	if (world) await seedWorld(client as unknown as UsingClient, world);
	const state = new WorldState(world);
	registerWorldDefaults(rest, world, {
		emit: (name, payload) => client.events.runEvent(name, client, payload, -1, true) as Promise<void>,
		removeCachedMember: async (guildId, userId) => {
			await client.cache.members?.remove(userId, guildId);
		},
		setCachedMember: async (guildId, userId, member) => {
			await client.cache.members?.set(CacheFrom.Test, userId, guildId, member);
		},
		simulateGateway: options.simulateGateway ?? true,
		state,
		botId: client.botId,
	});
	rest.markDefaultsBaseline();

	const bot = new MockBot(client, rest, gateway, world, state, options.validateOptions ?? false);
	bot.installDispatchHooks();
	return bot;
}
