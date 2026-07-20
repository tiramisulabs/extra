import { type APIInteractionResponse, ApplicationCommandType, InteractionType, SubCommand } from 'seyfert';
import { type FileLoadingHandler, pathIsInsideDir } from './bootstrap';
import type { CommandRuntime, CreatedResource } from './bot-support';
import { assertRealSetImmediate, CREATE_ROUTES, DRAIN_MAX_ITERATIONS, drainTick } from './bot-support';
import { actionRendersComponent } from './component-tree';
import {
	type BotDiagnostics,
	type DispatchResult,
	INTERACTION_WEBHOOK_ROUTES,
	type RawModalSubmitOptions,
} from './contracts';
import { Dispatch, type ModalWaiter, type ModalWaitRegistration } from './dispatch';
import { nextDispatchId } from './dispatch-context';
import { installDispatchHooks as installDispatchHooksImpl } from './hooks';
import { type ApiInteractionPayload, type ChatInputInteractionOptions, type ModalFields } from './interactions';
import { MockBotSurface } from './mock-bot-surface';
import { CommandOptionType } from './option-validation';
import { type ApiMember, type ApiMessage, type ApiUser, apiUser } from './payloads';
import {
	type ActionFilter,
	type ActionMatcher,
	type ActionPredicate,
	type MatchedAction,
	type RecordedAction,
	type RouteActionFilter,
	type RouteMatcher,
	type TypedMatchedAction,
} from './rest';
import { Routes } from './routes';
import { renderedReply } from './state';

export abstract class MockBotDispatchCore extends MockBotSurface {
	protected abstract dispatchSubmitModal(
		customId: string,
		fields: ModalFields,
		options?: RawModalSubmitOptions,
	): Dispatch<DispatchResult>;
	protected abstract runInteraction(payload: ApiInteractionPayload, dispatchId: number): Promise<DispatchResult>;
	protected abstract snapshotInteraction(payload: ApiInteractionPayload, dispatchId: number): DispatchResult;

