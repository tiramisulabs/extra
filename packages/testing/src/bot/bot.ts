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
import type { APIInteraction, APIInteractionResponse, GatewayDispatchPayload } from 'seyfert/lib/types';
import { mockId } from '../id';
import { TEST_APPLICATION_ID, TEST_BOT_ID, TEST_USER_ID } from './constants';
import { registerWorldDefaults } from './defaults';
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
	type SelectMenuInteractionOptions,
	selectMenuInteraction,
	type UserCommandInteractionOptions,
	userCommandInteraction,
} from './interactions';
import {
	type ApiChannel,
	type ApiMember,
	type ApiMemberOptions,
	type ApiUser,
	apiMember,
	apiMessage,
	apiUser,
} from './payloads';
import { computeChannelPermissions } from './permissions';
import { type MatchedAction, MockApiHandler, type RecordedAction, type RouteMatcher } from './rest';
import { FOLLOWUP_ROUTE, ORIGINAL_RESPONSE_ROUTE } from './routes';
import { type ChannelView, type GuildView, WorldState } from './state';
import { type MockWorld, seedWorld, type WorldBuilder } from './world';

type ClientConstructorOptions = ConstructorParameters<typeof Client>[0];
type ClientOptions = NonNullable<ClientConstructorOptions>;
type ServicesOptions = Parameters<Client['setServices']>[0];

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
	/** True when the immediate response carried Discord's ephemeral flag. */
	ephemeral: boolean;
	/** Modal metadata when the interaction opened a modal. */
	modal?: { customId?: string; title?: string };
	/** Original-response edits made during the dispatch. */
	edits: OutgoingMessage[];
	/** Followup messages sent during the dispatch. */
	followups: OutgoingMessage[];
	/** REST actions scoped to this dispatch. */
	actions: RecordedAction[];
	/** Best-effort final user-visible content across replies, edits, and followups. */
	content?: string;
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

export interface SayResult {
	/** REST actions scoped to this prefix message dispatch. */
	actions: RecordedAction[];
	/** Message-create REST bodies emitted by the command. */
	messages: OutgoingMessage[];
	/** Last message content, when the command wrote a message. */
	content?: string;
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
	userMenu(options: UserCommandInteractionOptions): Dispatch<DispatchResult>;
	messageMenu(options: MessageCommandInteractionOptions): Dispatch<DispatchResult>;
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

/** Lazy, step-able handle returned by every user-action dispatcher. */
export class Dispatch<T = DispatchResult> implements PromiseLike<T> {
	private execution?: Promise<T>;
	private releasePending?: () => void;
	private settled = false;

	constructor(
		private readonly rest: MockApiHandler,
		private readonly clientRef: Client,
		readonly userId: string | undefined,
		private readonly executor: () => Promise<T>,
	) {}

	private start(): Promise<T> {
		this.execution ??= this.executor();
		return this.execution;
	}

	get started(): boolean {
		return this.execution !== undefined;
	}

	private releaseCheckpoint(): void {
		const release = this.releasePending;
		this.releasePending = undefined;
		release?.();
	}

	async until(matcher: RouteMatcher | ((action: RecordedAction) => boolean)): Promise<RecordedAction> {
		if (this.settled) {
			throw new TypeError(
				'Dispatch.until(): this dispatch already ran to completion - step with until() before awaiting it.',
			);
		}
		const gated = this.rest.gateNext(matcher);
		const previous = this.releasePending;
		this.releasePending = gated.release;
		this.start();
		previous?.();
		return gated.hit;
	}

	async untilModal(timeoutMs = 2000): Promise<void> {
		if (!this.userId) {
			throw new TypeError('untilModal: this dispatch has no user - pass `user` to the dispatch options');
		}
		this.releaseCheckpoint();
		this.start();
		const deadline = Date.now() + timeoutMs;
		while (!this.clientRef.components.modals.has(this.userId)) {
			if (Date.now() > deadline) {
				const waiting = [...this.clientRef.components.modals.keys()].join(', ') || '(none)';
				throw new Error(
					`untilModal: no modal was opened for user ${this.userId} within ${timeoutMs}ms. ` +
						`Modals are waiting for: ${waiting}.`,
				);
			}
			await new Promise(resolve => setImmediate(resolve));
		}
	}

