import {
	type APIInteraction,
	type APIInteractionResponse,
	ApplicationCommandType,
	Client,
	type GatewayDispatchPayload,
	InteractionResponseType,
	InteractionType,
	SubCommand,
} from 'seyfert';
import { HandleCommand } from 'seyfert/lib/commands/handle';
import type { SubcommandClassRoute } from './bot-support';
import { selectTypeForInteraction } from './component-tree';
import { TEST_CHANNEL_ID, TEST_GUILD_ID } from './constants';
import {
	type Actor,
	type ActorOptions,
	type AutocompleteResult,
	type CapturedReply,
	type ComponentSourceOptions,
	type DispatchMessageOptions,
	type DispatchResult,
	type EmitEventOptions,
	type EventDispatchResult,
	INTERACTION_WEBHOOK_ROUTES,
	type MenuCommandClass,
	type MenuOptions,
	type MenuResultFor,
	type MessageMenuResult,
	type MessagePart,
	type MockSubCommandClass,
	type OutgoingMessage,
	type SayResult,
	type SlashClassOptions,
	type SlashCommandClass,
	type UserMenuResult,
} from './contracts';
import { Dispatch } from './dispatch';
import { type DispatchContext, dispatchStore, nextDispatchId } from './dispatch-context';
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
	type ModalFields,
	type ModalSubmitInteractionOptions,
	messageCommandInteraction,
	modalSubmitInteraction,
	type SelectMenuInteractionOptions,
	selectMenuInteraction,
	type UserCommandInteractionOptions,
	userCommandInteraction,
} from './interactions';
import { isEphemeral } from './message-flags';
import { MockBotDispatchCore } from './mock-bot-dispatch';
import { prepareAutocompleteOptions, prepareChatInputOptions } from './option-validation';
import { type ApiMessage, apiMember, apiMessage, apiUser, memberOptionsFrom } from './payloads';
import { isOutgoingMessagePost, type RecordedAction } from './rest';
import { FOLLOWUP_ROUTE, Routes, WEBHOOK_MESSAGE_ROUTE } from './routes';
import { resolveSelectResolved } from './select-resolved';
import { eventsInternals, modalRegistry, normalizeGatewayEventName, pluginEventNames } from './seyfert-internals';
import { numberValue } from './state';
import { applyWorldEvent, WORLD_EVENT_NAMES } from './world-events';

