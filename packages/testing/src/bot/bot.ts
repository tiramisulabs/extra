import {
	Client,
	type Command,
	type CommandContext,
	type ContextMenuCommand,
	type ContextOptions,
	type EntryPointCommand,
	ModalCommand,
	type OptionsRecord,
} from 'seyfert';
import { CacheFrom } from 'seyfert/lib/cache';
import {
	type AnySeyfertPlugin,
	type PluginDiagnostics,
	type ResolvedPluginList,
	runPluginHooks,
} from 'seyfert/lib/client/plugins';
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
import { Dispatch, type ModalWaiter, type ModalWaitRegistration } from './dispatch';
import { type DispatchContext, type DispatchDenial, dispatchStore, nextDispatchId } from './dispatch-context';
import { MockGateway } from './gateway';
import { installDispatchHooks as installDispatchHooksImpl } from './hooks';
import {
	type ApiInteractionPayload,
	type AutocompleteInteractionOptions,
	autocompleteInteraction,
	type BaseInteractionOptions,
	type ButtonInteractionOptions,
	buttonInteraction,
	type ChatInputInteractionOptions,
	chatInputInteraction,
	type EntryPointInteractionOptions,
	entryPointInteraction,
	type MessageCommandInteractionOptions,
	type ModalSubmitInteractionOptions,
	messageCommandInteraction,
	modalSubmitInteraction,
	type SelectMenuInteractionOptions,
	selectMenuInteraction,
	type UserCommandInteractionOptions,
	userCommandInteraction,
} from './interactions';
import { isEphemeral } from './message-flags';
import { CommandOptionType, prepareAutocompleteOptions, prepareChatInputOptions } from './option-validation';
import {
	type ApiChannel,
	type ApiMember,
	type ApiMessage,
	type ApiUser,
	type ApiVoiceState,
	apiMember,
	apiMessage,
	apiUser,
	type MemberInput,
	memberOptionsFrom,
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
	type TypedMatchedAction,
} from './rest';
import { FOLLOWUP_ROUTE, Routes, WEBHOOK_MESSAGE_ROUTE } from './routes';
import {
	actionRendersComponent,
	collectComponentCustomIds,
	findComponentNode,
	findComponentType,
	selectTypeForInteraction,
} from './component-tree';
import { resolveSelectResolved } from './select-resolved';
import {
	asClientGateway,
	asUsingClient,
	cacheStore,
	clientLifecycle,
	eventsInternals,
	modalRegistry,
	normalizeGatewayEventName,
	pluginEventNames,
} from './seyfert-internals';
import {
	arrayValue,
	asRecord,
	type ChannelView,
	type EmbedView,
	type GuildMemberView,
	type GuildView,
	harvestComponents,
	renderedReply,
	type InteractiveComponentView,
	type MessageView,
	normalizeEmbed,
	numberValue,
	type RoleView,
	stringValue,
	type WorldDiff,
	type WorldSnapshot,
	WorldState,
	type WorldStateReader,
} from './state';
import { type MockWorld, seedWorld, type WorldBuilder } from './world';
import { applyWorldEvent, WORLD_EVENT_NAMES } from './world-events';

export { Dispatch } from './dispatch';
export { WORLD_EVENT_NAMES } from './world-events';

type ClientConstructorOptions = ConstructorParameters<typeof Client>[0];
type ClientOptions = NonNullable<ClientConstructorOptions>;
type MockClientOptions = Omit<ClientOptions, 'plugins'>;
type ServicesOptions = Parameters<Client['setServices']>[0];

async function runMockClientStartup(client: Client, options: MockBotOptions): Promise<void> {
	const lifecycle = clientLifecycle(client);
	const loadFromConfig = options.loadFromConfig === true;

	await lifecycle.setupPlugins();
	lifecycle.refreshPluginContributions();
	await runPluginHooks(client, 'plugins:ready', client);
	await client.cache.adapter.start();

	if (loadFromConfig || options.langsDir) await client.loadLangs(options.langsDir);
	if (options.defaultLang) client.langs.defaultLang = options.defaultLang;

	await runPluginHooks(client, 'commands:beforeLoad', client, options.commandsDir);
	if (loadFromConfig || options.commandsDir) await client.loadCommands(options.commandsDir);
	await lifecycle.reloadPluginCommands();

	if (loadFromConfig || options.componentsDir) await client.loadComponents(options.componentsDir);
	await lifecycle.reloadPluginComponents();

	if (loadFromConfig || options.eventsDir) await client.loadEvents(options.eventsDir);
}

export interface CapturedReply {
	/** Discord interaction callback body captured before it would be sent. */
	body: APIInteractionResponse;
	/** Raw files passed with the reply, if any. */
	files?: unknown;
}

/**
 * Message-shaped body sent through followups, edits, prefix commands, or REST echoes.
 *
 * Fields are the Discord message-create/edit *body* fields the mock surfaces — not a full API
 * message. The set is declared explicitly (no open index signature) so a misspelled field
 * (`result.messages[0].flgs`) is a compile error rather than silently typed `unknown`.
 */
export interface OutgoingMessage {
	content?: string;
	embeds?: unknown[];
	components?: unknown[];
	files?: unknown[];
	flags?: number;
	tts?: boolean;
	nonce?: string | number;
	enforce_nonce?: boolean;
	allowed_mentions?: unknown;
	attachments?: unknown[];
	message_reference?: unknown;
	sticker_ids?: string[];
	poll?: unknown;
}

type ComponentSourceOptions = {
	source?: string | RecordedAction;
	allowSyntheticSource?: boolean;
};

const INTERACTION_WEBHOOK_ROUTES = [
	Routes.followup,
	Routes.fetchOriginalResponse,
	Routes.editOriginalResponse,
	Routes.deleteOriginalResponse,
	Routes.fetchWebhookMessage,
	Routes.editWebhookMessage,
	Routes.deleteWebhookMessage,
] as const;

type MessageSource = { id: string; channel_id?: string };
type MessagePart = { body: OutgoingMessage; source?: MessageSource };
type BindComponentView = (view: InteractiveComponentView, source?: MessageSource) => ComponentActionView;

export interface ComponentSourceView {
	messageId: string;
	channelId?: string;
}

export type ComponentClickOptions = Omit<ButtonInteractionOptions, 'customId' | 'message'> &
	Omit<ComponentSourceOptions, 'source'>;

export type ComponentSelectOptions = Omit<SelectMenuInteractionOptions, 'customId' | 'values' | 'message'> &
	Omit<ComponentSourceOptions, 'source'>;

/** Interactive component harvested from a dispatch result, bound to the message that rendered it. */
export interface ComponentActionView extends InteractiveComponentView {
	source?: ComponentSourceView;
	click(options?: ComponentClickOptions): Dispatch<DispatchResult>;
	select(values: string[], options?: ComponentSelectOptions): Dispatch<DispatchResult>;
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
	/** Raw embeds flattened from `messages`, in dispatch order. */
	embeds: unknown[];
	/** First raw embed from `embeds`. */
	embed?: unknown;
	/** Parsed, typed camelCase embed views over `messages` — assert on these instead of casting raw `embed`. */
	embedViews: EmbedView[];
	/** First parsed embed view, for the common single-embed assertion. */
	embedView?: EmbedView;
	/** Interactive components collected from `messages[].components`. */
	components: ComponentActionView[];
	/** Lookup for an interactive component by label or customId. */
	component(labelOrCustomId: string): ComponentActionView | undefined;
	/** Components-v2 TextDisplay (type 10) contents, in dispatch order. */
	textDisplays: string[];
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
	/**
	 * True when the dispatch was denied before the command's `run` body: a permission guard rejected it, or a
	 * middleware stopped the chain / returned without progressing. Lets security tests assert the denial
	 * structurally instead of matching the reply copy. Defaults to false.
	 */
	denied: boolean;
	/** Structured denial detail; present only when `denied` is true. */
	denial?: DispatchDenial;
	/**
	 * An unhandled error thrown inside the command/component/modal `run` that the author did not handle. Present
	 * only under `onCommandError: 'capture'`; with the default `'throw'` the dispatch rejects with it instead.
	 */
	error?: unknown;
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
	/** The author's guild member. Accepts a loose options bag or a full {@link ApiMember}. */
	member?: MemberInput;
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
	/** Parsed, typed camelCase embed views over `messages` — assert on these instead of casting raw `embed`. */
	embedViews: EmbedView[];
	/** First parsed embed view, for the common single-embed assertion. */
	embedView?: EmbedView;
	/** Interactive components collected from `messages[].components`. */
	components: ComponentActionView[];
	/** Lookup for an interactive component by label or customId. */
	component(labelOrCustomId: string): ComponentActionView | undefined;
	/** Components-v2 TextDisplay (type 10) contents, in dispatch order. */
	textDisplays: string[];
}

export interface SayResult extends MessageResultBase {}

/** Result of emit: REST the event handler produced, derived from channel-message writes. */
export interface EventDispatchResult extends MessageResultBase {
	/**
	 * An unhandled error thrown inside an emitted event's handler. Present only under
	 * `onCommandError: 'capture'`; with the default `'throw'` the dispatch rejects with it instead.
	 */
	error?: unknown;
}

/** Options for {@link MockBot.emit}. */
export interface EmitEventOptions {
	/** Apply the event to world state via the world bridge (default `true`). */
	updateCache?: boolean;
	/**
	 * Permit an emit that no registered `Event`/listener handled. By default emit fails loud when nothing ran.
	 * Set `true` when intentionally emitting only to seed world state with no handler (default `false`).
	 */
	allowNoHandler?: boolean;
}

/** Read-only descriptor of a registered application command, surfaced by {@link MockBot.registeredCommands}. */
export interface RegisteredCommand {
	name: string;
	type: 'chatInput' | 'user' | 'message' | 'entryPoint';
}

/** Read-only descriptor of a registered component/modal handler, surfaced by {@link MockBot.registeredComponents}. */
export interface RegisteredComponent {
	name: string;
	kind: 'component' | 'modal';
}

/**
 * Read-only descriptor of a plugin loaded on the client, surfaced by {@link MockBot.plugins}. Pairs each
 * plugin's identity (`name`/`instanceId`) with seyfert's own resolved diagnostics — the contribution counts
 * (`commands`, `components`, `modals`), the keys it added to the client/context (`clientKeys`, `ctxKeys`),
 * its `events`, `middlewares`, `shared` keys, and lifecycle `status`. `plugin` is the original plugin object,
 * for asserting against a setup-set flag or surface directly. `diagnostics` is undefined when seyfert produced
 * no diagnostic entry for the plugin (e.g. it failed to resolve).
 */
export interface PluginInfo {
	name: string;
	instanceId?: string;
	status?: PluginDiagnostics['status'];
	clientKeys: readonly string[];
	ctxKeys: readonly string[];
	commands: number;
	components: number;
	modals: number;
	events: readonly string[];
	middlewares: readonly string[];
	shared: readonly string[];
	plugin: AnySeyfertPlugin;
	diagnostics?: PluginDiagnostics;
}

/** Plain-data snapshot for debugging a hung dispatch, surfaced by {@link MockBot.diagnostics}. */
export interface BotDiagnostics {
	/** Dispatches created but not yet settled. */
	pending: { id?: string; started: boolean; settled: boolean }[];
	/** The most recent recorded REST actions, oldest-first. */
	recentActions: RecordedAction[];
}