	protected performStep<T>(dispatch: Dispatch<T>, sessionKey?: string, resumedOwnerDispatchId?: number): Promise<T> {
		return this.sessions.perform(
			dispatch,
			sessionKey ?? this.sessions.keyForUser(dispatch.userId),
			resumedOwnerDispatchId,
		);
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
			.filter(dispatch => !dispatch.isSettled && !dispatch.isCompleted)
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

	/** Seed a vote on a poll answer (poll voters are not part of the message body), then read it via getAnswerVoters. */
	seedPollVote(channelId: string, messageId: string, answerId: number, userId: string): void {
		this._state.addPollVoter(channelId, messageId, answerId, userId);
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
	 * @internal Resolve when a modal is registered for `userId` via seyfert's `components.modals.set` (which the
	 * opener command calls synchronously while replying). Used by {@link Dispatch.untilModal} to await
	 * registration event-driven instead of polling a wall clock. Resolves immediately if already registered.
	 */
	protected onModalRegistered(userId: string, dispatchId: number | undefined): ModalWaitRegistration {
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
	 *
	 * Relation to an advanced raw `Dispatch`: the two are orthogonal. Awaiting the dispatch waits for the handler
	 * to return; `settle()` waits for detached background REST to quiesce across all dispatches. Stateful
	 * interaction methods already stop at real input checkpoints. Add `settle()` only when application code
	 * intentionally starts observable work without awaiting it.
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
	protected async drainWhile(
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

	protected async drainActions(dispatchId: number | undefined): Promise<void> {
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
	 *
	 * Note on collectors: a collector-level `{ timeout }`/`{ idle }` fires `onStop(reason)`, but seyfert does NOT
	 * resolve a pending bare `collector.waitFor(customId)` on that timeout — only a matching component or a
	 * per-call `waitFor(customId, ms)` timeout resolves it. So the abort-by-timeout branch lives in `onStop`, and
	 * a flow parked on a bare `waitFor` must NOT be awaited to completion (it would hang). Drive it: park with
	 * `dispatch.untilComponent(...)`, call `advanceTime(ms)`, then assert the `onStop` effects.
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

	/** Resolve the invoking user for a dispatch the same way {@link dispatchVia} does: explicit > id shorthand > default. */
	protected resolveInvoker(options: { user?: ApiUser; userId?: string }): ApiUser {
		return options.user ?? (options.userId !== undefined ? apiUser({ id: options.userId }) : this.defaultUser);
	}

	protected get lazyEnabled(): boolean {
		return this.lazyCommands !== undefined;
	}

	/** True once `name` is resolvable — already in the registry (lazily loaded or passed via `commands`) or all loaded. */
	protected commandIsLoaded(name: string): boolean {
		return this.loadedAllCommands || this.client.commands.values.some(command => command.name === name);
	}

	protected chatInputCommand(name: string): CommandRuntime | undefined {
		return this.client.commands.values.find(
			command => command.type === ApplicationCommandType.ChatInput && command.name === name,
		) as CommandRuntime | undefined;
	}

	protected chatInputSubcommandIsLoaded(
		options: Pick<ChatInputInteractionOptions, 'name' | 'group' | 'subcommand'>,
	): boolean {
		if (!options.subcommand) return true;
		const command = this.chatInputCommand(options.name);
		if (!Array.isArray(command?.options)) return false;
		return command.options.some(
			option =>
				option instanceof SubCommand &&
				option.name === options.subcommand &&
				(options.group ? option.group === options.group : !option.group),
		);
	}

	protected async ensureChatInputCommandLoaded(
		options: Pick<ChatInputInteractionOptions, 'name' | 'group' | 'subcommand'>,
	): Promise<void> {
		await this.ensureCommandLoaded(options.name, options.subcommand !== undefined);
		if (this.chatInputSubcommandIsLoaded(options)) return;
		if (!this.loadedAllCommands) await this.ensureAllCommandsLoaded();
	}

	/**
	 * Lazily load the command group that answers to `name`, serialized against other in-flight loads. Path-first:
	 * narrow the loader to files/dirs named `name` and reload — cheap, transforms only that group when the folder
	 * matches the command name. If that didn't surface `name` (folder ≠ @Declare name), fall back to a full scan
	 * once. Each load reuses seyfert's `loadCommands` (which resets the handler's values) and merges the result back
	 * onto the previously-loaded set, so groups accumulate across dispatches.
	 */
	protected ensureCommandLoaded(name: string, includeRootSiblings = false): Promise<void> {
		if (!this.lazyEnabled || this.commandIsLoaded(name)) return Promise.resolve();
		const next = this.lazyLoadLock.then(async () => {
			if (this.commandIsLoaded(name)) return;
			await this.lazyLoad(this.commandPathsFor(name, includeRootSiblings));
			if (this.client.commands.values.some(command => command.name === name)) return;
			if (this.loadedAllCommands) return;
			await this.lazyLoad();
			this.loadedAllCommands = true;
		});
		this.lazyLoadLock = next.then(
			() => {},
			() => {},
		);
		return next;
	}

	protected ensureAllCommandsLoaded(): Promise<void> {
		if (!this.lazyEnabled || this.loadedAllCommands) return Promise.resolve();
		const next = this.lazyLoadLock.then(async () => {
			if (this.loadedAllCommands) return;
			await this.lazyLoad();
			this.loadedAllCommands = true;
		});
		this.lazyLoadLock = next.then(
			() => {},
			() => {},
		);
		return next;
	}

	/**
	 * Candidate command files for a dispatch name. The path catalog expands non-root matches to their sibling files so
	 * Seyfert's @AutoLoad sees the parent and children in the same CommandHandler.load() batch.
	 */
	protected commandPathsFor(
		name: string,
		includeRootSiblings = false,
	): readonly string[] | ((path: string) => boolean) {
		if (this.commandCatalog) return this.commandCatalog.pathsForCommandName(name, includeRootSiblings);
		return path => {
			const segments = path.split(/[/\\]/);
			const base = (segments.at(-1) ?? '').replace(/\.[cm]?[jt]s$/, '');
			return segments.includes(name) || base === name;
		};
	}

	/** Reload commands through selected paths/filter, merging the freshly-loaded set onto what was already loaded. */
	protected async lazyLoad(pathsOrFilter?: readonly string[] | ((path: string) => boolean)): Promise<void> {
		const handler = this.client.commands as unknown as FileLoadingHandler & {
			filter: (path: string) => boolean;
			values: { name: string; type: number }[];
		};
		const previousFilter = handler.filter;
		const previousGetFiles = handler.getFiles;
		if (typeof pathsOrFilter === 'function') {
			handler.filter = pathsOrFilter;
		} else if (pathsOrFilter || this.commandCatalog) {
			const paths = pathsOrFilter ?? this.commandCatalog?.allPaths() ?? [];
			handler.filter = () => true;
			handler.getFiles = async dir => paths.filter(path => pathIsInsideDir(path, dir));
		} else {
			handler.filter = () => true;
		}
		const previous = [...handler.values];
		try {
			await this.client.loadCommands(this.lazyCommands?.commandsDir);
			const merged = new Map<string, { name: string; type: number }>();
			for (const command of previous) merged.set(`${command.type}:${command.name}`, command);
			for (const command of handler.values) merged.set(`${command.type}:${command.name}`, command);
			handler.values = [...merged.values()];
			this.refreshSubcommandRoutes();
		} finally {
			handler.filter = previousFilter;
			if (previousGetFiles) handler.getFiles = previousGetFiles;
			else delete handler.getFiles;
		}
	}

	/**
	 * Build and run a dispatch whose payload is produced asynchronously (used by lazy loading, where the command must
	 * be imported before its options can be resolved). Mirrors {@link dispatchInteraction}'s wiring — same dispatchId,
	 * modal/component awaiters — but takes the invoking user up front (known from the dispatch options) instead of
	 * deriving it from the not-yet-built payload, so raw `.submitModal` / `.untilComponent` work under lazy loading.
	 */
	protected dispatchDeferred<R = DispatchResult>(
		user: ApiUser | undefined,
		buildPayload: () => Promise<ApiInteractionPayload>,
		wrapResult?: (result: DispatchResult) => R,
	): Dispatch<R> {
		this.assertOpen('dispatch');
		const userId = user?.id;
		const dispatchId = nextDispatchId();
		let payload: ApiInteractionPayload | undefined;
		return this.track(
			new Dispatch<R>(
				this.rest,
				this.client,
				userId,
				async () => {
					payload = await buildPayload();
					const result = await this.runInteraction(payload, dispatchId);
					return (wrapResult ? wrapResult(result) : result) as R;
				},
				(id, ownerDispatchId) => this.onModalRegistered(id, ownerDispatchId),
				dispatchId,
				user ? (customId, fields) => this.dispatchSubmitModal(customId, fields, { user }) : undefined,
				id => this.modalOwners.delete(id),
				(customId, scopeId, execution, timeoutMs) =>
					this.awaitRenderedComponent(customId, scopeId, execution, timeoutMs),
				() => {
					if (!payload) {
						throw new TypeError('The deferred interaction has not built its payload yet.');
					}
					const result = this.snapshotInteraction(payload, dispatchId);
					return (wrapResult ? wrapResult(result) : result) as R;
				},
			),
		);
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
				user ? (customId, fields) => this.dispatchSubmitModal(customId, fields, { user }) : undefined,
				id => this.modalOwners.delete(id),
				(customId, scopeId, execution, timeoutMs) =>
					this.awaitRenderedComponent(customId, scopeId, execution, timeoutMs),
				() => this.snapshotInteraction(payload, dispatchId),
			),
		);
	}

	protected async awaitRenderedComponent(
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

	protected prepareGatewayEventPayload(name: string, d: Record<string, unknown>): Record<string, unknown> {
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

	protected materializeInteractionResponse(payload: ApiInteractionPayload, body: APIInteractionResponse): void {
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

	protected commandLeaf(payload: ApiInteractionPayload): DispatchResult['command'] {
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

	protected commandTarget(payload: ApiInteractionPayload): DispatchResult['target'] {
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
	protected async drainUntilQuiescent(
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

	protected async drainTokenUntilQuiescent(
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
			onModalTimedOut: (userId, dispatchId) => {
				if (this.modalOwners.get(userId) === dispatchId) this.modalOwners.delete(userId);
				this.displayedModals.delete(userId);
				this.sessions.discardModal(dispatchId, userId);
			},
			onCheckpoint: checkpoint => this.sessions.recordCheckpoint(checkpoint),
			onCheckpointSettled: checkpoint => this.sessions.discardCheckpoint(checkpoint),
		});
		this.canDetectComponentCommand = capabilities.canDetectComponentCommand;
		this.canDetectCollector = capabilities.canDetectCollector;
		this.canDetectComponentWait = capabilities.canDetectComponentWait;
		this.canDetectModalCollector = capabilities.canDetectModalCollector;
	}

	protected isInteractionWebhookActionFor(action: RecordedAction, applicationId: string, token: string): boolean {
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

	protected isInteractionCallbackActionFor(action: RecordedAction, token: string, interactionId?: string): boolean {
		const params = this.rest.matchRouteParams(Routes.interactionCallback, action);
		if (!params) return false;
		if (params.token !== token) return false;
		return interactionId === undefined || params.id === interactionId;
	}

	protected isInteractionAction(action: RecordedAction, payload: ApiInteractionPayload): boolean {
		return (
			this.isInteractionWebhookActionFor(action, payload.application_id, payload.token) ||
			this.isInteractionCallbackActionFor(action, payload.token, payload.id)
		);
	}
}
