import {
	type AnySeyfertPlugin,
	type APIInteractionResponse,
	ApplicationCommandType,
	Client,
	type ClientEvent,
	type Command,
	type CommandContext,
	type ContextMenuCommand,
	type ContextOptions,
	type EntryPointCommand,
	type GatewayDispatchPayload,
	type OptionsRecord,
	type PluginDiagnostics,
	SubCommand,
} from 'seyfert';
import type { MockBot } from './bot';
import type { Dispatch } from './dispatch';
import type { DispatchDenial } from './dispatch-context';
import type {
	AutocompleteInteractionOptions,
	ButtonInteractionOptions,
	ChatInputInteractionOptions,
	EntryPointInteractionOptions,
	MessageCommandInteractionOptions,
	ModalFields,
	ModalSubmitInteractionOptions,
	SelectMenuInteractionOptions,
	UserCommandInteractionOptions,
} from './interactions';
import type { ApiChannel, ApiMember, ApiMessage, ApiUser, MemberInput } from './payloads';
import type { RecordedAction } from './rest';
import { Routes } from './routes';
import { type EmbedView, harvestComponents, type InteractiveComponentView, normalizeEmbed } from './state';
import type { WorldBuilder } from './world';

type ClientConstructorOptions = ConstructorParameters<typeof Client>[0];
type ClientOptions = NonNullable<ClientConstructorOptions>;
type MockClientOptions = Omit<ClientOptions, 'plugins'>;
type ServicesOptions = Parameters<Client['setServices']>[0];

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

export type ComponentSourceOptions = {
	source?: string | RecordedAction;
	allowSyntheticSource?: boolean;
};

export const INTERACTION_WEBHOOK_ROUTES = [
	Routes.followup,
	Routes.fetchOriginalResponse,
	Routes.editOriginalResponse,
	Routes.deleteOriginalResponse,
	Routes.fetchWebhookMessage,
	Routes.editWebhookMessage,
	Routes.deleteWebhookMessage,
] as const;

export type MessageSource = { id: string; channel_id?: string };
export type MessagePart = { body: OutgoingMessage; source?: MessageSource };
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

export interface RegisteredCommandFound {
	name: string;
	type: 'chatInput' | 'user' | 'message' | 'entryPoint' | 'subcommand';
	/** Parent chat-input command for `type: 'subcommand'`. */
	parentName?: string;
	/** Subcommand group for `type: 'subcommand'`, when the parent groups it. */
	group?: string;
}

/**
 * Read-only command catalog entry, surfaced by {@link MockBot.registeredCommands}. For `commandsDir`/
 * `loadFromConfig` this includes every discovered command file path, even before lazy loading imports it.
 */
export interface RegisteredCommand {
	/** Command file path, when the command came from a directory loader. Direct/plugin commands may not have one. */
	path?: string;
	/** True once that file path has been imported by Seyfert's command loader. */
	loaded: boolean;
	/** Commands/subcommands materialized from this path. Empty means the path has not loaded or exported no command. */
	found: readonly RegisteredCommandFound[];
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

export function buildMessageResult(
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
		fields?: ModalFields,
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

export type MockTopLevelCommandClass = new () => Command | ContextMenuCommand | EntryPointCommand;

export type MockSubCommandClass = new () => SubCommand;

export type MockCommandClass = MockTopLevelCommandClass | MockSubCommandClass;

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

/**
 * A chat-input command class, accepted by the class-first {@link MockBot.slash} overload. Includes `SubCommand`
 * (a sibling of `Command` under `BaseCommand`, not a subclass), since a subcommand is unit-tested directly —
 * `mockCommandContext(MySubCommand)` — like any leaf command.
 */
export type SlashCommandClass = new () => Command | SubCommand;

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
/**
 * Loosen a resolved option value so a test can pass a minimal mock. seyfert resolves a user/channel/role/
 * attachment option to a rich structure (`User`, `Attachment`, …), but a test passes a stand-in like
 * `{ id: 'u1' }` / `{ url: '…' }` — which is exactly what the light harness puts on `ctx.options` at runtime.
 * Scalars stay exact; for entity values we accept a partial of their DATA properties only — methods are dropped
 * because a plain object can't satisfy seyfert's branded method signatures (e.g. `User.toString(): `<@${id}>``),
 * which is what made a plain `Partial<User>` reject `{ id }`. A full resolved value is still assignable too.
 */
type DataKeys<V> = { [K in keyof V]: V[K] extends (...args: never[]) => unknown ? never : K }[keyof V];
type DataPartial<V> = Partial<Pick<V, DataKeys<V>>>;
type LooseOptionValue<V> = V extends string | number | boolean | bigint | undefined | null
	? V
	: V extends unknown
		? DataPartial<V>
		: never;
type LooseResolvedOptions<T> = { [K in keyof T]: LooseOptionValue<T[K]> };

export type SlashOptionsOf<C extends SlashCommandClass> =
	OptionsRecordOf<C> extends OptionsRecord
		? LooseResolvedOptions<ContextOptions<OptionsRecordOf<C>>>
		: Record<string, never>;

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
	/**
	 * Command class(es) to register directly — a single class or an array. `SubCommand` classes are accepted as
	 * class-first dispatch handles, but their parent command must also be registered or loaded from a command dir.
	 */
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
	/**
	 * Explicit commands directory; overrides config-resolved command locations. Command files are cataloged at boot
	 * and imported on first dispatch by default.
	 */
	commandsDir?: string;
	/**
	 * How command/component/event files are imported when loading from a directory (`commandsDir`, etc.).
	 *
	 * Why this exists: a test runner (vitest/jest/bun) only transforms TypeScript in the modules IT evaluates —
	 * your test files and your `src`. Dependencies in `node_modules` are "externalized": run as-is by Node.
	 * Seyfert's own loader lives in `node_modules`, so when it imports your command files it does so from OUTSIDE
	 * the runner's transform — Node then chokes on the `.ts` syntax. That is why pointing a directory at TypeScript
	 * source fails with "Invalid or unexpected token", and why a command loaded from a compiled `dist` can't have
	 * its deps stubbed (the loaded module is a different instance than the `src` one your `vi.mock` targets).
	 *
	 * `loadModule` closes that gap: pass `path => import(path)` DEFINED IN YOUR TEST FILE. Because the thunk lives
	 * in a module the runner transforms, the imported command files (and their dependencies) stay in the runner's
	 * graph — so a directory can point at TS source, `@AutoLoad`'s real filesystem scan runs, and `vi.mock` /
	 * `vi.spyOn` reach the commands' deps, with no compiled build and no `require.cache` surgery. Wrap it once:
	 *
	 *   const makeBot = opts => createMockBot({ loadModule: p => import(p), ...opts });
	 *
	 * Runner-agnostic by design — mirrors the `timers.advance` bridge: the package never imports a runner; you
	 * supply the import. Omit it to use seyfert's default importer (compiled `.js` directories only). To load TS
	 * source without the thunk, instead inline this package in your runner (e.g. vitest `server.deps.inline`).
	 */
	loadModule?: (path: string) => Promise<unknown>;
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
