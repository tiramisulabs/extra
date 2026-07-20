import {
	type AnySeyfertPlugin,
	ApplicationCommandType,
	Client,
	ModalCommand,
	type PluginDiagnostics,
	type ResolvedPluginList,
	SubCommand,
} from 'seyfert';
import { type CommandPathCatalog } from './bootstrap';
import type { CommandRuntime, SubcommandClassRoute } from './bot-support';
import {
	actionRendersComponent,
	collectComponentCustomIds,
	findComponentNode,
	findComponentType,
} from './component-tree';
import { TEST_USER_ID } from './constants';
import {
	buildMessageResult,
	type ComponentSourceOptions,
	type DispatchResult,
	type MessagePart,
	type MessageResultBase,
	type MockSubCommandClass,
	type OutgoingMessage,
	type PluginInfo,
	type RegisteredCommand,
	type RegisteredCommandFound,
	type RegisteredComponent,
} from './contracts';
import { Dispatch, type ModalWaiter } from './dispatch';
import { MockGateway } from './gateway';
import { type InputCheckpoint, InteractionSessions, matchesCollector } from './interaction-session';
import {
	type BaseInteractionOptions,
	type ButtonInteractionOptions,
	type ModalFields,
	type SelectMenuInteractionOptions,
} from './interactions';
import { type ApiMember, type ApiMessage, type ApiUser, apiMessage, apiUser, memberOptionsFrom } from './payloads';
import { computeChannelPermissions } from './permissions';
import { MockApiHandler, type RecordedAction } from './rest';
import {
	arrayValue,
	asRecord,
	type EmbedView,
	type InteractiveComponentView,
	numberValue,
	renderedReply,
	stringValue,
	WorldState,
	type WorldStateReader,
} from './state';
import { type MockWorld } from './world';

export abstract class MockBotSurface {
	abstract clickButton(
		customId: string,
		options?: Omit<ButtonInteractionOptions, 'customId' | 'message'> & ComponentSourceOptions,
	): Promise<DispatchResult>;
	abstract selectMenu(
		customId: string,
		values: string[],
		options?: Omit<SelectMenuInteractionOptions, 'customId' | 'values' | 'message'> & ComponentSourceOptions,
	): Promise<DispatchResult>;
	readonly defaultUser: ApiUser = apiUser({ id: TEST_USER_ID, username: 'slipher-tester' });
	protected readonly unregisteredMemberWarnings = new Set<string>();
	protected readonly dispatches: Dispatch<unknown>[] = [];
	protected subcommandRoutes: SubcommandClassRoute[] = [];
	/** Pending modal waiters keyed by userId; resolved when seyfert registers a modal via components.modals.set. */
	protected readonly modalWaiters = new Map<string, ModalWaiter[]>();
	/** The dispatch that owns the currently registered waitFor modal for a user. */
	protected readonly modalOwners = new Map<string, number>();
	/** Modal definition displayed to a user (customId + input customIds), captured when seyfert registers it. */
	protected readonly displayedModals = new Map<
		string,
		{ customId?: string; inputIds: Set<string>; dispatchId?: number }
	>();
	/** Dispatches whose type-9 callback was captured eagerly by the modal registration hook. */
	protected readonly modalRenderCapturedDispatches = new Set<number>();
	protected virtualNowMs = Date.now();
	protected closed = false;
	/** Set once the fallback full scan has run, so no further on-demand command load is attempted. */
	protected loadedAllCommands = false;
	/** Serializes on-demand loads so concurrent dispatches don't clobber the handler's per-file filter. */
	protected lazyLoadLock: Promise<void> = Promise.resolve();
	/** The most recent interaction-original message, used to resolve a collector source for an immediate reply. */
	protected lastInteractionMessage?: { id: string; channel_id?: string };
	/** Component/modal detection capabilities, fixed at install time from the client's component surface. */
	protected canDetectComponentCommand = false;
	protected canDetectCollector = false;
	protected canDetectComponentWait = false;
	protected canDetectModalCollector = false;
	protected readonly sessions: InteractionSessions;