	then<TResult1 = T, TResult2 = never>(
		onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
		onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
	): Promise<TResult1 | TResult2> {
		this.releaseCheckpoint();
		this.settled = true;
		return this.start().then(onfulfilled, onrejected);
	}
}

export type MockCommandClass = new () => Command | ContextMenuCommand | EntryPointCommand;
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

export class MockBot {
	readonly defaultUser: ApiUser = apiUser({ id: TEST_USER_ID, username: 'slipher-tester' });
	private readonly unregisteredMemberWarnings = new Set<string>();
	private readonly dispatches: Dispatch<unknown>[] = [];

	constructor(
		readonly client: Client,
		readonly rest: MockApiHandler,
		readonly gateway: MockGateway,
		protected readonly world?: MockWorld,
		readonly state: WorldState = new WorldState(world),
	) {}

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
		return this.lastSentMessage();
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
				if (member) members[value] = member.member;
				continue;
			}
			if (role) {
				roles[value] = role;
				continue;
			}
			const resolvedUser = user ?? member?.member.user;
			if (resolvedUser) {
				users[value] = resolvedUser;
				if (member) members[value] = member.member;
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
		matcherOrPredicate: RouteMatcher | ((action: RecordedAction) => boolean),
		timeoutMs?: number,
	): Promise<RecordedAction> {
		if (typeof matcherOrPredicate === 'function') return this.rest.waitForAction(matcherOrPredicate, timeoutMs);
		return this.rest.waitForAction(matcherOrPredicate, timeoutMs);
	}

	calls(
		matcher: RouteMatcher | ((action: RecordedAction) => boolean),
		params?: Record<string, string>,
	): MatchedAction[] {
		return this.rest.calls(matcher, params);
	}

	call(
		matcher: RouteMatcher | ((action: RecordedAction) => boolean),
		params?: Record<string, string>,
	): MatchedAction | undefined {
		return this.rest.call(matcher, params);
	}

	clearActions(): void {
		this.rest.clearActions();
	}

	guild(guildId: string): GuildView | undefined {
		return this.state.guild(guildId);
	}

	dm(userId: string): ChannelView | undefined {
		return this.state.dm(userId);
	}

	dispatchInteraction(payload: ApiInteractionPayload): Dispatch<DispatchResult> {
		const userId = payload.member?.user.id ?? payload.user?.id;
		return this.track(new Dispatch(this.rest, this.client, userId, () => this.runInteraction(payload)));
	}

	private materializeInteractionResponse(payload: ApiInteractionPayload, body: APIInteractionResponse): void {
		const data = 'data' in body ? ((body.data ?? {}) as Record<string, unknown>) : {};
		if (body.type === 4) {
			this.state.addOriginalResponse(payload.token, payload.channel_id, data, this.client.botId);
		}
		if (body.type === 7 && payload.message) {
			this.state.editMessage(payload.message.channel_id, payload.message.id, data);
		}
	}

	private async runInteraction(payload: ApiInteractionPayload): Promise<DispatchResult> {
		const startSeq = this.rest.actions.length;
		const replies: CapturedReply[] = [];
		this.state.registerInteractionToken(payload.token, payload.channel_id);
		// The builders preserve Discord's payload shape while exposing a wider test input type.
		await this.client.handleCommand.interaction(payload as unknown as APIInteraction, -1, async reply => {
			replies.push(reply);
			this.materializeInteractionResponse(payload, reply.body);
		});
		const actions = this.rest.actions.slice(startSeq);
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
		const edits = actions
			.filter(
				action =>
					action.method === 'PATCH' &&
					ORIGINAL_RESPONSE_ROUTE.test(action.route) &&
					action.route.includes(payload.token),
			)
			.map(action => (action.body ?? {}) as OutgoingMessage);
		const followups = actions
			.filter(
				action => action.method === 'POST' && FOLLOWUP_ROUTE.test(action.route) && action.route.includes(payload.token),
			)
			.map(action => (action.body ?? {}) as OutgoingMessage);

		return {
			replies,
			edits,
			followups,
			actions,
			get reply() {
				return replies[0];
			},
			get deferred() {
				return replies[0]?.body.type === 5 || replies[0]?.body.type === 6;
			},
			get ephemeral() {
				const body = replies[0]?.body;
				const data = body && 'data' in body ? (body.data as { flags?: number } | undefined) : undefined;
				return Boolean(data?.flags && data.flags & 64);
			},
			get modal() {
				const body = replies[0]?.body;
				if (body?.type !== 9) return undefined;
				const data = body.data as { custom_id?: string; title?: string } | undefined;
				return { customId: data?.custom_id, title: data?.title };
			},
			get content() {
				const reply = replies[0];
				const replyContent =
					reply && 'data' in reply.body ? (reply.body.data as { content?: string } | undefined)?.content : undefined;
				return edits.at(-1)?.content ?? replyContent;
			},
		};
	}