export class MockBot extends MockBotDispatchCore {
	protected async runInteraction(payload: ApiInteractionPayload, dispatchId: number): Promise<DispatchResult> {
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
		// Denial detection: seyfert's __runMiddlewares only resolves on next()/stop(). A guard that
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

	protected assertCommandRegistered(name: string, type: ApplicationCommandType, verb: string): void {
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

	protected dispatchVia<O extends BaseInteractionOptions, R = DispatchResult>(
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
		if (typeof commandOrOptions === 'function') return this.dispatchSlashClass(commandOrOptions, classOptions);
		return this.dispatchSlash(commandOrOptions);
	}

	protected dispatchSlashClass<C extends SlashCommandClass>(
		command: C,
		classOptions?: SlashClassOptions<C>,
	): Dispatch<DispatchResult> {
		const instance = new command();
		if (instance instanceof SubCommand) {
			return this.dispatchSubcommandClass(command as MockSubCommandClass, instance, classOptions);
		}
		return this.dispatchSlash({ ...(classOptions ?? {}), name: instance.name } as ChatInputInteractionOptions);
	}

	protected subcommandRouteOptions<C extends SlashCommandClass>(
		route: SubcommandClassRoute,
		classOptions?: SlashClassOptions<C>,
	): ChatInputInteractionOptions {
		return {
			...(classOptions ?? {}),
			name: route.parentName,
			group: route.group,
			subcommand: route.subcommand,
		} as ChatInputInteractionOptions;
	}

	protected dispatchSubcommandClass<C extends SlashCommandClass>(
		command: MockSubCommandClass,
		instance: SubCommand,
		classOptions?: SlashClassOptions<C>,
	): Dispatch<DispatchResult> {
		const route = this.subcommandRouteFor(command, instance, 'slash');
		if (route) return this.dispatchSlash(this.subcommandRouteOptions(route, classOptions));
		if (!this.lazyEnabled || this.loadedAllCommands) {
			return this.dispatchSlash(
				this.subcommandRouteOptions(this.requireSubcommandRoute(command, instance, 'slash'), classOptions),
			);
		}
		const user = this.resolveInvoker(classOptions ?? {});
		return this.dispatchDeferred(user, async () => {
			await this.ensureAllCommandsLoaded();
			const loadedRoute = this.requireSubcommandRoute(command, instance, 'slash');
			const options = this.subcommandRouteOptions(loadedRoute, classOptions);
			this.assertCommandRegistered(options.name, ApplicationCommandType.ChatInput, 'slash');
			const prepared = prepareChatInputOptions(this.client.commands.values, options, this.validateOptions);
			return chatInputInteraction(
				this.applyWorldPermissions({ applicationId: this.client.applicationId, ...prepared, user }),
			);
		});
	}

	protected dispatchSlash(options: ChatInputInteractionOptions): Dispatch<DispatchResult> {
		if (this.lazyEnabled && (!this.commandIsLoaded(options.name) || !this.chatInputSubcommandIsLoaded(options))) {
			const user = this.resolveInvoker(options);
			return this.dispatchDeferred(user, async () => {
				await this.ensureChatInputCommandLoaded(options);
				this.assertCommandRegistered(options.name, ApplicationCommandType.ChatInput, 'slash');
				const prepared = prepareChatInputOptions(this.client.commands.values, options, this.validateOptions);
				return chatInputInteraction(
					this.applyWorldPermissions({ applicationId: this.client.applicationId, ...prepared, user }),
				);
			});
		}
		this.assertCommandRegistered(options.name, ApplicationCommandType.ChatInput, 'slash');
		return this.dispatchVia(
			'slash',
			prepareChatInputOptions(this.client.commands.values, options, this.validateOptions),
			chatInputInteraction,
		);
	}

	autocomplete(options: AutocompleteInteractionOptions): Dispatch<AutocompleteResult> {
		this.assertOpen('autocomplete');
		const withChoices = (result: DispatchResult): AutocompleteResult => {
			const body = result.reply?.body;
			return { ...result, choices: body?.type === 8 ? body.data?.choices : undefined };
		};
		const buildPayload = (): ApiInteractionPayload => {
			this.assertCommandRegistered(options.name, ApplicationCommandType.ChatInput, 'autocomplete');
			const prepared = prepareAutocompleteOptions(this.client.commands.values, options, this.validateOptions);
			return autocompleteInteraction(
				this.applyWorldPermissions({ user: this.defaultUser, applicationId: this.client.applicationId, ...prepared }),
			);
		};
		if (this.lazyEnabled && (!this.commandIsLoaded(options.name) || !this.chatInputSubcommandIsLoaded(options))) {
			return this.dispatchDeferred<AutocompleteResult>(
				this.resolveInvoker(options),
				async () => {
					await this.ensureChatInputCommandLoaded(options);
					return buildPayload();
				},
				withChoices,
			);
		}
		const payload = buildPayload();
		const userId = payload.member?.user.id ?? payload.user?.id;
		const dispatchId = nextDispatchId();
		return this.track(
			new Dispatch(
				this.rest,
				this.client,
				userId,
				async () => withChoices(await this.runInteraction(payload, dispatchId)),
				(id, ownerDispatchId) => this.onModalRegistered(id, ownerDispatchId),
				dispatchId,
			),
		);
	}

	userMenu(options: UserCommandInteractionOptions): Dispatch<UserMenuResult> {
		const build = (prepared: UserCommandInteractionOptions): ApiInteractionPayload => {
			const targetMember = options.targetMember ?? this.worldMemberFor(prepared.guildId, prepared.target);
			return userCommandInteraction({ ...prepared, ...(targetMember ? { targetMember } : {}) });
		};
		if (this.lazyEnabled && !this.commandIsLoaded(options.name)) {
			return this.lazyMenuDispatch(options, ApplicationCommandType.User, 'userMenu', build) as Dispatch<UserMenuResult>;
		}
		this.assertCommandRegistered(options.name, ApplicationCommandType.User, 'userMenu');
		return this.dispatchVia<UserCommandInteractionOptions, UserMenuResult>('userMenu', options, build);
	}

	messageMenu(options: MessageCommandInteractionOptions): Dispatch<MessageMenuResult> {
		const build = (prepared: MessageCommandInteractionOptions): ApiInteractionPayload => {
			const targetMember = options.targetMember ?? this.worldMemberFor(prepared.guildId, prepared.target?.author);
			return messageCommandInteraction({ ...prepared, ...(targetMember ? { targetMember } : {}) });
		};
		if (this.lazyEnabled && !this.commandIsLoaded(options.name)) {
			return this.lazyMenuDispatch(
				options,
				ApplicationCommandType.Message,
				'messageMenu',
				build,
			) as Dispatch<MessageMenuResult>;
		}
		this.assertCommandRegistered(options.name, ApplicationCommandType.Message, 'messageMenu');
		return this.dispatchVia<MessageCommandInteractionOptions, MessageMenuResult>('messageMenu', options, build);
	}

	/** Lazy counterpart of {@link dispatchVia} for the context-menu dispatchers: load the command, then build. */
	protected lazyMenuDispatch<O extends BaseInteractionOptions>(
		options: O & { name: string },
		type: ApplicationCommandType,
		verb: string,
		build: (prepared: O) => ApiInteractionPayload,
	): Dispatch<DispatchResult> {
		const user = this.resolveInvoker(options);
		return this.dispatchDeferred(user, async () => {
			await this.ensureCommandLoaded(options.name);
			this.assertCommandRegistered(options.name, type, verb);
			const prepared = this.applyWorldPermissions({ applicationId: this.client.applicationId, ...options, user });
			return build(prepared);
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
			// Auto-synthesize when no source resolves but a ComponentCommand could handle this customId (incl.
			// RegExp/filter handlers) — unambiguous (no message ⇒ no live collector), so no flag needed.
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
		fields: ModalFields = {},
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

	protected emitGatewayEvent(
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

	protected emitCustom(
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

	protected applyWorldEvent(name: string, d: Record<string, unknown>): void {
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
	protected eventHandlerRan(name: string): boolean {
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