	constructor(
		readonly client: Client<true>,
		readonly rest: MockApiHandler,
		readonly gateway: MockGateway,
		protected readonly _world: MockWorld | undefined,
		// Required (no default): createMockBot passes the SAME WorldState it gives registerWorldDefaults. A default
		// `new WorldState(world)` here would silently create a second instance that shares the world arrays by
		// reference but has its own bans/reactions/token Maps — a split-brain. Keep them the one instance.
		protected readonly _state: WorldState,
		protected readonly validateOptions = true,
		protected readonly timers?: { advance(ms: number): void | Promise<void> },
		protected readonly onCommandError: 'throw' | 'capture' = 'throw',
		/** When set, commands load on first dispatch from this dir (undefined dir → seyfert config). */
		protected readonly lazyCommands?: { commandsDir?: string },
		protected readonly commandCatalog?: CommandPathCatalog,
	) {
		this.refreshSubcommandRoutes();
		this.sessions = new InteractionSessions({
			actions: () => this.rest.actions,
			assertCheckpointReady: checkpoint => this.assertCheckpointReady(checkpoint),
			onDispatchCompleted: dispatchId => {
				for (const [userId, ownerDispatchId] of this.modalOwners) {
					if (ownerDispatchId !== dispatchId) continue;
					this.client.components.modals.delete(userId);
					this.modalOwners.delete(userId);
					this.displayedModals.delete(userId);
				}
			},
		});
	}

	/**
	 * Read-only view of the simulated world for assertions — the full entity-query surface behind the
	 * `world*` accessors. Exposes only query methods; the internal mutators that the mock drives in
	 * response to Discord traffic are not part of this public type. Use the {@link MockBot} verbs (or REST
	 * routes) to change world state.
	 */
	get world(): WorldStateReader {
		return this._state;
	}

	protected assertOpen(verb: string): void {
		if (this.closed) throw new Error(`${verb}: MockBot is closed.`);
	}

	protected refreshSubcommandRoutes(): void {
		const routes: SubcommandClassRoute[] = [];
		for (const parent of this.client.commands.values as unknown as {
			name?: unknown;
			type?: unknown;
			options?: unknown;
		}[]) {
			if (parent.type !== ApplicationCommandType.ChatInput || typeof parent.name !== 'string') continue;
			if (!Array.isArray(parent.options)) continue;
			for (const option of parent.options) {
				if (!(option instanceof SubCommand)) continue;
				routes.push({
					commandClass: option.constructor,
					parentName: parent.name,
					...(option.group ? { group: option.group } : {}),
					subcommand: option.name,
				});
			}
		}
		this.subcommandRoutes = routes;
	}

	protected subcommandRouteLabel(route: SubcommandClassRoute): string {
		return `${route.parentName}${route.group ? ` ${route.group}` : ''} ${route.subcommand}`;
	}

	protected matchingSubcommandRoutes(command: MockSubCommandClass, instance: SubCommand): SubcommandClassRoute[] {
		const exact = this.subcommandRoutes.filter(route => route.commandClass === command);
		if (exact.length) return exact;
		return this.subcommandRoutes.filter(route => route.subcommand === instance.name && route.group === instance.group);
	}

	protected subcommandRouteFor(
		command: MockSubCommandClass,
		instance: SubCommand,
		verb: string,
	): SubcommandClassRoute | undefined {
		const matches = this.matchingSubcommandRoutes(command, instance);
		if (matches.length <= 1) return matches[0];
		throw new TypeError(
			`${verb}: subcommand "${instance.name}" is ambiguous; it is registered under ${matches
				.map(route => `"${this.subcommandRouteLabel(route)}"`)
				.join(', ')}. Use bot.slash({ name, group, subcommand }) to choose the parent command.`,
		);
	}