	private assertCommandRegistered(name: string): void {
		const registered = this.client.commands.values.map(command => command.name);
		if (!registered.includes(name)) {
			throw new TypeError(
				`slash: command "${name}" is not registered. Registered commands: ${registered.join(', ') || '(none)'}`,
			);
		}
	}

	slash(options: ChatInputInteractionOptions): Dispatch<DispatchResult> {
		this.assertCommandRegistered(options.name);
		const prepared = this.applyWorldPermissions({ user: this.defaultUser, ...options });
		return this.dispatchInteraction(chatInputInteraction(prepared));
	}

	autocomplete(options: AutocompleteInteractionOptions): Dispatch<AutocompleteResult> {
		this.assertCommandRegistered(options.name);
		const payload = autocompleteInteraction(this.applyWorldPermissions({ user: this.defaultUser, ...options }));
		const userId = payload.member?.user.id ?? payload.user?.id;
		return this.track(
			new Dispatch(this.rest, this.client, userId, async () => {
				const result = await this.runInteraction(payload);
				const body = result.reply?.body;
				return { ...result, choices: body?.type === 8 ? body.data?.choices : undefined };
			}),
		);
	}

	userMenu(options: UserCommandInteractionOptions): Dispatch<DispatchResult> {
		this.assertCommandRegistered(options.name);
		return this.dispatchInteraction(
			userCommandInteraction(this.applyWorldPermissions({ user: this.defaultUser, ...options })),
		);
	}

	messageMenu(options: MessageCommandInteractionOptions): Dispatch<DispatchResult> {
		this.assertCommandRegistered(options.name);
		return this.dispatchInteraction(
			messageCommandInteraction(this.applyWorldPermissions({ user: this.defaultUser, ...options })),
		);
	}

	entryPoint(options: EntryPointInteractionOptions = {}): Dispatch<DispatchResult> {
		return this.dispatchInteraction(
			entryPointInteraction(this.applyWorldPermissions({ user: this.defaultUser, ...options })),
		);
	}

	clickButton(
		customId: string,
		options: Omit<ButtonInteractionOptions, 'customId' | 'message'> & { source?: string | RecordedAction } = {},
	): Dispatch<DispatchResult> {
		const { source, ...rest } = options;
		const message = this.resolveMessageSource(source);
		this.assertComponentHandleable('clickButton', customId, message);
		const prepared = this.applyWorldPermissions({ user: this.defaultUser, ...rest, customId });
		return this.dispatchInteraction(
			buttonInteraction({
				...prepared,
				...(message?.id ? { message: apiMessage({ id: message.id, channelId: message.channel_id }) } : {}),
			}),
		);
	}

	selectMenu(
		customId: string,
		values: string[],
		options: Omit<SelectMenuInteractionOptions, 'customId' | 'values' | 'message'> & {
			source?: string | RecordedAction;
		} = {},
	): Dispatch<DispatchResult> {
		const { source, ...rest } = options;
		const message = this.resolveMessageSource(source);
		this.assertComponentHandleable('selectMenu', customId, message);
		const base = { user: this.defaultUser, ...rest, customId, values };
		const resolved = this.resolveSelectResolved(customId, values, base);
		const prepared = this.applyWorldPermissions({ ...base, ...(resolved ? { resolved } : {}) });
		return this.dispatchInteraction(
			selectMenuInteraction({
				...prepared,
				...(message?.id ? { message: apiMessage({ id: message.id, channelId: message.channel_id }) } : {}),
			}),
		);
	}