function buildMessageResult(
	actions: RecordedAction[],
	parts: MessagePart[],
	bindComponentView: BindComponentView,
): MessageResultBase {
	const messages = parts.map(part => part.body);
	const embeds = messages.flatMap(message => message.embeds ?? []);
	const files = messages.flatMap(message => message.files ?? []);
	const embedViews = embeds.map(normalizeEmbed);
	const components: ComponentActionView[] = [];
	const textDisplays: string[] = [];
	for (const part of parts) {
		const harvested = harvestComponents((part.body as { components?: unknown }).components);
		components.push(...harvested.components.map(component => bindComponentView(component, part.source)));
		textDisplays.push(...harvested.textDisplays);
	}
	return {
		actions,
		messages,
		embeds,
		files,
		content: messages.at(-1)?.content,
		embedViews,
		components,
		component(labelOrCustomId: string) {
			return components.find(view => view.customId === labelOrCustomId || view.label === labelOrCustomId);
		},
		textDisplays,
		get embed() {
			return embeds[0];
		},
		get embedView() {
			return embedViews[0];
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
	slash<C extends SlashCommandClass>(command: C, options?: SlashClassOptions<C>): Dispatch<DispatchResult>;
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
	emit<TName extends GatewayDispatchPayload['t']>(
		name: TName,
		payload?: Partial<Extract<GatewayDispatchPayload, { t: TName }>['d']>,
		options?: EmitEventOptions,
	): Dispatch<EventDispatchResult>;
	emit(name: string, payload?: object | readonly unknown[], options?: EmitEventOptions): Dispatch<EventDispatchResult>;
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

/**
 * Resolves a menu command class to its target type: User menus take an ApiUser, Message menus an ApiMessage.
 *
 * The narrowing depends on the class declaring its `type` as a literal, i.e.
 * `type = ApplicationCommandType.User as const`. Without `as const`, `type` widens to the full
 * `ApplicationCommandType` enum, the literal branches no longer match, and this degrades **gracefully** to
 * the `ApiUser | ApiMessage` union (paired with {@link MenuResultFor} → {@link DispatchResult}). That is a
 * usable fallback, not a type error — but you lose the checked, narrowed target. Declare `as const` to opt
 * into the strict path.
 */
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

/** A chat-input command class, accepted by the class-first {@link MockBot.slash} overload. */
export type SlashCommandClass = new () => Command;

/**
 * Extracts the seyfert {@link OptionsRecord} a chat-input command declares, by reading the generic of its
 * `run` parameter's {@link CommandContext}. This is the same record the author already wires up to get typed
 * `ctx.options`, i.e. `run(ctx: CommandContext<typeof options>)` (the standard seyfert idiom).
 *
 * The shape is recovered from the `run` *override's* parameter type, NOT from the class itself: seyfert's
 * `@Options(...)` decorator widens the instance `options` field to `SubCommand[] | CommandOption[]` and a
 * decorator's return type is not applied to `typeof Class`, so the named option shape lives only on the
 * `CommandContext<T>` the author annotated. When `run` is left as the base `CommandContext` (no generic, or
 * the class omits a typed `run`), `T` is seyfert's default `{}` and this degrades to an empty record —
 * exactly the graceful fallback the `menu(Class)` precedent uses for non-`as const` classes.
 */
export type OptionsRecordOf<C extends SlashCommandClass> = InstanceType<C>['run'] extends (
	ctx: infer Ctx,
	...rest: never[]
) => unknown
	? Ctx extends CommandContext<infer T>
		? T
		: {}
	: {};

/**
 * Resolves a chat-input command class to the value-typed options bag — `{ count: number, query?: string }` —
 * by mapping {@link OptionsRecordOf} through seyfert's own `ContextOptions`. Used to type BOTH the `options`
 * you pass to `slash(Class, { options })` and, transitively, the author's `ctx.options`. Degrades to an empty
 * record (`Record<string, never>`) when the class does not declare a typed options record.
 */
export type SlashOptionsOf<C extends SlashCommandClass> =
	OptionsRecordOf<C> extends OptionsRecord ? ContextOptions<OptionsRecordOf<C>> : Record<string, never>;

/**
 * Options accepted by the class-first {@link MockBot.slash} overload: every {@link ChatInputInteractionOptions}
 * field except `name` (derived from the class) and `options` (whose value bag is inferred to {@link SlashOptionsOf}).
 */
export type SlashClassOptions<C extends SlashCommandClass> = Omit<ChatInputInteractionOptions, 'name' | 'options'> & {
	options?: SlashOptionsOf<C>;
};

export type MockEvent = Omit<ClientEvent, 'data'> & {
	data: Omit<ClientEvent['data'], 'once'> & { once?: boolean };
};

/** Options used to boot an in-process Seyfert client without network transport. */
export interface MockBotOptions {
	/** Command class(es) to register directly — a single class or an array. */
	commands?: MockCommandClass | MockCommandClass[];
	/** Component and modal command classes to register directly. */
	components?: Parameters<Client['components']['set']>[0];
	/** Event definitions to register directly. */
	events?: MockEvent[];
	/** Middleware registry passed to client.setServices(). */
	middlewares?: ServicesOptions['middlewares'];
	/** World entities to clone into the client cache and REST defaults. */
	world?: WorldBuilder;
	/** How unmatched fallback GET requests are handled. */
	onUnhandledRest?: 'warn' | 'error' | 'silent';
	/**
	 * How an unhandled error thrown inside a command/component/modal `run` (that the author did not handle with
	 * their own `onRunError`) is surfaced. `'throw'` (default) rejects the dispatch so a happy-path test fails
	 * loud; `'capture'` resolves normally and exposes it on {@link DispatchResult.error} for explicit assertion.
	 */
	onCommandError?: 'throw' | 'capture';
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
	/**
	 * Seyfert plugins to load on the client. Plugins must reach the Client constructor, where seyfert resolves
	 * them and runs each plugin's `setup`. `bot.plugins` surfaces the loaded list and `bot.close()` (via
	 * `client.close()`) runs each plugin's `teardown`.
	 */
	plugins?: readonly AnySeyfertPlugin[];
	/** Raw Seyfert client constructor options, excluding plugin loading. Use `plugins` for plugins. */
	clientOptions?: MockClientOptions;
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
	/** Validate supplied slash/autocomplete options against registered command metadata before dispatching. */
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
	/**
	 * Bridge to the test runner's fake-timer clock, used by {@link MockBot.advanceTime}. The mock cannot own
	 * seyfert's collector/modal timers (they use bare global setTimeout with no injection seam), so advancing
	 * them is delegated to the runner's fake timers via this user-supplied callback — keeping the package source
	 * runner-agnostic (no vitest/jest import). The runner's clock MUST fake only `setTimeout`/`clearTimeout`
	 * (faking `setImmediate` deadlocks the mock's drain): vitest/sinon list the timers TO fake
	 * (`vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })`); jest uses the inverted `doNotFake` to keep
	 * `setImmediate` real. Then `timers: { advance: ms => vi.advanceTimersByTime(ms) }`.
	 */
	timers?: { advance(ms: number): void | Promise<void> };
}

/** Upper bound on drain loop iterations: terminates the loop even when Date.now() is frozen by fake timers. */
const DRAIN_MAX_ITERATIONS = 1000;

/**
 * Capture the real setImmediate at module load so a drain tick can yield a macrotask even after the user has
 * faked global timers (vi.useFakeTimers() replaces globalThis.setImmediate). If the runtime has no
 * setImmediate, fall through to a microtask yield.
 */
const capturedSetImmediate: typeof setImmediate | undefined =
	typeof setImmediate === 'function' ? setImmediate : undefined;
const realSetImmediate: typeof setImmediate | undefined = capturedSetImmediate
	? capturedSetImmediate.bind(globalThis)
	: undefined;

/**
 * Entity-create routes for {@link MockBot.created}, mapping a friendly resource name to the POST route that
 * creates it. `message` is a direct channel send (`POST /channels/:id/messages`), NOT an interaction reply —
 * for those query {@link Routes.editOriginalResponse}/`followup`.
 */
const CREATE_ROUTES = {
	channel: Routes.createChannel,
	role: Routes.createRole,
	message: Routes.createMessage,
	thread: Routes.createThread,
	dm: Routes.createDm,
	webhook: Routes.createWebhook,
	invite: Routes.createInvite,
	emoji: Routes.createEmoji,
	sticker: Routes.createSticker,
	scheduledEvent: Routes.createScheduledEvent,
	autoModRule: Routes.createAutoModRule,
	stageInstance: Routes.createStageInstance,
} as const satisfies Record<string, RouteMatcher>;

export type CreatedResource = keyof typeof CREATE_ROUTES;

/**
 * Yield once so pending async (REST hops, collector onStop continuations) can settle. Uses the real
 * setImmediate captured at load — so it advances even when the user faked global timers — and otherwise a
 * microtask. Robust to faked timers: never schedules through the faked global, so it cannot hang.
 */
function drainTick(): Promise<void> {
	if (realSetImmediate) return new Promise<void>(resolve => realSetImmediate(() => resolve()));
	return Promise.resolve();
}

/**
 * Fail fast if the global setImmediate the drain relies on has been faked since module load. vi.useFakeTimers()
 * with its default toFake replaces globalThis.setImmediate, which deadlocks {@link drainTick} (it would spin to
 * the iteration cap and return non-quiescent). Only trips when a real setImmediate was captured at load and the
 * current global no longer matches it; on runtimes without setImmediate the guard is skipped.
 */
function assertRealSetImmediate(): void {
	if (!capturedSetImmediate) return;
	if (globalThis.setImmediate === capturedSetImmediate) return;
	throw new Error(
		'advanceTime/flushPending: global setImmediate has been replaced by fake timers, which deadlocks the ' +
			"mock's async drain. Fake only the timers seyfert uses: " +
			"vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }).",
	);
}

export class MockBot {
	readonly defaultUser: ApiUser = apiUser({ id: TEST_USER_ID, username: 'slipher-tester' });
	private readonly unregisteredMemberWarnings = new Set<string>();
	private readonly dispatches: Dispatch<unknown>[] = [];
	/** Pending modal waiters keyed by userId; resolved when seyfert registers a modal via components.modals.set. */
	private readonly modalWaiters = new Map<string, ModalWaiter[]>();
	/** The dispatch that owns the currently registered waitFor modal for a user. */
	private readonly modalOwners = new Map<string, number>();
	/** Modal definition displayed to a user (customId + input customIds), captured when seyfert registers it. */
	private readonly displayedModals = new Map<string, { customId?: string; inputIds: Set<string> }>();
	private virtualNowMs = Date.now();
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
		protected readonly _world: MockWorld | undefined,
		// Required (no default): createMockBot passes the SAME WorldState it gives registerWorldDefaults. A default
		// `new WorldState(world)` here would silently create a second instance that shares the world arrays by
		// reference but has its own bans/reactions/token Maps — a split-brain. Keep them the one instance.
		private readonly _state: WorldState,
		private readonly validateOptions = true,
		private readonly timers?: { advance(ms: number): void | Promise<void> },
		private readonly onCommandError: 'throw' | 'capture' = 'throw',
	) {}

	/**
	 * Read-only view of the simulated world for assertions — the full entity-query surface behind the
	 * `world*` accessors. Exposes only query methods; the `@internal` mutators that the mock drives in
	 * response to Discord traffic are not part of this public type. Use the {@link MockBot} verbs (or REST
	 * routes) to change world state.
	 */
	get world(): WorldStateReader {
		return this._state;
	}

	private assertOpen(verb: string): void {
		if (this.closed) throw new Error(`${verb}: MockBot is closed.`);
	}

	private track<T>(dispatch: Dispatch<T>): Dispatch<T> {
		this.dispatches.push(dispatch as Dispatch<unknown>);
		return dispatch;
	}

	private bindComponentView(view: InteractiveComponentView, source?: MessageSource): ComponentActionView {
		const sourceView: ComponentSourceView | undefined = source
			? { messageId: source.id, ...(source.channel_id ? { channelId: source.channel_id } : {}) }
			: undefined;
		const sourceOption = source ? { source: source.id } : {};
		const requireCustomId = (verb: 'click' | 'select'): string => {
			if (!view.customId) {
				throw new TypeError(`component.${verb}: component has no customId and cannot be dispatched.`);
			}
			if (view.disabled) {
				throw new TypeError(`component.${verb}: component "${view.customId}" is disabled.`);
			}
			return view.customId;
		};

		return {
			...view,
			...(sourceView ? { source: sourceView } : {}),
			click: (options = {}) => {
				const customId = requireCustomId('click');
				if (view.type !== 2) {
					throw new TypeError(
						`component.click: component "${customId}" is type ${view.type}, not a button. ` +
							'Use component.select(values) for select menus.',
					);
				}
				return this.clickButton(customId, { ...options, ...sourceOption });
			},
			select: (values, options = {}) => {
				const customId = requireCustomId('select');
				const isSelect = view.type === 3 || (view.type >= 5 && view.type <= 8);
				if (!isSelect) {
					throw new TypeError(
						`component.select: component "${customId}" is type ${view.type}, not a select menu. ` +
							'Use component.click() for buttons.',
					);
				}
				return this.selectMenu(customId, values, { ...options, ...sourceOption });
			},
		};
	}

	private messageParts(actions: RecordedAction[], parts: MessagePart[]): MessageResultBase {
		return buildMessageResult(actions, parts, (view, source) => this.bindComponentView(view, source));
	}

	private outgoingMessagePart(action: RecordedAction): MessagePart {
		return {
			body: {
				...((action.body ?? {}) as OutgoingMessage),
				...(action.files ? { files: action.files } : {}),
			},
			source: this.messageSourceFrom(action.response),
		};
	}

	private applyWorldPermissions<T extends BaseInteractionOptions>(options: T): T {
		if (
			!this._world ||
			options.guildId === null ||
			options.guildId === undefined ||
			options.permissions !== undefined ||
			options.memberPermissions !== undefined ||
			options.memberRoles !== undefined
		) {
			return options;
		}

		const guild = this._world.guilds.find(entry => entry.id === options.guildId);
		if (!guild) {
			const seeded = this._world.guilds.map(entry => entry.id).join(', ') || '(none)';
			throw new TypeError(
				`applyWorldPermissions: guild "${options.guildId}" is not in the world. Seeded guilds: ${seeded}.`,
			);
		}

		const user = options.user ?? this.defaultUser;
		const memberEntry = this._world.members.find(
			entry => entry.guildId === guild.id && entry.member.user.id === user.id,
		);
		if (!memberEntry) {
			const key = `${guild.id}:${user.id}`;
			if (!this.unregisteredMemberWarnings.has(key)) {
				this.unregisteredMemberWarnings.add(key);
				const memberIds = this._world.members
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

		const guildRoles = this._world.roles.filter(entry => entry.guildId === guild.id).map(entry => entry.role);
		const seededChannel = options.channel
			? this._world.channels.find(channel => channel.id === options.channel?.id)
			: undefined;
		const channel = seededChannel ?? options.channel;
		const memberPermissions = computeChannelPermissions(
			{
				guild,
				roles: guildRoles,
				member: {
					userId: memberEntry.member.user.id,
					roles: memberEntry.member.roles,
					communicationDisabledUntil: memberEntry.member.communication_disabled_until,
				},
				channel,
			},
			this.nowMs(),
		);
		const next: T = {
			...options,
			user: memberEntry.member.user,
			member: {
				...(options.member ? memberOptionsFrom(options.member) : {}),
				roles: [...memberEntry.member.roles],
				communicationDisabledUntil: memberEntry.member.communication_disabled_until,
			},
			memberPermissions,
		};

		const botEntry = this._world.members.find(
			entry => entry.guildId === guild.id && entry.member.user.id === this.client.botId,
		);
		if (botEntry) {
			next.permissions = computeChannelPermissions(
				{
					guild,
					roles: guildRoles,
					member: {
						userId: botEntry.member.user.id,
						roles: botEntry.member.roles,
						communicationDisabledUntil: botEntry.member.communication_disabled_until,
					},
					channel,
				},
				this.nowMs(),
			);
		}

		return next;
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

	/**
	 * True when a registered ComponentCommand STATICALLY matches `customId` (by string or RegExp `customId` — not
	 * a runtime `filter`, which needs a live context). Lets a source-less click auto-target it without the
	 * `allowSyntheticSource` flag: with no source message there's no live collector, so the command is the only
	 * unambiguous destination.
	 */
	private componentCommandMatches(customId: string): boolean {
		return this.componentCommands().some(command => {
			if (command instanceof ModalCommand) return false;
			const id = (command as { customId?: string | RegExp }).customId;
			if (typeof id === 'string') return id === customId;
			if (id instanceof RegExp) return id.test(customId);
			return false;
		});
	}

	/**
	 * Build a diagnostic for an unmatched component/modal dispatch that distinguishes the two failure modes:
	 * (a) no handler of the right kind is registered at all, vs (b) one IS registered but its customId/filter
	 * rejected this customId (e.g. a typo). Mirrors seyfert's `_filter`: the customId predicate is computed
	 * here without side effects; `filter(context)` is only noted, never invoked, since it needs a live context.
	 */
	private describeUnmatchedComponent(kind: 'component' | 'modal', customId: string): string {
		const handlers = this.componentCommands().filter(command =>
			kind === 'modal' ? command instanceof ModalCommand : !(command instanceof ModalCommand),
		) as {
			constructor: { name: string };
			customId?: string | RegExp;
			filter?: unknown;
		}[];

		if (handlers.length === 0) {
			const kindName = kind === 'modal' ? 'modal' : 'component';
			const CommandName = kind === 'modal' ? 'ModalCommand' : 'ComponentCommand';
			return (
				`no ${kindName} handlers are registered; pass components:[...] to createMockBot ` +
				`(or register a ${CommandName}).`
			);
		}

		const describe = (handler: (typeof handlers)[number]): string => {
			const name = handler.constructor?.name || '(anonymous)';
			if (typeof handler.customId === 'string') {
				if (handler.customId !== customId) return `${name} (customId "${handler.customId}" rejected "${customId}")`;
				return `${name} (customId matched; filter rejected)`;
			}
			if (handler.customId instanceof RegExp) {
				if (!handler.customId.test(customId)) {
					return `${name} (customId ${String(handler.customId)} rejected "${customId}")`;
				}
				return `${name} (customId matched; filter rejected)`;
			}
			if (typeof handler.filter === 'function') return `${name} (filter rejected "${customId}")`;
			return `${name} (no customId/filter; did not match)`;
		};

		const listed = handlers.map(handler => `[${describe(handler)}]`).join(', ');
		const kindName = kind === 'modal' ? 'modal' : 'component';
		return `no handler matched customId "${customId}". Registered ${kindName} handlers: ${listed}. Check the customId/filter.`;
	}

	private assertSyntheticComponentAllowed(verb: 'clickButton' | 'selectMenu', customId: string): void {
		if (this.hasComponentCommand()) return;
		throw new TypeError(
			`${verb}: allowSyntheticSource can only dispatch to a ComponentCommand, but no component command is registered ` +
				`for "${customId}". Send or pass the source message for collectors.`,
		);
	}

	/**
	 * Structural cross-check: seyfert collectors route purely by customId (no type filter), so clicking a button
	 * on a customId that the source message actually declares as a select menu (or vice versa) would silently
	 * fire the wrong handler — a false green where the handler reads `.values` off a button interaction. When the
	 * resolved message carries the component definition, assert the dispatch verb matches the declared type.
	 */
	private assertComponentVerbType(verb: 'clickButton' | 'selectMenu', customId: string, message: ApiMessage): void {
		const type = findComponentType(message.components, customId);
		if (type === undefined) return;
		const isSelect = type === 3 || (type >= 5 && type <= 8);
		if (verb === 'clickButton' && isSelect) {
			throw new TypeError(
				`clickButton: customId "${customId}" on this message is a select menu (type ${type}), not a button. ` +
					`Use bot.selectMenu("${customId}", [values]) instead.`,
			);
		}
		if (verb === 'selectMenu' && type === 2) {
			throw new TypeError(
				`selectMenu: customId "${customId}" on this message is a button (type 2), not a select menu. ` +
					`Use bot.clickButton("${customId}") instead.`,
			);
		}
	}

	private requireComponentOnMessage(
		verb: 'clickButton' | 'selectMenu',
		customId: string,
		message: ApiMessage,
	): Record<string, unknown> {
		const component = findComponentNode(message.components, customId);
		if (!component) {
			throw new TypeError(
				`${verb}: source message "${message.id}" does not contain a component with customId "${customId}". ` +
					`Pass the message that actually rendered the component.`,
			);
		}
		this.assertComponentVerbType(verb, customId, message);
		if (component.disabled === true) {
			throw new TypeError(`${verb}: component "${customId}" on source message "${message.id}" is disabled.`);
		}
		return component;
	}

	private assertSelectValuesMatchSource(customId: string, values: string[], component: Record<string, unknown>): void {
		const type = numberValue(component.type);
		if (type !== 3 && !(type !== undefined && type >= 5 && type <= 8)) return;
		const min = numberValue(component.min_values) ?? 1;
		const max = numberValue(component.max_values) ?? 1;
		if (values.length < min) {
			throw new TypeError(`selectMenu: "${customId}" selected ${values.length} value(s), below min_values ${min}.`);
		}
		if (values.length > max) {
			throw new TypeError(`selectMenu: "${customId}" selected ${values.length} value(s), above max_values ${max}.`);
		}
		if (type !== 3) return;
		const allowed = new Set(
			arrayValue(component.options)
				.map(option => stringValue(asRecord(option).value))
				.filter((value): value is string => value !== undefined),
		);
		for (const value of values) {
			if (!allowed.has(value)) {
				const known = [...allowed].join(', ') || '(none)';
				throw new TypeError(`selectMenu: value "${value}" is not an option for "${customId}". Known values: ${known}.`);
			}
		}
	}

	private assertModalHandleable(customId: string, userId: string): void {
		if (this.client.components.modals.has(userId) || this.hasModalCommand()) return;
		const otherUsers = [...this.client.components.modals.keys()].filter(id => id !== userId);
		const pendingOpener = this.dispatches.some(dispatch => !dispatch.started && !dispatch.isSettled);
		const hint =
			otherUsers.length > 0
				? `A modal IS waiting, but for a different user (${otherUsers.join(', ')}). Pass that same 'user' to fillModal.`
				: pendingOpener
					? 'The opener has not run yet — drive it in one call: `await bot.clickButton(...).fillModal(customId, fields)`.'
					: 'Dispatch the button/command that opens the modal first, e.g. `await bot.clickButton(...).fillModal(customId, fields)`.';
		throw new TypeError(
			`fillModal: no modal "${customId}" is waiting for user "${userId}" and no ModalCommand is registered. ${hint}`,
		);
	}

	/**
	 * Snapshot the modal definition seyfert just displayed to `userId` (custom_id + the set of input customIds),
	 * read from the most recent type-9 interaction callback. Lets {@link assertModalMatchesDisplayed} reject a
	 * fillModal aimed at the wrong customId or carrying field keys that no input on the modal accepts.
	 */
	private captureDisplayedModal(userId: string, dispatchId: number | undefined): void {
		for (let i = this.rest.actions.length - 1; i >= 0; i--) {
			const action = this.rest.actions[i];
			if (dispatchId !== undefined && action.dispatchId !== dispatchId) continue;
			if (!action.route.includes('/callback')) continue;
			const body = action.body as { type?: number; data?: Record<string, unknown> } | undefined;
			if (body?.type !== 9) continue;
			const data = body.data ?? {};
			const inputIds = new Set<string>();
			collectComponentCustomIds(data.components, inputIds);
			this.displayedModals.set(userId, { customId: data.custom_id as string | undefined, inputIds });
			return;
		}
	}

	/**
	 * Cross-check a fillModal against the modal that was actually displayed: the customId must match, and every
	 * field key must correspond to a real input on the modal. Skipped when no displayed modal was captured (e.g. a
	 * ModalCommand-only flow), so it never blocks the registry path that {@link assertModalHandleable} already guards.
	 */
	private assertModalMatchesDisplayed(customId: string, fields: Record<string, string>, userId: string): void {
		const displayed = this.displayedModals.get(userId);
		if (!displayed) return;
		if (displayed.customId !== undefined && displayed.customId !== customId) {
			throw new TypeError(
				`fillModal: the displayed modal's customId is "${displayed.customId}", not "${customId}". ` +
					`Pass the customId the command opened the modal with.`,
			);
		}
		const ghost = Object.keys(fields).filter(key => !displayed.inputIds.has(key));
		if (ghost.length > 0) {
			const known = [...displayed.inputIds].join(', ') || '(none)';
			throw new TypeError(
				`fillModal: field(s) ${ghost.map(key => `"${key}"`).join(', ')} are not inputs on the displayed modal. ` +
					`Known inputs: ${known}.`,
			);
		}
		this.displayedModals.delete(userId);
	}

	/** Read a `{ id, channel_id? }` message source out of a recorded REST response, or undefined if it has no id. */
	private messageSourceFrom(response: unknown): { id: string; channel_id?: string } | undefined {
		const record = response as { id?: unknown; channel_id?: unknown } | undefined;
		if (!record || typeof record.id !== 'string') return undefined;
		return {
			id: record.id,
			...(typeof record.channel_id === 'string' ? { channel_id: record.channel_id } : {}),
		};
	}

	lastSentMessage(): { id: string; channel_id?: string } | undefined {
		for (let i = this.rest.actions.length - 1; i >= 0; i--) {
			const action = this.rest.actions[i];
			const source = this.messageSourceFrom(action.response);
			if (source && /\/messages(\/|$)|\/webhooks\//.test(action.route)) return source;
		}
		return undefined;
	}

	/**
	 * Resolve which message a component dispatch (clickButton/selectMenu) acts on. With an explicit `source`
	 * (message id or a {@link RecordedAction}) that wins; otherwise resolution is intentionally GLOBAL — it
	 * falls back to the most recent sent / interaction-original message across ALL dispatches. That is the
	 * normal sequential collector flow: a button-click dispatch resolves the message a PRIOR dispatch wrote,
	 * so making it per-dispatch would break stepping a single user through a multi-dispatch flow.
	 *
	 * Under CONCURRENCY this source-less fallback is inherently ambiguous: with several dispatches in flight,
	 * "the most recent message" is a race. When dispatching concurrently, pass an explicit `source` to
	 * clickButton/selectMenu to disambiguate which message the component is on. (Gate scoping via
	 * {@link Dispatch.until} is per-dispatch; this message resolution is deliberately not.)
	 */
	private resolveMessageSource(source?: string | RecordedAction): { id: string; channel_id?: string } | undefined {
		if (typeof source === 'string') return { id: source };
		if (source) {
			const resolved = this.messageSourceFrom(source.response);
			if (resolved) return resolved;
			throw new TypeError(
				`component source: explicit RecordedAction ${source.method} ${source.route} has no message id in its response. ` +
					`Use the action that created/fetched the component message, or pass source: "message-id" explicitly.`,
			);
		}
		// Fall back to the most recent interaction-original message so a collector attached to an immediate
		// reply (which produces no channel-message REST action) still has a resolvable source.
		return this.lastSentMessage() ?? this.lastInteractionMessage;
	}

	private hydrateSourceMessage(
		source: { id: string; channel_id?: string },
		strict?: { verb: 'clickButton' | 'selectMenu'; customId: string },
	): ApiMessage {
		const stored = source.channel_id
			? this._state.rawMessage(source.channel_id, source.id)
			: this._state.rawMessageById(source.id);
		if (stored) return stored;
		if (strict) {
			throw new TypeError(
				`${strict.verb}: source message "${source.id}" was not found for customId "${strict.customId}". ` +
					`Send the message first or pass a RecordedAction whose response is the component message.`,
			);
		}
		return apiMessage({ id: source.id, channelId: source.channel_id });
	}

	private worldMemberFor(guildId: string | null | undefined, user: ApiUser | undefined): ApiMember | undefined {
		if (!this._world || !guildId || !user) return undefined;
		return this._world.members.find(entry => entry.guildId === guildId && entry.member.user.id === user.id)?.member;
	}

	private nowMs(): number {
		return this.timers ? this.virtualNowMs : Date.now();
	}

	private inferDrainDispatchId(scope?: Dispatch<unknown> | number): number | undefined {
		if (typeof scope === 'number') return scope;
		if (scope) return scope.dispatchId;
		const active = this.dispatches.filter(dispatch => dispatch.started && !dispatch.isCompleted);
		if (active.length > 1) {
			throw new TypeError(
				`advanceTime/flushPending: ${active.length} dispatches are currently running. ` +
					`Pass the dispatch to scope the drain, e.g. bot.advanceTime(ms, dispatch).`,
			);
		}
		return active[0]?.dispatchId;
	}

	private assertNoConcurrentImplicitComponentSource(
		verb: 'clickButton' | 'selectMenu',
		customId: string,
		sourceProvided: boolean,
	): void {
		if (sourceProvided) return;
		// One in-flight dispatch is unambiguous: "the most recent message" is that dispatch's reply, which is the
		// normal collector flow (a slash parked on waitFor, then a source-less click on its reply). Only 2+ racing
		// dispatches make the source-less fallback a genuine race.
		const inFlight = this.dispatches.filter(dispatch => dispatch.started && !dispatch.isCompleted);
		if (inFlight.length <= 1) return;
		throw new TypeError(
			`${verb}: source-less component dispatch for "${customId}" is ambiguous while ${inFlight.length} dispatches are still running. ` +
				`Pass source: "message-id" or a RecordedAction whose response is the component message.`,
		);
	}

	get actions(): readonly RecordedAction[] {
		return this.rest.actions;
	}

	/**
	 * Read-only list of the application commands registered on the client. Pure read of
	 * `client.commands.values`; no mutation or side effects.
	 */
	registeredCommands(): readonly RegisteredCommand[] {
		const typeName = (type: ApplicationCommandType): RegisteredCommand['type'] => {
			switch (type) {
				case ApplicationCommandType.User:
					return 'user';
				case ApplicationCommandType.Message:
					return 'message';
				case ApplicationCommandType.PrimaryEntryPoint:
					return 'entryPoint';
				default:
					return 'chatInput';
			}
		};
		return this.client.commands.values.map(command => ({
			name: command.name,
			type: typeName(command.type as ApplicationCommandType),
		}));
	}

	/**
	 * Read-only list of the registered component/modal handlers. Reuses the same enumeration as
	 * {@link describeUnmatchedComponent}; pure read of `client.components.commands`.
	 */
	registeredComponents(): readonly RegisteredComponent[] {
		return this.componentCommands().map(command => ({
			name: (command as { constructor: { name: string } }).constructor?.name ?? '(anonymous)',
			kind: command instanceof ModalCommand ? 'modal' : 'component',
		}));
	}

	/**
	 * Read-only list of the plugins loaded on the client, each paired with seyfert's resolved diagnostics
	 * (contribution counts and the client/context keys it added). Pure read of `client.plugins` — the
	 * {@link ResolvedPluginList} seyfert resolved at construction; no mutation or side effects. The list is the
	 * resolved order seyfert ran `setup` in, so a plugin appearing here means its `setup` was invoked. Returns an
	 * empty array when no plugins were passed.
	 */
	get plugins(): readonly PluginInfo[] {
		const resolved = this.client.plugins as ResolvedPluginList | undefined;
		if (!resolved) return [];
		const diagnostics = resolved.diagnostics ?? [];
		const diagnosticFor = (plugin: AnySeyfertPlugin): PluginDiagnostics | undefined =>
			diagnostics.find(
				entry => entry.name === plugin.name && (entry.instanceId ?? undefined) === (plugin.instanceId ?? undefined),
			);
		return resolved.map(plugin => {
			const diag = diagnosticFor(plugin);
			return {
				name: plugin.name,
				instanceId: plugin.instanceId,
				status: diag?.status,
				clientKeys: diag?.clientKeys ?? [],
				ctxKeys: diag?.ctxKeys ?? [],
				commands: diag?.commands ?? 0,
				components: diag?.components ?? 0,
				modals: diag?.modals ?? 0,
				events: diag?.events ?? [],
				middlewares: diag?.middlewares ?? [],
				shared: diag?.shared ?? [],
				plugin,
				diagnostics: diag,
			};
		});
	}

	/**
	 * Run plugin teardown explicitly. Seyfert's `Client.close()` IS the plugin lifecycle close — it waits for
	 * in-flight `setup` and runs each plugin's `teardown` (it does not touch the gateway, REST, or cache). This
	 * delegates to it and is idempotent: seyfert caches the close promise, so repeated calls (or a later
	 * {@link MockBot.close}) run teardown once. {@link MockBot.close} already calls this path, so explicit use is
	 * only needed to assert teardown without ending the mock session.
	 */
	async teardownPlugins(): Promise<void> {
		await this.client.close();
	}

	/**
	 * Plain-data snapshot for debugging a hung dispatch: dispatches that were created but never settled,
	 * plus the most recent recorded REST actions. Pure read; no mutation or side effects.
	 */
	diagnostics(recentLimit = 20): BotDiagnostics {
		const pending = this.dispatches
			.filter(dispatch => !dispatch.isSettled)
			.map(dispatch => ({ id: dispatch.userId, started: dispatch.started, settled: dispatch.isSettled }));
		const actions = this.rest.actions;
		const recentActions = recentLimit >= 0 ? actions.slice(Math.max(0, actions.length - recentLimit)) : [...actions];
		return { pending, recentActions };
	}

	waitForAction<TBody = Record<string, unknown>, TResponse = unknown>(
		matcherOrPredicate: RouteMatcher | ActionFilter | ActionPredicate,
		timeoutMs?: number,
	): Promise<TypedMatchedAction<TBody, TResponse>> {
		return this.rest.waitForAction<TBody, TResponse>(matcherOrPredicate as RouteMatcher, timeoutMs);
	}

	findActions<TBody = Record<string, unknown>, TResponse = unknown>(
		matcher: RouteMatcher | ActionPredicate,
		params?: Record<string, string>,
	): TypedMatchedAction<TBody, TResponse>[];
	findActions<TBody = Record<string, unknown>, TResponse = unknown>(
		matcher: RouteMatcher,
		filter: RouteActionFilter,
	): TypedMatchedAction<TBody, TResponse>[];
	findActions<TBody = Record<string, unknown>, TResponse = unknown>(
		matcher: ActionFilter | ActionPredicate,
	): TypedMatchedAction<TBody, TResponse>[];
	findActions<TBody = Record<string, unknown>, TResponse = unknown>(
		matcher: ActionMatcher,
		paramsOrFilter?: Record<string, string> | RouteActionFilter,
	): TypedMatchedAction<TBody, TResponse>[];
	findActions(matcher: ActionMatcher, paramsOrFilter?: Record<string, string> | RouteActionFilter): MatchedAction[] {
		return this.rest.findActions(matcher, paramsOrFilter);
	}

	findAction<TBody = Record<string, unknown>, TResponse = unknown>(
		matcher: RouteMatcher | ActionPredicate,
		params?: Record<string, string>,
	): TypedMatchedAction<TBody, TResponse> | undefined;
	findAction<TBody = Record<string, unknown>, TResponse = unknown>(
		matcher: RouteMatcher,
		filter: RouteActionFilter,
	): TypedMatchedAction<TBody, TResponse> | undefined;
	findAction<TBody = Record<string, unknown>, TResponse = unknown>(
		matcher: ActionFilter | ActionPredicate,
	): TypedMatchedAction<TBody, TResponse> | undefined;
	findAction<TBody = Record<string, unknown>, TResponse = unknown>(
		matcher: ActionMatcher,
		paramsOrFilter?: Record<string, string> | RouteActionFilter,
	): TypedMatchedAction<TBody, TResponse> | undefined;
	findAction(
		matcher: ActionMatcher,
		paramsOrFilter?: Record<string, string> | RouteActionFilter,
	): MatchedAction | undefined {
		return this.rest.findAction(matcher, paramsOrFilter);
	}

	/**
	 * Semantic query over recorded REST: the entity-create calls for a resource, optionally narrowed by a partial
	 * body match — so `bot.created('channel', { type: 2 })` reads instead of mapping `bot.actions` to
	 * `${method} ${route}` strings. Returns the matched {@link RecordedAction}s (read `.body` for the payload).
	 *
	 * `'message'` is a direct channel send, not an interaction reply (use `findAction(Routes.editOriginalResponse)`
	 * for those). See {@link CreatedResource} for the resource set.
	 */
	created<TBody = Record<string, unknown>>(
		resource: CreatedResource,
		match?: Record<string, unknown>,
	): TypedMatchedAction<TBody>[] {
		const route = CREATE_ROUTES[resource];
		return (
			match ? this.rest.findActions(route, { body: match }) : this.rest.findActions(route)
		) as TypedMatchedAction<TBody>[];
	}

	worldGuild(guildId: string): GuildView | undefined {
		return this._state.guild(guildId);
	}

	/**
	 * The current world member for a guild/user as a {@link GuildMemberView}, or undefined when absent (e.g.
	 * after a kick) or the guild is not in the world. Returns the SAME camelCase View that
	 * `worldGuild(guildId)?.member(userId)` returns, so switching between the two accessors reads identical
	 * field names (`communicationDisabledUntil`, not the raw `communication_disabled_until`).
	 */
	worldMember(guildId: string, userId: string): GuildMemberView | undefined {
		return this._state.guild(guildId)?.member(userId);
	}

	worldDm(userId: string): ChannelView | undefined {
		return this._state.dm(userId);
	}

	/** A channel view by id alone — the symmetric partner of `worldGuild(guildId)?.channel(id)`, no guildId needed. */
	worldChannel(channelId: string): ChannelView | undefined {
		return this._state.channelById(channelId);
	}

	/** A role view by id alone (carries permissions/color) — the partner of `worldGuild(guildId)?.role(id)`. */
	worldRole(roleId: string): RoleView | undefined {
		return this._state.roleById(roleId);
	}

	/** The view of a stored message by channel + id — collapses the worldGuild→channel→find chain. */
	worldMessage(channelId: string, messageId: string): MessageView | undefined {
		return this._state.messageView(channelId, messageId);
	}

	/** Seed a vote on a poll answer (poll voters are not part of the message body), then read it via getAnswerVoters. */
	seedPollVote(channelId: string, messageId: string, answerId: number, userId: string): void {
		this._state.addPollVoter(channelId, messageId, answerId, userId);
	}

	/** The seeded voice state for a guild/user, or undefined when the user is not in voice. */
	worldVoiceState(guildId: string, userId: string): ApiVoiceState | undefined {
		return this._state.voiceState(guildId, userId);
	}

	/**
	 * Read an app-specific value from the world's passthrough data store, seeded via `mockWorld().setData(key, value)`.
	 * The caller owns the type (`T`); the mock stores and returns the value verbatim,
	 * never interpreting it. Returns `undefined` when the key was never set.
	 */
	worldData<T = unknown>(key: string): T | undefined {
		return this._world?.data?.[key] as T | undefined;
	}

	/**
	 * Capture the current world as an immutable, plain-data snapshot: members, channels, messages, roles,
	 * bans, emojis, invites, automod rules, stickers, scheduled events, webhooks, and pins. Pair with
	 * {@link worldDiff} to assert state mutations declaratively. The snapshot is deeply frozen, so later
	 * dispatches never alter it.
	 */
	worldSnapshot(): WorldSnapshot {
		return this._state.snapshot();
	}

	/**
	 * Compare a prior {@link worldSnapshot} against the current world and return a structured changeset
	 * (added/removed/changed per entity type), so a test can assert e.g.
	 * `diff.members.changed[0].fields` contains `'roles'` instead of querying field by field.
	 */
	worldDiff(before: WorldSnapshot): WorldDiff {
		return this._state.diff(before);
	}

	/**
	 * @internal Resolve when a modal is registered for `userId` via seyfert's `components.modals.set` (which the
	 * opener command calls synchronously while replying). Used by {@link Dispatch.untilModal} to await
	 * registration event-driven instead of polling a wall clock. Resolves immediately if already registered.
	 */
	private onModalRegistered(userId: string, dispatchId: number | undefined): ModalWaitRegistration {
		const resolved = (): ModalWaitRegistration => ({ registered: Promise.resolve(), dispose: () => {} });
		const rejected = (error: unknown): ModalWaitRegistration => ({
			registered: Promise.reject(error),
			dispose: () => {},
		});
		if (dispatchId === undefined) {
			return rejected(new TypeError('untilModal: this dispatch has no dispatch id; cannot own a modal.'));
		}
		if (this.client.components.modals.has(userId)) {
			const owner = this.modalOwners.get(userId);
			if (owner === undefined || owner === dispatchId) return resolved();
			return rejected(
				new TypeError(
					`untilModal: user ${userId} already has a pending modal owned by dispatch ${owner}. ` +
						`Same-user modal flows must be driven sequentially.`,
				),
			);
		}
		const existing = this.modalWaiters.get(userId);
		const other = existing?.find(waiter => waiter.dispatchId !== dispatchId);
		if (other) {
			return rejected(
				new TypeError(
					`untilModal: dispatch ${other.dispatchId} is already waiting for user ${userId}'s next modal. ` +
						`Same-user modal flows must be driven sequentially.`,
				),
			);
		}
		let settled = false;
		let waiter!: ModalWaiter;
		const registered = new Promise<void>((resolve, reject) => {
			const waiters = this.modalWaiters.get(userId);
			waiter = {
				dispatchId,
				resolve: () => {
					settled = true;
					resolve();
				},
				reject: error => {
					settled = true;
					reject(error);
				},
			};
			if (waiters) waiters.push(waiter);
			else this.modalWaiters.set(userId, [waiter]);
		});
		return {
			registered,
			dispose: () => {
				if (settled) return;
				settled = true;
				const waiters = this.modalWaiters.get(userId);
				if (!waiters) return;
				const next = waiters.filter(entry => entry !== waiter);
				if (next.length) this.modalWaiters.set(userId, next);
				else this.modalWaiters.delete(userId);
			},
		};
	}

	/**
	 * Drain the mock's pending async — the setImmediate/microtask loop — so callbacks that fire after a timer
	 * advance (e.g. a collector onStop('idle') that dispatches through the mock) settle before assertions.
	 * Iteration-bounded so it terminates even when the user's fake timers froze Date.now()/setImmediate; the
	 * drain tick yields through the REAL setImmediate captured at module load, so faking globals cannot hang it.
	 */
	async flushPending(scope?: Dispatch<unknown> | number): Promise<void> {
		assertRealSetImmediate();
		await this.drainActions(this.inferDrainDispatchId(scope));
	}

	/**
	 * Drain ALL pending async across every dispatch until the REST surface quiesces — for the
	 * "handler responded, then kept doing background REST work (DB writes, follow-up Discord calls)" case where
	 * awaiting the dispatch resolves at the first response and the rest runs detached. Unlike {@link flushPending}
	 * it never throws on multiple in-flight dispatches; it is the unscoped "wait for everything to settle" drain.
	 *
	 * It can only observe work that eventually touches REST (or a tracked timer); a purely in-memory continuation
	 * that does no REST is invisible to any drain — there is no general signal for that.
	 */
	async settle(): Promise<void> {
		assertRealSetImmediate();
		await this.drainActions(undefined);
	}

	/**
	 * The single quiescence engine behind every drain: yield macrotasks until the relevant recorded-action count
	 * stops changing AND nothing is in flight, bounded by an iteration cap (not wall-clock, so it terminates under
	 * frozen fake timers). `count`/`hasPending` scope what "quiet" means; `aborted` stops early; `tickFirst` yields
	 * before the first measurement (the flushPending shape) vs after (the until-quiescent shape).
	 */
	private async drainWhile(
		count: () => number,
		hasPending: () => boolean,
		opts: { aborted?: () => boolean; maxIterations?: number; tickFirst?: boolean } = {},
	): Promise<void> {
		const { aborted, maxIterations = DRAIN_MAX_ITERATIONS, tickFirst = false } = opts;
		let lastCount = -1;
		let iterations = 0;
		while (!aborted?.()) {
			if (tickFirst) await drainTick();
			const current = count();
			if (current === lastCount && !hasPending()) return;
			lastCount = current;
			if (++iterations > maxIterations) return;
			if (!tickFirst) await drainTick();
		}
	}

	private async drainActions(dispatchId: number | undefined): Promise<void> {
		await this.drainWhile(
			() =>
				dispatchId === undefined
					? this.rest.actions.length
					: this.rest.actions.filter(action => action.dispatchId === dispatchId).length,
			() => this.rest.hasPendingRequests(dispatchId),
			{ tickFirst: true },
		);
	}

	/**
	 * Advance the test runner's fake timers by `ms`, then flush the mock's pending async so timer-driven
	 * callbacks (collector idle/timeout onStop, ctx.modal waitFor) and any mock dispatch they trigger settle
	 * before assertions. Delegates the actual clock advance to the runner-supplied `timers.advance` callback —
	 * the package source imports no vitest/jest. Throws clearly if no fake timers were configured.
	 */
	async advanceTime(ms: number, scope?: Dispatch<unknown> | number): Promise<void> {
		if (!this.timers) {
			throw new Error(
				"advanceTime: no fake timers configured. Call vi.useFakeTimers() (or your runner's equivalent) " +
					'and pass timers:{ advance: ms => vi.advanceTimersByTime(ms) } to createMockBot.',
			);
		}
		assertRealSetImmediate();
		const dispatchId = this.inferDrainDispatchId(scope);
		await this.timers.advance(ms);
		this.virtualNowMs += ms;
		await this.flushPending(dispatchId);
	}

	dispatchInteraction(payload: ApiInteractionPayload): Dispatch<DispatchResult> {
		this.assertOpen('dispatchInteraction');
		const user = payload.member?.user ?? payload.user;
		const userId = user?.id;
		const dispatchId = nextDispatchId();
		return this.track(
			new Dispatch(
				this.rest,
				this.client,
				userId,
				() => this.runInteraction(payload, dispatchId),
				(id, ownerDispatchId) => this.onModalRegistered(id, ownerDispatchId),
				dispatchId,
				user ? (customId, fields) => this.fillModal(customId, fields, { user }) : undefined,
				id => this.modalOwners.delete(id),
				(customId, scopeId, execution, timeoutMs) =>
					this.awaitRenderedComponent(customId, scopeId, execution, timeoutMs),
			),
		);
	}

	private async awaitRenderedComponent(
		customId: string,
		dispatchId: number | undefined,
		execution: Promise<unknown>,
		timeoutMs = 5000,
	): Promise<RecordedAction> {
		const matches = (candidate: RecordedAction): boolean =>
			(dispatchId === undefined || candidate.dispatchId === dispatchId) && actionRendersComponent(candidate, customId);

		let action = this.rest.actions.find(matches);
		if (!action) {
			// Event-driven, NOT REST-quiescence: the render can land after a non-REST gap (a DB query between
			// deferReply and the reply), so we wait for the action itself — but bail fast if the handler finishes
			// without ever rendering, rather than waiting out the timeout.
			const rendered = this.rest.waitForAction(matches, timeoutMs);
			rendered.catch(() => {}); // if the completion branch wins the race, don't leave this unhandled
			const COMPLETED = Symbol('completed');
			const outcome = await Promise.race([
				rendered,
				execution.then(
					() => COMPLETED,
					() => COMPLETED,
				),
			]);
			action = outcome === COMPLETED ? this.rest.actions.find(matches) : (outcome as RecordedAction);
		}
		if (!action) {
			const rendered = renderedReply(this.rest.actions, dispatchId);
			const parts: string[] = [];
			if (rendered.content) parts.push(`content ${JSON.stringify(rendered.content)}`);
			for (const embed of rendered.embeds) {
				parts.push(`embed ${JSON.stringify(embed.title ?? embed.description ?? '(no title)')}`);
			}
			const ids = rendered.components.map(component => component.customId).filter(Boolean);
			if (ids.length > 0) parts.push(`components [${ids.join(', ')}]`);
			const summary = parts.length > 0 ? parts.join(', ') : 'nothing';
			throw new Error(
				`untilComponent: this dispatch settled without rendering a component "${customId}" — it rendered ${summary} instead. ` +
					`The handler must reply with the component (e.g. editOrReply({ components: [...] }, true)) before a collector can drive it.`,
			);
		}
		// Let the handler's continuation run up to the collector park, so a click right after this resolves.
		await this.flushPending(dispatchId);
		return action;
	}

	private prepareGatewayEventPayload(name: string, d: Record<string, unknown>): Record<string, unknown> {
		if (name === 'GUILD_MEMBER_UPDATE') {
			const user = d.user as { id?: unknown } | undefined;
			if (typeof d.guild_id !== 'string' || typeof user?.id !== 'string') {
				throw new TypeError('emit GUILD_MEMBER_UPDATE requires guild_id and user.id before world/cache mutation.');
			}
		}
		if (name === 'THREAD_CREATE' && typeof d.guild_id !== 'string') {
			throw new TypeError('emit THREAD_CREATE requires guild_id; Seyfert cache ignores guildless threads.');
		}
		if (name === 'CHANNEL_CREATE' && d.type !== 1 && typeof d.guild_id !== 'string') {
			throw new TypeError('emit CHANNEL_CREATE requires guild_id for non-DM channels; Seyfert cache ignores it.');
		}
		if (name === 'MESSAGE_CREATE') {
			const author = d.author as { id?: unknown } | undefined;
			if (typeof d.channel_id !== 'string' || typeof d.id !== 'string' || typeof author?.id !== 'string') {
				throw new TypeError('emit MESSAGE_CREATE requires id, channel_id, and author.id before world/cache mutation.');
			}
		}
		return d;
	}

	private materializeInteractionResponse(payload: ApiInteractionPayload, body: APIInteractionResponse): void {
		if (body.type === 4) {
			// The callback interceptor already materialized the original; point lastInteractionMessage at it
			// so a collector created on the immediate reply (with no explicit source) resolves to the same id.
			const original = this._state.messageForToken(payload.token);
			const id = typeof original?.id === 'string' ? original.id : undefined;
			if (id) this.lastInteractionMessage = { id, channel_id: payload.channel_id };
			return;
		}
		if (body.type === 6 && payload.message) {
			// DeferredMessageUpdate: @original IS the source message (already pointed there synchronously by the
			// callback interceptor); just track it as the latest interaction message for collector resolution.
			this.lastInteractionMessage = { id: payload.message.id, channel_id: payload.message.channel_id };
			return;
		}
		if (body.type === 7 && payload.message) {
			// UpdateMessage: the content edit was applied synchronously by the callback interceptor (so it lands
			// before any later editResponse in the same handler); here we only track the pointer for collectors.
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
		if (first?.type === CommandOptionType.SubcommandGroup) {
			group = first.name;
			const nested = first.options?.[0];
			if (nested?.type === CommandOptionType.Subcommand) subcommand = nested.name;
		} else if (first?.type === CommandOptionType.Subcommand) {
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
		maxIterations = DRAIN_MAX_ITERATIONS,
	): Promise<void> {
		// Same guard as advanceTime/flushPending: if the user faked global setImmediate, this drain (reached via
		// the middleware denial path too) would spin silently to the cap. Fail loud with the fix instead.
		assertRealSetImmediate();
		await this.drainWhile(
			() => this.rest.actions.filter(action => action.dispatchId === dispatchId).length,
			() => this.rest.hasPendingRequests(dispatchId),
			{ aborted, maxIterations },
		);
	}

	private async drainTokenUntilQuiescent(
		applicationId: string,
		token: string,
		interactionId?: string,
		maxIterations = DRAIN_MAX_ITERATIONS,
	): Promise<void> {
		assertRealSetImmediate();
		await this.drainWhile(
			() =>
				this.rest.actions.filter(
					action =>
						this.isInteractionWebhookActionFor(action, applicationId, token) ||
						this.isInteractionCallbackActionFor(action, token, interactionId),
				).length,
			() => this.rest.hasPendingRequests(),
			{ maxIterations },
		);
	}

	/**
	 * Install the component/middleware wrappers ONCE on the shared client singletons. Delegates to the free
	 * function in ./hooks and stores the detected capabilities it returns.
	 *
	 * @internal Called once by createMockBot after setup; not part of the public surface.
	 */
	installDispatchHooks(): void {
		const capabilities = installDispatchHooksImpl(this.client, {
			modalWaiters: this.modalWaiters,
			modalOwners: this.modalOwners,
			drainUntilQuiescent: (dispatchId, aborted) => this.drainUntilQuiescent(dispatchId, aborted),
			onModalDisplayed: (userId, dispatchId) => this.captureDisplayedModal(userId, dispatchId),
		});
		this.canDetectComponentCommand = capabilities.canDetectComponentCommand;
		this.canDetectCollector = capabilities.canDetectCollector;
		this.canDetectModalCollector = capabilities.canDetectModalCollector;
	}

	private isInteractionWebhookActionFor(action: RecordedAction, applicationId: string, token: string): boolean {
		for (const route of INTERACTION_WEBHOOK_ROUTES) {
			const params = this.rest.matchRouteParams(route, action) as
				| { applicationId: string; interactionToken: string }
				| undefined;
			if (!params) continue;
			if (params.applicationId !== applicationId) continue;
			if (params.interactionToken !== token) continue;
			return true;
		}
		return false;
	}

	private isInteractionCallbackActionFor(action: RecordedAction, token: string, interactionId?: string): boolean {
		const params = this.rest.matchRouteParams(Routes.interactionCallback, action);
		if (!params) return false;
		if (params.token !== token) return false;
		return interactionId === undefined || params.id === interactionId;
	}

	private isInteractionAction(action: RecordedAction, payload: ApiInteractionPayload): boolean {
		return (
			this.isInteractionWebhookActionFor(action, payload.application_id, payload.token) ||
			this.isInteractionCallbackActionFor(action, payload.token, payload.id)
		);
	}

	private async runInteraction(payload: ApiInteractionPayload, dispatchId: number): Promise<DispatchResult> {
		const replies: CapturedReply[] = [];
		const isComponentPayload = payload.type === InteractionType.MessageComponent;
		const isModalPayload = payload.type === InteractionType.ModalSubmit;
		const user = payload.member?.user ?? payload.user;
		const userId = user?.id;
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
		this._state.registerInteractionToken(payload.token, payload.channel_id, payload.type, payload.application_id);
		if (payload.message) {
			this._state.registerComponentSource(payload.token, payload.message.channel_id, payload.message.id);
		}
		// The builders preserve Discord's payload shape while exposing a wider test input type.
		try {
			await dispatchStore.run(ctx, async () => {
				await Promise.race([
					// No __reply callback: seyfert takes its gateway reply branch and posts the interaction callback
					// through the mock REST (intercepted in defaults), so it returns a real message for with_response
					// exactly like a gateway bot. Replies are captured from that recorded callback action below.
					this.client.handleCommand.interaction(payload as unknown as APIInteraction, -1),
					denialSettled,
				]);
			});
		} finally {
			if (isModalPayload && userId) {
				modalRegistry(this.client).delete(userId);
				this.modalOwners.delete(userId);
			}
		}
		if (isModalPayload) await this.drainTokenUntilQuiescent(payload.application_id, payload.token, payload.id);
		const { componentCommandExecuted, collectorMatched, modalMatched } = ctx;
		// An unhandled error inside the command/component/modal run was captured by the onRunError hook. Fail loud
		// by default so a happy-path test surfaces the bug; 'capture' exposes it on result.error instead.
		if (ctx.error !== undefined && !ctx.errorHandled && this.onCommandError === 'throw') throw ctx.error;
		if (
			isComponentPayload &&
			this.canDetectCollector &&
			this.canDetectComponentCommand &&
			!collectorMatched &&
			!componentCommandExecuted
		) {
			const customId = payload.data.custom_id ?? '(unknown)';
			throw new TypeError(`clickButton/selectMenu: ${this.describeUnmatchedComponent('component', customId)}`);
		}
		if (
			isModalPayload &&
			this.canDetectModalCollector &&
			this.canDetectComponentCommand &&
			!modalMatched &&
			!componentCommandExecuted
		) {
			const customId = payload.data.custom_id ?? '(unknown)';
			throw new TypeError(`fillModal: ${this.describeUnmatchedComponent('modal', customId)}`);
		}
		// This dispatch owns the actions it stamped, plus any interaction-token-routed action (callback, followups,
		// original-response edits) for THIS interaction's token. The latter may be emitted from a different async
		// frame — e.g. a modal submit whose reply is written inside the opener command's resumed continuation — so
		// the token, which is unique per interaction, is the reliable owner key for those responses.
		const actions = this.rest.actions.filter(
			action => action.dispatchId === dispatchId || this.isInteractionAction(action, payload),
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
		const toOutgoingMessage = (action: RecordedAction): OutgoingMessage => this.outgoingMessagePart(action).body;
		const normalizeFiles = (files: unknown): unknown[] | undefined => {
			if (files === undefined) return undefined;
			return Array.isArray(files) ? files : [files];
		};
		const replyToMessagePart = (reply: CapturedReply): MessagePart | undefined => {
			const body = reply.body;
			if (
				body.type !== InteractionResponseType.ChannelMessageWithSource &&
				body.type !== InteractionResponseType.UpdateMessage
			) {
				return undefined;
			}
			const data = 'data' in body ? ((body.data ?? {}) as OutgoingMessage) : {};
			return {
				body: {
					...data,
					...(reply.files ? { files: normalizeFiles(reply.files) } : {}),
				},
				source:
					body.type === InteractionResponseType.UpdateMessage
						? this.messageSourceFrom(payload.message)
						: this.messageSourceFrom(this._state.messageForToken(payload.token)),
			};
		};
		const matchesPayloadWebhookRoute = (route: (typeof INTERACTION_WEBHOOK_ROUTES)[number], action: RecordedAction) => {
			const params = this.rest.matchRouteParams(route, action) as
				| { applicationId: string; interactionToken: string }
				| undefined;
			return params?.applicationId === payload.application_id && params.interactionToken === payload.token;
		};
		const isWebhookMessageEdit = (action: RecordedAction) =>
			action.method === 'PATCH' &&
			WEBHOOK_MESSAGE_ROUTE.test(action.route) &&
			(matchesPayloadWebhookRoute(Routes.editOriginalResponse, action) ||
				matchesPayloadWebhookRoute(Routes.editWebhookMessage, action));
		const isFollowup = (action: RecordedAction) =>
			action.method === 'POST' &&
			FOLLOWUP_ROUTE.test(action.route) &&
			matchesPayloadWebhookRoute(Routes.followup, action);
		const editActions = actions.filter(isWebhookMessageEdit);
		const followupActions = actions.filter(isFollowup);
		const messageActions = actions.filter(action => isWebhookMessageEdit(action) || isFollowup(action));
		const edits = editActions.map(toOutgoingMessage);
		const followups = followupActions.map(toOutgoingMessage);
		const parts = [
			...replies.map(replyToMessagePart).filter((part): part is MessagePart => part !== undefined),
			...messageActions.map(action => this.outgoingMessagePart(action)),
		];
		const messageResult = this.messageParts(actions, parts);
		const command = this.commandLeaf(payload);
		const target = this.commandTarget(payload);
		const denial = ctx.denial;

		return {
			...messageResult,
			replies,
			edits,
			followups,
			command,
			target,
			denied: denial !== undefined,
			denial,
			...(ctx.error === undefined ? {} : { error: ctx.error }),
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
				// The IMMEDIATE response only (replies[0]) — per the documented contract. A public initial reply with
				// an ephemeral FOLLOWUP is not "ephemeral"; folding followups/edits in here misreported that.
				const first = replies[0];
				const data = first && 'data' in first.body ? (first.body.data as { flags?: number } | undefined) : undefined;
				return isEphemeral(data ?? {});
			},
			get embed() {
				return messageResult.embed;
			},
			get embedView() {
				return messageResult.embedView;
			},
			get modal() {
				const body = replies[0]?.body;
				if (body?.type !== 9) return undefined;
				const data = body.data as { custom_id?: string; title?: string } | undefined;
				return { customId: data?.custom_id, title: data?.title };
			},
			get content() {
				return [...messageResult.messages].reverse().find(message => typeof message.content === 'string')?.content;
			},
		};
	}

	private assertCommandRegistered(name: string, type: ApplicationCommandType, verb: string): void {
		const registered = this.client.commands.values
			.filter(command => command.type === type)
			.map(command => command.name);
		if (!registered.includes(name)) {
			const typeName = ApplicationCommandType[type] ?? String(type);
			const otherType = this.client.commands.values.find(command => command.name === name && command.type !== type);
			const hint = otherType
				? ` (it IS registered as ${ApplicationCommandType[otherType.type] ?? otherType.type} — use the matching verb)`
				: '';
			throw new TypeError(
				`${verb}: command "${name}" is not registered as ${typeName}${hint}. ` +
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
		const prepared = this.applyWorldPermissions({
			applicationId: this.client.applicationId,
			...options,
			// Resolve the invoking user with explicit `user` > `userId` shorthand > default (computed AFTER the
			// spread so it isn't clobbered by the default-user injection).
			user: options.user ?? (options.userId !== undefined ? apiUser({ id: options.userId }) : this.defaultUser),
		});
		return this.dispatchInteraction(build(prepared)) as Dispatch<R>;
	}

	/**
	 * Dispatch a chat-input command by its class, inferring the option-value bag from the command's declared
	 * options — both the `options` you pass here AND the author's `ctx.options` are typed, no cast. The shape is
	 * read from the `run(ctx: CommandContext<typeof options>)` annotation the author already writes (the standard
	 * seyfert idiom); see {@link SlashOptionsOf}. The command's `name` comes from the class, so it is omitted here.
	 *
	 * Without a typed `run` the option bag degrades to an empty record (graceful, no compile error), mirroring the
	 * `menu(Class)` precedent. Pass `{ name, ... }` for concise raw name-based dispatch.
	 */
	slash<C extends SlashCommandClass>(command: C, options?: SlashClassOptions<C>): Dispatch<DispatchResult>;
	slash(options: ChatInputInteractionOptions): Dispatch<DispatchResult>;
	slash<C extends SlashCommandClass>(
		commandOrOptions: C | ChatInputInteractionOptions,
		classOptions?: SlashClassOptions<C>,
	): Dispatch<DispatchResult> {
		const options: ChatInputInteractionOptions =
			typeof commandOrOptions === 'function'
				? ({ ...(classOptions ?? {}), name: new commandOrOptions().name } as ChatInputInteractionOptions)
				: commandOrOptions;
		return this.dispatchSlash(options);
	}

	private dispatchSlash(options: ChatInputInteractionOptions): Dispatch<DispatchResult> {
		this.assertCommandRegistered(options.name, ApplicationCommandType.ChatInput, 'slash');
		return this.dispatchVia(
			'slash',
			prepareChatInputOptions(this.client.commands.values, options, this.validateOptions),
			chatInputInteraction,
		);
	}

	autocomplete(options: AutocompleteInteractionOptions): Dispatch<AutocompleteResult> {
		this.assertOpen('autocomplete');
		this.assertCommandRegistered(options.name, ApplicationCommandType.ChatInput, 'autocomplete');
		const prepared = prepareAutocompleteOptions(this.client.commands.values, options, this.validateOptions);
		const payload = autocompleteInteraction(
			this.applyWorldPermissions({
				user: this.defaultUser,
				applicationId: this.client.applicationId,
				...prepared,
			}),
		);
		const userId = payload.member?.user.id ?? payload.user?.id;
		const dispatchId = nextDispatchId();
		return this.track(
			new Dispatch(
				this.rest,
				this.client,
				userId,
				async () => {
					const result = await this.runInteraction(payload, dispatchId);
					const body = result.reply?.body;
					return { ...result, choices: body?.type === 8 ? body.data?.choices : undefined };
				},
				(id, ownerDispatchId) => this.onModalRegistered(id, ownerDispatchId),
				dispatchId,
			),
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

	/**
	 * Dispatch a context-menu command by its class, inferring the target kind and result type from the class.
	 *
	 * For the strict, checked typing — `target` constrained to exactly `ApiUser`/`ApiMessage` and a non-optional
	 * `result.target` (`UserMenuResult`/`MessageMenuResult`) — the command must declare its type as a literal:
	 *
	 * ```ts
	 * class ReportUser extends ContextMenuCommand {
	 *   type = ApplicationCommandType.User as const; // ← the `as const` enables narrowing
	 *   name = 'Report User';
	 * }
	 * ```
	 *
	 * Without `as const`, `type` widens to `ApplicationCommandType` and the inference degrades **gracefully**:
	 * `target` accepts `ApiUser | ApiMessage` and the result is the base {@link DispatchResult} (so `result.target`
	 * is optional). The dispatch still runs correctly; you only lose the narrowed compile-time target. See
	 * {@link TargetFor} and {@link MenuResultFor}.
	 */
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
		options: Omit<ButtonInteractionOptions, 'customId' | 'message'> & ComponentSourceOptions = {},
	): Dispatch<DispatchResult> {
		const { source, allowSyntheticSource, ...rest } = options;
		const opts: ButtonInteractionOptions = { ...rest, customId };
		return this.dispatchVia('clickButton', opts, prepared => {
			const message = this.resolveMessageSource(source);
			this.assertNoConcurrentImplicitComponentSource('clickButton', customId, source !== undefined);
			// Auto-synthesize when no source resolves but a registered ComponentCommand matches this customId —
			// unambiguous (no message ⇒ no live collector), so no `allowSyntheticSource` flag needed.
			const synthetic = allowSyntheticSource || (!message && this.componentCommandMatches(customId));
			if (!message && !synthetic) {
				throw new TypeError(
					`clickButton: no source message resolved for "${customId}". Send the message first, pass source, ` +
						`or set allowSyntheticSource: true for a ComponentCommand-only dispatch.`,
				);
			}
			if (synthetic && !message) this.assertSyntheticComponentAllowed('clickButton', customId);
			const hydrated = message?.id ? this.hydrateSourceMessage(message, { verb: 'clickButton', customId }) : undefined;
			let messageForInteraction: ApiMessage | undefined;
			if (hydrated) {
				this.requireComponentOnMessage('clickButton', customId, hydrated);
				messageForInteraction = hydrated;
			}
			if (!messageForInteraction && synthetic) this.assertSyntheticComponentAllowed('clickButton', customId);
			const guildId = prepared.guildId === undefined ? hydrated?.guild_id : prepared.guildId;
			return buttonInteraction({
				...prepared,
				...(guildId !== undefined ? { guildId } : {}),
				...(messageForInteraction ? { message: messageForInteraction } : {}),
			});
		});
	}

	selectMenu(
		customId: string,
		values: string[],
		options: Omit<SelectMenuInteractionOptions, 'customId' | 'values' | 'message'> & ComponentSourceOptions = {},
	): Dispatch<DispatchResult> {
		const { source, allowSyntheticSource, ...rest } = options;
		const opts: SelectMenuInteractionOptions = { ...rest, customId, values };
		return this.dispatchVia('selectMenu', opts, prepared => {
			const message = this.resolveMessageSource(source);
			this.assertNoConcurrentImplicitComponentSource('selectMenu', customId, source !== undefined);
			const synthetic = allowSyntheticSource || (!message && this.componentCommandMatches(customId));
			if (!message && !synthetic) {
				throw new TypeError(
					`selectMenu: no source message resolved for "${customId}". Send the message first, pass source, ` +
						`or set allowSyntheticSource: true for a ComponentCommand-only dispatch.`,
				);
			}
			if (synthetic && !message) this.assertSyntheticComponentAllowed('selectMenu', customId);
			const hydrated = message?.id ? this.hydrateSourceMessage(message, { verb: 'selectMenu', customId }) : undefined;
			const sourceComponent = hydrated ? this.requireComponentOnMessage('selectMenu', customId, hydrated) : undefined;
			if (!sourceComponent && synthetic) this.assertSyntheticComponentAllowed('selectMenu', customId);
			if (sourceComponent) this.assertSelectValuesMatchSource(customId, values, sourceComponent);
			const sourceType = selectTypeForInteraction(numberValue(sourceComponent?.type));
			const preparedWithSourceType = sourceType ? { ...prepared, componentType: sourceType } : prepared;
			const resolved = resolveSelectResolved(this._world, customId, values, preparedWithSourceType);
			const guildId =
				preparedWithSourceType.guildId === undefined ? hydrated?.guild_id : preparedWithSourceType.guildId;
			return selectMenuInteraction({
				...preparedWithSourceType,
				...(guildId !== undefined ? { guildId } : {}),
				...(resolved ? { resolved } : {}),
				...(sourceComponent && hydrated ? { message: hydrated } : {}),
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
			const userId = prepared.user?.id ?? this.defaultUser.id;
			this.assertModalHandleable(customId, userId);
			this.assertModalMatchesDisplayed(customId, fields, userId);
			return modalSubmitInteraction(prepared);
		});
	}

	say(content: string, options: DispatchMessageOptions = {}): Dispatch<SayResult> {
		this.assertOpen('say');
		const author = options.user ?? this.defaultUser;
		const dm = options.guildId === null;
		const guildId = dm ? undefined : (options.guildId ?? options.channel?.guild_id ?? TEST_GUILD_ID);
		const member = apiMember({ user: author, ...(options.member ? memberOptionsFrom(options.member) : {}) });
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
			new Dispatch(
				this.rest,
				this.client,
				author.id,
				async () => {
					await dispatchStore.run(
						{ dispatchId, componentCommandExecuted: false, collectorMatched: false, modalMatched: false },
						() => this.client.handleCommand.message(raw as Parameters<HandleCommand['message']>[0], -1),
					);
					const actions = this.rest.actions.filter(action => action.dispatchId === dispatchId);
					const parts = actions.filter(isOutgoingMessagePost).map(action => this.outgoingMessagePart(action));
					return this.messageParts(actions, parts);
				},
				(id, ownerDispatchId) => this.onModalRegistered(id, ownerDispatchId),
				dispatchId,
			),
		);
	}

	actor(options: ActorOptions): Actor {
		const entry = options.member
			? this._world?.members.find(candidate => candidate.member.user.id === options.member?.user.id)
			: undefined;
		const user = options.user ?? options.member?.user;
		const guildId = options.guildId ?? entry?.guildId ?? options.channel?.guild_id ?? TEST_GUILD_ID;
		const channel =
			options.channel ??
			(entry ? this._world?.channels.find(candidate => candidate.guild_id === entry.guildId) : undefined);
		const base = { user, guildId, channel };
		const mergeEventPayload = (payload: object | readonly unknown[] = {}): object | readonly unknown[] => {
			if (Array.isArray(payload)) return payload;
			return {
				...(guildId ? { guild_id: guildId } : {}),
				...(user ? { user } : {}),
				...(payload as Record<string, unknown>),
			};
		};

		return {
			slash: (
				commandOrOptions: SlashCommandClass | ChatInputInteractionOptions,
				classOptions?: SlashClassOptions<SlashCommandClass>,
			) =>
				typeof commandOrOptions === 'function'
					? this.slash(commandOrOptions, { ...base, ...classOptions })
					: this.slash({ ...base, ...commandOrOptions }),
			autocomplete: options => this.autocomplete({ ...base, ...options }),
			userMenu: options => this.userMenu({ ...base, ...options }),
			messageMenu: options => this.messageMenu({ ...base, ...options }),
			menu: (command, options) => this.menu(command, { ...base, ...options } as MenuOptions<typeof command>),
			entryPoint: options => this.entryPoint({ ...base, ...options }),
			fillModal: (customId, fields, options = {}) => this.fillModal(customId, fields, { ...base, ...options }),
			clickButton: (customId, options = {}) => this.clickButton(customId, { ...base, ...options }),
			selectMenu: (customId, values, options = {}) => this.selectMenu(customId, values, { ...base, ...options }),
			say: (content, options = {}) => this.say(content, { ...base, ...options }),
			emit: (name: string, payload: object | readonly unknown[] = {}, options?: EmitEventOptions) =>
				this.emit(name, mergeEventPayload(payload), options),
		};
	}

	emit<TName extends GatewayDispatchPayload['t']>(
		name: TName,
		payload?: Partial<Extract<GatewayDispatchPayload, { t: TName }>['d']>,
		options?: EmitEventOptions,
	): Dispatch<EventDispatchResult>;
	emit(name: string, payload?: object | readonly unknown[], options?: EmitEventOptions): Dispatch<EventDispatchResult>;
	emit(
		name: string,
		payload: object | readonly unknown[] = {},
		options: EmitEventOptions = {},
	): Dispatch<EventDispatchResult> {
		const gatewayName = normalizeGatewayEventName(name);
		if (gatewayName) {
			if (Array.isArray(payload)) {
				throw new TypeError('emit: gateway events require an object payload, not positional arguments.');
			}
			return this.emitGatewayEvent(gatewayName as GatewayDispatchPayload['t'], payload, options);
		}
		return this.emitCustom(name, payload, options);
	}

	private emitGatewayEvent(
		name: GatewayDispatchPayload['t'],
		payload: object,
		{ updateCache = true, allowNoHandler = false }: EmitEventOptions,
	): Dispatch<EventDispatchResult> {
		this.assertOpen('emit');
		const d = payload as Record<string, unknown>;
		const dispatchId = nextDispatchId();
		return this.track(
			new Dispatch<EventDispatchResult>(
				this.rest,
				this.client,
				undefined,
				async () => {
					// Guard BEFORE mutating the world, so a rejected emit is a true no-op (no dirtied world state,
					// and seyfert's cache — updated later inside runEvent — stays consistent with the world).
					const prepared = this.prepareGatewayEventPayload(name, d);
					const handlerRan = this.eventHandlerRan(name);
					if (!handlerRan && !allowNoHandler) {
						throw new Error(
							`emit: no handler ran for "${name}". Register an Event via events:[...], or pass ` +
								`{ allowNoHandler: true } if you are emitting only to seed world state. ` +
								`Registered events: ${this.registeredEvents().join(', ') || '(none)'}.`,
						);
					}
					// allowNoHandler is for seeding world state via the bridge; a name that is neither handled nor a
					// bridged world event does literally nothing — almost always a mis-cased/typo'd gateway name.
					if (!handlerRan && allowNoHandler && !WORLD_EVENT_NAMES.includes(name)) {
						throw new Error(
							`emit: "${name}" had no effect — no handler ran and it is not a world-bridge event. ` +
								`Check the gateway name is UPPER_SNAKE_CASE (e.g. 'GUILD_MEMBER_ADD'). ` +
								`Bridged events: ${[...WORLD_EVENT_NAMES].join(', ')}.`,
						);
					}
					if (updateCache) this.applyWorldEvent(name, prepared);
					const ctx: DispatchContext = {
						dispatchId,
						componentCommandExecuted: false,
						collectorMatched: false,
						modalMatched: false,
					};
					await dispatchStore.run(ctx, () =>
						this.client.events.runEvent(
							name as Parameters<Client['events']['runEvent']>[0],
							this.client,
							prepared,
							-1,
							updateCache,
						),
					);
					if (ctx.error !== undefined && this.onCommandError === 'throw') throw ctx.error;
					const actions = this.rest.actions.filter(action => action.dispatchId === dispatchId);
					const parts = actions.filter(isOutgoingMessagePost).map(action => this.outgoingMessagePart(action));
					const result = this.messageParts(actions, parts);
					return ctx.error === undefined ? result : { ...result, error: ctx.error };
				},
				undefined,
				dispatchId,
			),
		);
	}

	private emitCustom(
		name: string,
		payload: object | readonly unknown[] = {},
		{ allowNoHandler = false }: EmitEventOptions = {},
	): Dispatch<EventDispatchResult> {
		this.assertOpen('emit');
		const dispatchId = nextDispatchId();
		return this.track(
			new Dispatch<EventDispatchResult>(
				this.rest,
				this.client,
				undefined,
				async () => {
					const handlerRan = this.eventHandlerRan(name);
					if (!handlerRan && !allowNoHandler) {
						throw new Error(
							`emit: no custom handler ran for "${name}". Register a custom Event or plugin listener, ` +
								`or pass { allowNoHandler: true } if no-op emission is intentional. ` +
								`Registered events: ${this.registeredEvents().join(', ') || '(none)'}.`,
						);
					}
					const ctx: DispatchContext = {
						dispatchId,
						componentCommandExecuted: false,
						collectorMatched: false,
						modalMatched: false,
					};
					const args = Array.isArray(payload) ? [...payload] : [payload];
					const events = this.client.events as typeof this.client.events & {
						runCustom(name: string, ...args: unknown[]): Promise<void>;
					};
					await dispatchStore.run(ctx, () => events.runCustom(name, ...args));
					if (ctx.error !== undefined && this.onCommandError === 'throw') throw ctx.error;
					const actions = this.rest.actions.filter(action => action.dispatchId === dispatchId);
					const parts = actions.filter(isOutgoingMessagePost).map(action => this.outgoingMessagePart(action));
					const result = this.messageParts(actions, parts);
					return ctx.error === undefined ? result : { ...result, error: ctx.error };
				},
				undefined,
				dispatchId,
			),
		);
	}

	private applyWorldEvent(name: string, d: Record<string, unknown>): void {
		applyWorldEvent(this._state, name, d);
	}

	/**
	 * The gateway event names with a registered handler (`Event` from `events:[...]`), keyed UPPER_SNAKE_CASE the
	 * way the gateway delivers them. Use it to assert wiring, or to debug an `emit` that found no handler.
	 */
	registeredEvents(): string[] {
		const names = new Set(Object.keys(eventsInternals(this.client).values));
		for (const name of pluginEventNames(this.client)) names.add(name);
		return [...names];
	}

	/** Whether emitting `name` now would reach a handler: a live (not once-fired) Event, or a plugin listener. */
	private eventHandlerRan(name: string): boolean {
		const events = eventsInternals(this.client);
		const event = events.values[name];
		if (event && !(event.data.once && event.fired)) return true;
		return events.getPluginListeners(name).length > 0 || events.getPluginAnyListeners().length > 0;
	}

	/**
	 * Clear recorded REST traffic and transient per-dispatch handler state between phases of a test.
	 *
	 * Clears: recorded actions, pending/in-flight REST, custom interceptors, the dispatch list, the client-side
	 * modal/collector runtime registries (so a stale modal/collector can't match a later dispatch), the modal
	 * waiters, and the last-interaction message pointer (so a source-less `clickButton` after reset doesn't
	 * resolve to a pre-reset message).
	 *
	 * Does NOT clear: the seeded WORLD (guilds/channels/messages/members and the bans/reactions/voice/pin state),
	 * the registered commands/components/events, or seyfert's cache. `reset()` is "new REST traffic, same bot and
	 * world" — for a truly clean slate (fresh world + cache), create a new bot with `createMockBot(...)`.
	 */
	reset(): void {
		this.assertOpen('reset');
		this.rest.clearActions();
		this.rest.releasePending();
		this.rest.resetInterceptors();
		this.dispatches.length = 0;
		this.client.components.modals.clear();
		this.client.components.values.clear();
		this.modalWaiters.clear();
		this.modalOwners.clear();
		this.displayedModals.clear();
		this.unregisteredMemberWarnings.clear();
		this.lastInteractionMessage = undefined;
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		const unstarted = this.dispatches.filter(dispatch => !dispatch.started);
		if (unstarted.length) {
			console.warn(`[@slipher/testing] ${unstarted.length} dispatch(es) were created but never awaited or stepped.`);
		}
		// Drop modal registries so a stray deferred resolution can't fire after close. We do NOT auto-resolve a
		// still-registered modal: that would run the handler's timeout branch (side effects) after the bot is shut.
		this.client.components.modals.clear();
		this.modalWaiters.clear();
		this.modalOwners.clear();
		this.displayedModals.clear();
		this.rest.releasePending();
		// client.close() is seyfert's plugin lifecycle close: it awaits in-flight setup and runs each plugin's
		// teardown. Plugin teardown is therefore driven here symmetrically with the setup run at construction.
		await this.client.close();
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.close();
	}
}

export async function createMockBot(options: MockBotOptions = {}): Promise<MockBot> {
	resetMockIds();
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
	// Capture unhandled run() errors into the active dispatch context. seyfert binds a noisy built-in onRunError
	// default that only logs and swallows, so without this a command that throws (e.g. a second ctx.write) would
	// let a happy-path test pass green. Installed before commands/components load so seyfert's `??=` default
	// binding picks it up. A command with its OWN onRunError keeps it (the `??=` skips our default), so that path
	// never reaches here. When the AUTHOR supplied a client-level default, we delegate and mark it handled (no
	// throw); otherwise we replace seyfert's logger and let the dispatch fail loud.
	const userClientOptions = options.clientOptions as
		| Record<string, { defaults?: { onRunError?: (context: unknown, error: unknown) => unknown } } | undefined>
		| undefined;
	const installRunErrorCapture = (scope: 'commands' | 'components' | 'modals'): void => {
		const authorHandler = userClientOptions?.[scope]?.defaults?.onRunError;
		const clientOpts = client.options as Record<string, { defaults?: { onRunError?: unknown } } | undefined>;
		const target = (clientOpts[scope] ??= {});
		const defaults = (target.defaults ??= {});
		defaults.onRunError = (context: unknown, error: unknown) => {
			const ctx = dispatchStore.getStore();
			if (ctx && ctx.error === undefined) {
				ctx.error = error;
				if (authorHandler) ctx.errorHandled = true;
			}
			return authorHandler?.(context, error);
		};
	};
	installRunErrorCapture('commands');
	installRunErrorCapture('components');
	installRunErrorCapture('modals');
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

	if (options.commands) {
		const commands = Array.isArray(options.commands) ? options.commands : [options.commands];
		// Seyfert's command handler accepts constructor arrays at runtime, but its type expects loaded command metadata.
		client.commands.set(commands as unknown as Parameters<Client['commands']['set']>[0]);
	}
	if (options.components) client.components.set(options.components);
	if (options.events) {
		const events = options.events.map(event => ({ ...event, data: { once: false, ...event.data } }));
		// Tests pass public event definitions; Seyfert fills the internal loader-only fields when executing.
		client.events.set(events as Parameters<Client['events']['set']>[0]);
	}
	// Drive the production startup plugin lifecycle without opening a gateway connection or requiring a token/config.
	await runMockClientStartup(client, options);
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
	);
	bot.installDispatchHooks();
	return bot;
}