	protected requireSubcommandRoute(
		command: MockSubCommandClass,
		instance: SubCommand,
		verb: string,
	): SubcommandClassRoute {
		const route = this.subcommandRouteFor(command, instance, verb);
		if (route) return route;
		throw new TypeError(
			`${verb}: subcommand "${instance.name}" is not registered under any loaded parent command. ` +
				'Pass the parent command to createMockBot({ commands: [ParentCommand] }), load it through commandsDir/loadFromConfig, ' +
				'or dispatch explicitly with bot.slash({ name, group, subcommand }).',
		);
	}

	/** @internal createMockBot uses this after all eager command sources have loaded. */
	validateSubcommandClasses(commands: readonly MockSubCommandClass[]): void {
		for (const command of commands) {
			this.requireSubcommandRoute(command, new command(), 'createMockBot({ commands })');
		}
	}

	protected track<T>(dispatch: Dispatch<T>): Dispatch<T> {
		this.dispatches.push(dispatch as Dispatch<unknown>);
		return dispatch;
	}

	/** Visible output from the most recently completed stateful step. `bot.actions` remains the full history. */
	get currentActions(): readonly RecordedAction[] {
		return this.sessions.currentActions();
	}

	protected messageParts(actions: RecordedAction[], parts: MessagePart[]): MessageResultBase {
		return buildMessageResult(actions, parts);
	}

	protected outgoingMessagePart(action: RecordedAction): MessagePart {
		return {
			body: {
				...((action.body ?? {}) as OutgoingMessage),
				...(action.files ? { files: action.files } : {}),
			},
			source: this.messageSourceFrom(action.response),
		};
	}