	fillModal(
		customId: string,
		fields: Record<string, string> = {},
		extra: Omit<ModalSubmitInteractionOptions, 'customId' | 'fields'> = {},
	): Dispatch<DispatchResult> {
		const prepared = this.applyWorldPermissions({ user: this.defaultUser, ...extra, customId, fields });
		this.assertModalHandleable(customId, prepared.user?.id ?? this.defaultUser.id);
		return this.dispatchInteraction(modalSubmitInteraction(prepared));
	}

	say(content: string, options: DispatchMessageOptions = {}): Dispatch<SayResult> {
		const author = options.user ?? this.defaultUser;
		const dm = options.guildId === null;
		const guildId = dm ? undefined : (options.guildId ?? mockId());
		const member = apiMember({ user: author, ...(options.member ?? {}) });
		const { user: _user, ...gatewayMember } = member;
		const raw = {
			...apiMessage({
				author,
				content,
				channelId: options.channel?.id,
				...(guildId ? { guildId } : {}),
			}),
			...(dm ? {} : { member: gatewayMember }),
		};

		return this.track(
			new Dispatch(this.rest, this.client, author.id, async () => {
				const startSeq = this.rest.actions.length;
				await this.client.handleCommand.message(raw as Parameters<HandleCommand['message']>[0], -1);
				const actions = this.rest.actions.slice(startSeq);
				const messages = actions
					.filter(action => action.method === 'POST' && /\/channels\/[^/]+\/messages$/.test(action.route))
					.map(action => (action.body ?? {}) as OutgoingMessage);
				return { actions, messages, content: messages.at(-1)?.content };
			}),
		);
	}

	actor(options: ActorOptions): Actor {
		const entry = options.member
			? this.world?.members.find(candidate => candidate.member.user.id === options.member?.user.id)
			: undefined;
		const user = options.user ?? options.member?.user;
		const guildId = options.guildId ?? entry?.guildId;
		const channel =
			options.channel ??
			(entry ? this.world?.channels.find(candidate => candidate.guild_id === entry.guildId) : undefined);
		const base = { user, guildId, channel };

		return {
			slash: options => this.slash({ ...base, ...options }),
			autocomplete: options => this.autocomplete({ ...base, ...options }),
			userMenu: options => this.userMenu({ ...base, ...options }),
			messageMenu: options => this.messageMenu({ ...base, ...options }),
			entryPoint: options => this.entryPoint({ ...base, ...options }),
			fillModal: (customId, fields, options = {}) => this.fillModal(customId, fields, { ...base, ...options }),
			clickButton: (customId, options = {}) => this.clickButton(customId, { ...base, ...options }),
			selectMenu: (customId, values, options = {}) => this.selectMenu(customId, values, { ...base, ...options }),
			say: (content, options = {}) => this.say(content, { ...base, ...options }),
		};
	}

	async emitEvent<TName extends GatewayDispatchPayload['t']>(
		name: TName,
		payload: Partial<Extract<GatewayDispatchPayload, { t: TName }>['d']> & Record<string, unknown>,
		options?: { updateCache?: boolean },
	): Promise<void>;
	async emitEvent(name: string, payload: Record<string, unknown>, options?: { updateCache?: boolean }): Promise<void>;
	async emitEvent(name: string, payload: Record<string, unknown>, { updateCache = true } = {}): Promise<void> {
		await this.client.events.runEvent(
			name as Parameters<Client['events']['runEvent']>[0],
			this.client,
			payload,
			-1,
			updateCache,
		);
	}

	async close(): Promise<void> {
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
	const client = new Client(clientOptions);
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
		client.langs.set(
			Object.entries(options.langs).map(
				([name, file]): LangInstance => ({
					name,
					file: { default: file } as LangInstance['file'],
					path: `${name}.ts`,
				}),
			),
		);
	}
	if (options.defaultLang) {
		client.langs.defaultLang = options.defaultLang;
	}
	client.botId = botId;
	client.applicationId = options.applicationId ?? TEST_APPLICATION_ID;

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

	// setupPlugins is intentionally not public on Client, but production start() calls the same hook.
	await (client as unknown as { setupPlugins(): Promise<void> }).setupPlugins();
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

	return new MockBot(client, rest, gateway, world, state);
}