	protected applyWorldPermissions<T extends BaseInteractionOptions>(options: T): T {
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

	protected componentCommands(): readonly unknown[] {
		return this.client.components.commands;
	}

	protected hasComponentCommand(): boolean {
		return this.componentCommands().some(command => !(command instanceof ModalCommand));
	}

	protected hasModalCommand(): boolean {
		return this.componentCommands().some(command => command instanceof ModalCommand);
	}

	/**
	 * Build a diagnostic for an unmatched component/modal dispatch that distinguishes the two failure modes:
	 * (a) no handler of the right kind is registered at all, vs (b) one IS registered but its customId/filter
	 * rejected this customId (e.g. a typo). Mirrors seyfert's `_filter`: the customId predicate is computed
	 * here without side effects; `filter(context)` is only noted, never invoked, since it needs a live context.
	 */
	protected describeUnmatchedComponent(kind: 'component' | 'modal', customId: string): string {
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

	protected assertSyntheticComponentAllowed(verb: 'clickButton' | 'selectMenu', customId: string): void {
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
	protected assertComponentVerbType(verb: 'clickButton' | 'selectMenu', customId: string, message: ApiMessage): void {
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

	protected requireComponentOnMessage(
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

	protected assertSelectValuesMatchSource(
		customId: string,
		values: string[],
		component: Record<string, unknown>,
	): void {
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

	protected assertModalHandleable(customId: string, userId: string, allowSyntheticSource: boolean): void {
		if (this.displayedModals.has(userId)) return;
		if (allowSyntheticSource && this.hasModalCommand()) return;
		const otherUsers = [...this.client.components.modals.keys()].filter(id => id !== userId);
		const pendingOpener = this.dispatches.some(dispatch => !dispatch.started && !dispatch.isSettled);
		const hint =
			otherUsers.length > 0
				? `A modal IS waiting, but for a different user (${otherUsers.join(', ')}). Pass that same 'user' to submitModal.`
				: pendingOpener
					? 'The opener has not run yet — await the opener, then call `await bot.submitModal(customId, fields)`.'
					: 'Dispatch and await the button/command that opens the modal before calling submitModal.';
		throw new TypeError(
			`submitModal: modal "${customId}" was not rendered for user "${userId}". ${hint} ` +
				'Raw ModalCommand-only dispatches require bot.dispatch.submitModal(..., { allowSyntheticSource: true }).',
		);
	}

	/**
	 * Snapshot the modal definition seyfert just displayed to `userId` (custom_id + the set of input customIds),
	 * read from the most recent type-9 interaction callback. Lets {@link assertModalMatchesDisplayed} reject a
	 * submitModal aimed at the wrong customId or carrying field keys that no input on the modal accepts.
	 */
	protected captureDisplayedModal(userId: string, dispatchId: number | undefined): string | undefined {
		for (let i = this.rest.actions.length - 1; i >= 0; i--) {
			const action = this.rest.actions[i];
			if (dispatchId !== undefined && action.dispatchId !== dispatchId) continue;
			if (!action.route.includes('/callback')) continue;
			const body = action.body as { type?: number; data?: Record<string, unknown> } | undefined;
			if (body?.type !== 9) continue;
			const data = body.data ?? {};
			const inputIds = new Set<string>();
			collectComponentCustomIds(data.components, inputIds);
			this.displayedModals.set(userId, {
				customId: data.custom_id as string | undefined,
				inputIds,
				...(dispatchId === undefined ? {} : { dispatchId }),
			});
			if (dispatchId !== undefined) this.modalRenderCapturedDispatches.add(dispatchId);
			return data.custom_id as string | undefined;
		}
		return undefined;
	}

	protected assertCheckpointReady(checkpoint: InputCheckpoint): void {
		if (checkpoint.kind === 'modal') {
			const displayed = this.displayedModals.get(checkpoint.userId);
			if (!displayed) {
				throw new TypeError(
					`stateful step: modal checkpoint for user "${checkpoint.userId}" was registered but no modal was rendered.`,
				);
			}
			if (checkpoint.customId !== undefined && displayed.customId !== checkpoint.customId) {
				throw new TypeError(
					`stateful step: modal checkpoint "${checkpoint.customId}" does not match rendered modal ` +
						`"${displayed.customId ?? '(missing customId)'}".`,
				);
			}
			return;
		}

		const message = this._state.rawMessage(checkpoint.channelId, checkpoint.messageId);
		if (!message) {
			throw new TypeError(
				`stateful step: collector checkpoint on message "${checkpoint.messageId}" was registered, ` +
					'but that message is not present in the simulated Discord state.',
			);
		}
		const ids = new Set<string>();
		collectComponentCustomIds(message.components, ids);
		if ([...ids].some(customId => matchesCollector(checkpoint.match, customId))) return;
		throw new TypeError(
			`stateful step: collector on message "${checkpoint.messageId}" is waiting for ` +
				`${String(checkpoint.match)}, but the rendered components are [${[...ids].join(', ') || '(none)'}].`,
		);
	}

	/**
	 * Cross-check a submitModal against the modal that was actually displayed: the customId must match, and every
	 * field key must correspond to a real input on the modal. Skipped only for an explicitly synthetic raw
	 * ModalCommand dispatch, which has no rendered definition to validate.
	 */
	protected assertModalMatchesDisplayed(customId: string, fields: ModalFields, userId: string): void {
		const displayed = this.displayedModals.get(userId);
		if (!displayed) return;
		if (displayed.customId !== undefined && displayed.customId !== customId) {
			throw new TypeError(
				`submitModal: the displayed modal's customId is "${displayed.customId}", not "${customId}". ` +
					`Pass the customId the command opened the modal with.`,
			);
		}
		const ghost = Object.keys(fields).filter(key => !displayed.inputIds.has(key));
		if (ghost.length > 0) {
			const known = [...displayed.inputIds].join(', ') || '(none)';
			throw new TypeError(
				`submitModal: field(s) ${ghost.map(key => `"${key}"`).join(', ')} are not inputs on the displayed modal. ` +
					`Known inputs: ${known}.`,
			);
		}
	}

	protected consumeDisplayedModal(userId: string): void {
		this.displayedModals.delete(userId);
	}

	protected assertStatefulModalAvailable(
		customId: string,
		fields: ModalFields,
		userId: string,
		sessionKey: string,
	): void {
		const displayed = this.displayedModals.get(userId);
		const checkpoint = this.sessions.hasModalCheckpoint(sessionKey, customId, userId);
		const renderedInCurrentStep =
			displayed?.dispatchId !== undefined &&
			this.sessions.currentActions(sessionKey).some(action => action.dispatchId === displayed.dispatchId);
		if (!displayed || (!checkpoint && !renderedInCurrentStep)) {
			throw new TypeError(
				`submitModal: modal "${customId}" is not available in the current state for user "${userId}". ` +
					'Await the action that renders it and inspect it with rendered(bot) or rendered(actor).',
			);
		}
		this.assertModalMatchesDisplayed(customId, fields, userId);
	}

	/** Read a `{ id, channel_id? }` message source out of a recorded REST response, or undefined if it has no id. */
	protected messageSourceFrom(response: unknown): { id: string; channel_id?: string } | undefined {
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
	protected resolveMessageSource(source?: string | RecordedAction): { id: string; channel_id?: string } | undefined {
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

	/**
	 * Resolve an implicit component target from the CURRENT stateful step, never from historical bot traffic.
	 * The raw dispatcher still accepts explicit historical sources through `bot.dispatch.*`.
	 */
	protected resolveCurrentComponentSource(
		sessionKey: string,
		verb: 'clickButton' | 'selectMenu',
		customId: string,
	): { id: string; channel_id?: string } | undefined {
		const candidates = new Map<string, { id: string; channel_id?: string }>();
		for (const checkpoint of this.sessions.checkpoints(sessionKey)) {
			if (checkpoint.kind !== 'component' || !matchesCollector(checkpoint.match, customId)) continue;
			const message = this._state.rawMessage(checkpoint.channelId, checkpoint.messageId);
			if (!message || !findComponentNode(message.components, customId)) continue;
			candidates.set(checkpoint.messageId, {
				id: checkpoint.messageId,
				channel_id: checkpoint.channelId,
			});
		}
		if (candidates.size === 1) return [...candidates.values()][0];
		if (candidates.size > 1) {
			throw new TypeError(
				`${verb}: component "${customId}" is ambiguous in the current bot state; it has active waits on messages ` +
					`${[...candidates.keys()].map(id => `"${id}"`).join(', ')}. Pass an explicit source.`,
			);
		}
		const actions = this.sessions.currentActions(sessionKey);
		for (let index = actions.length - 1; index >= 0; index--) {
			const action = actions[index];
			if (!actionRendersComponent(action, customId)) continue;
			const source = this.messageSourceForRenderedAction(action);
			if (!source) continue;
			const message = this._state.rawMessageById(source.id);
			if (!message || !findComponentNode(message.components, customId)) continue;
			candidates.set(source.id, source);
		}
		if (candidates.size === 1) return [...candidates.values()][0];
		if (candidates.size > 1) {
			throw new TypeError(
				`${verb}: component "${customId}" is ambiguous in the current bot state; it appears on messages ` +
					`${[...candidates.keys()].map(id => `"${id}"`).join(', ')}. Pass an explicit source.`,
			);
		}
		return undefined;
	}

	/** Most recent message rendered by this session's current step, regardless of its component ids. */
	protected resolveCurrentMessageSource(sessionKey: string): { id: string; channel_id?: string } | undefined {
		const actions = this.sessions.currentActions(sessionKey);
		for (let index = actions.length - 1; index >= 0; index--) {
			const source = this.messageSourceForRenderedAction(actions[index]);
			if (source) return source;
		}
		return undefined;
	}

	private messageSourceForRenderedAction(action: RecordedAction): { id: string; channel_id?: string } | undefined {
		const responseSource = this.messageSourceFrom(action.response);
		if (responseSource) return responseSource;
		const callback = /^\/interactions\/[^/]+\/([^/]+)\/callback$/.exec(action.route);
		if (callback) return this.messageSourceFrom(this._state.messageForToken(callback[1]));
		return undefined;
	}

	protected hydrateSourceMessage(
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

	protected worldMemberFor(guildId: string | null | undefined, user: ApiUser | undefined): ApiMember | undefined {
		if (!this._world || !guildId || !user) return undefined;
		return this._world.members.find(entry => entry.guildId === guildId && entry.member.user.id === user.id)?.member;
	}

	protected nowMs(): number {
		return this.timers ? this.virtualNowMs : Date.now();
	}

	protected inferDrainDispatchId(scope?: Dispatch<unknown> | number): number | undefined {
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

	protected assertNoConcurrentImplicitComponentSource(
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

	/** Rendered output from the current stateful step. `bot.actions` remains the complete REST history. */
	protected renderedAcrossDispatches(): { embeds: EmbedView[]; components: InteractiveComponentView[] } {
		return renderedReply(this.currentActions);
	}

	lastEmbeds(): EmbedView[] {
		return this.renderedAcrossDispatches().embeds;
	}

	lastEmbed(index = 0): EmbedView {
		const embeds = this.renderedAcrossDispatches().embeds;
		if (embeds.length === 0) {
			throw new TypeError('MockBot.lastEmbed: no embed has been sent.');
		}
		if (index < 0 || index >= embeds.length) {
			throw new TypeError(`MockBot.lastEmbed: index ${index} is out of range — sent ${embeds.length} embed(s).`);
		}
		return embeds[index];
	}

	lastComponents(): InteractiveComponentView[] {
		return this.renderedAcrossDispatches().components;
	}

	/** Latest text content rendered by the current stateful step, or undefined when that step rendered no content. */
	lastContent(): string | undefined {
		return renderedReply(this.currentActions).content;
	}

	/**
	 * Read-only command catalog. For directory-loaded commands this includes discovered paths before lazy import,
	 * then fills `found` once Seyfert materializes the command or subcommand from that path. Pure read; no imports.
	 */
	registeredCommands(): readonly RegisteredCommand[] {
		const typeName = (type: ApplicationCommandType): RegisteredCommandFound['type'] => {
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
		const foundByPath = new Map<string, RegisteredCommandFound[]>();
		const runtimeEntries: RegisteredCommand[] = [];
		const push = (path: string | undefined, found: RegisteredCommandFound): void => {
			if (!path) {
				runtimeEntries.push({ loaded: true, found: [found] });
				return;
			}
			const entry = foundByPath.get(path);
			if (entry) entry.push(found);
			else foundByPath.set(path, [found]);
		};
		const commands = [...(this.client.commands.values as unknown as CommandRuntime[])];
		const entryPoint = (this.client.commands as unknown as { entryPoint?: CommandRuntime | null }).entryPoint;
		if (entryPoint) commands.push(entryPoint);
		for (const command of commands) {
			const path = command.__filePath;
			push(path, {
				name: command.name,
				type: typeName(command.type as ApplicationCommandType),
			});
			if (command.type !== ApplicationCommandType.ChatInput || !Array.isArray(command.options)) continue;
			for (const option of command.options) {
				if (!(option instanceof SubCommand)) continue;
				const subcommand = option as SubCommand & { __filePath?: string };
				push(subcommand.__filePath ?? path, {
					name: subcommand.name,
					type: 'subcommand',
					parentName: command.name,
					...(subcommand.group ? { group: subcommand.group } : {}),
				});
			}
		}

		const rows: RegisteredCommand[] = [];
		const seenPaths = new Set<string>();
		for (const entry of this.commandCatalog?.entries() ?? []) {
			seenPaths.add(entry.path);
			rows.push({
				path: entry.path,
				loaded: entry.loaded || foundByPath.has(entry.path),
				found: foundByPath.get(entry.path) ?? [],
			});
		}
		for (const [path, found] of foundByPath) {
			if (seenPaths.has(path)) continue;
			rows.push({ path, loaded: true, found });
		}
		rows.push(...runtimeEntries);
		return rows;
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
}
