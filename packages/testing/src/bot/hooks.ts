import type { Client } from 'seyfert';
import type { ModalWaiter } from './dispatch';
import { dispatchStore } from './dispatch-context';
import type { InputCheckpoint } from './interaction-session';
import { type ComponentCollectorMatch, componentInternals, modalRegistry } from './seyfert-internals';

type MiddlewareControl = (...args: unknown[]) => unknown;
interface MiddlewareControls {
	context: unknown;
	next: MiddlewareControl;
	stop: MiddlewareControl;
}
type WrappedMiddleware = (controls: MiddlewareControls) => unknown;

interface PermissionGuardedCommand {
	onPermissionsFail?: (context: unknown, missing: unknown) => unknown;
	onBotPermissionsFail?: (context: unknown, missing: unknown) => unknown;
	options?: unknown[];
}

/** Seyfert passes the missing permissions as a string[] of flag names; normalize anything else to undefined. */
function toPermissionNames(missing: unknown): string[] | undefined {
	if (Array.isArray(missing) && missing.every(name => typeof name === 'string')) return missing as string[];
	return undefined;
}

function stableCollectorMatch(match: ComponentCollectorMatch): ComponentCollectorMatch {
	if (!(match instanceof RegExp) || (!match.global && !match.sticky)) return match;
	return new RegExp(match.source, match.flags.replace(/[gy]/g, ''));
}

/** Component/modal detection capabilities, fixed at install time from the client's component surface. */
export interface DispatchHookCapabilities {
	canDetectComponentCommand: boolean;
	canDetectCollector: boolean;
	canDetectComponentWait: boolean;
	canDetectModalCollector: boolean;
}

export interface DispatchHookDeps {
	/** Pending modal waiters keyed by userId; resolved when seyfert registers a modal via components.modals.set. */
	modalWaiters: Map<string, ModalWaiter[]>;
	/** Dispatch that owns the currently registered waitFor modal for a user. */
	modalOwners: Map<string, number>;
	/** Drain the given dispatch's REST surface until quiescent or aborted. */
	drainUntilQuiescent: (dispatchId: number | undefined, aborted: () => boolean) => Promise<void>;
	/** Snapshot the modal definition just displayed to userId, so submitModal can validate customId/fields. */
	onModalDisplayed?: (userId: string, dispatchId: number | undefined) => string | undefined;
	/** Clear ownership when the registered modal callback is explicitly resolved with null (raw timeout seam). */
	onModalTimedOut?: (userId: string, dispatchId: number | undefined) => void;
	/** Publish a real user-input checkpoint to the stateful session coordinator. */
	onCheckpoint?: (checkpoint: InputCheckpoint) => void;
	/** Remove a checkpoint after its underlying wait settles by input or timeout. */
	onCheckpointSettled?: (checkpoint: InputCheckpoint) => void;
}

interface DispatchHookInstallState {
	deps: DispatchHookDeps;
	capabilities: DispatchHookCapabilities;
	closing: boolean;
	pendingComponentWaits: Set<{
		messageId: string;
		ownerDispatchId?: number;
		cancel(): void;
	}>;
}

const dispatchHookInstalls = new WeakMap<Client, DispatchHookInstallState>();
const middlewareHookFunctions = new WeakMap<Client, WeakSet<WrappedMiddleware>>();
const permissionHookCommands = new WeakMap<Client, WeakSet<object>>();

/**
 * Install the component/middleware wrappers ONCE on the shared client singletons. Each wrapper reads the
 * active dispatch via AsyncLocalStorage (dispatchStore.getStore()) instead of closing over per-dispatch
 * call-local flags, so concurrent dispatches never clobber each other's resolution state.
 *
 * @internal Called once by createMockBot after setup; not part of the public surface.
 */
export function installDispatchHooks(client: Client, deps: DispatchHookDeps): DispatchHookCapabilities {
	const existing = dispatchHookInstalls.get(client);
	if (existing) {
		existing.deps = deps;
		existing.closing = false;
		existing.pendingComponentWaits.clear();
		installMiddlewareDenialHooks(client, existing);
		installPermissionDenialHooks(client);
		return existing.capabilities;
	}

	const componentHooks = componentInternals(client);
	const canDetectComponentCommand = typeof componentHooks.execute === 'function';
	const canDetectCollector =
		typeof componentHooks.onComponent === 'function' && typeof componentHooks.hasComponent === 'function';
	const canDetectComponentWait = typeof componentHooks.createComponentCollector === 'function';
	const canDetectModalCollector = typeof componentHooks.onModalSubmit === 'function';
	const state: DispatchHookInstallState = {
		deps,
		closing: false,
		pendingComponentWaits: new Set(),
		capabilities: {
			canDetectComponentCommand,
			canDetectCollector,
			canDetectComponentWait,
			canDetectModalCollector,
		},
	};
	dispatchHookInstalls.set(client, state);

	if (canDetectComponentCommand) {
		const execute = componentHooks.execute?.bind(componentHooks);
		componentHooks.execute = async (...args: unknown[]) => {
			const ctx = dispatchStore.getStore();
			if (ctx) ctx.componentCommandExecuted = true;
			return execute?.(...args);
		};
	}
	if (canDetectCollector) {
		const onComponent = componentHooks.onComponent?.bind(componentHooks);
		componentHooks.onComponent = (id, interaction) => onComponent?.(id, interaction) ?? Promise.resolve();
	}
	if (canDetectComponentWait) {
		const createComponentCollector = componentHooks.createComponentCollector?.bind(componentHooks);
		componentHooks.createComponentCollector = (messageId, channelId, guildId, options, components) => {
			// Seyfert replaces same-message collector state with Map#set without clearing the previous timers.
			// Clear the unreachable collector first so its idle/timeout handles cannot fire into the replacement.
			if (componentHooks.values.has(messageId)) {
				for (const pending of [...state.pendingComponentWaits]) {
					if (pending.messageId === messageId) pending.cancel();
				}
				componentHooks.clearValue(messageId);
			}
			const collector = createComponentCollector?.(messageId, channelId, guildId, options, components);
			if (!collector) {
				throw new TypeError('Seyfert createComponentCollector returned no collector handle.');
			}
			if (state.closing) componentHooks.clearValue(messageId);
			const run = collector.run.bind(collector);
			collector.run = (match, callback) => {
				run(stableCollectorMatch(match), (...args: unknown[]) => {
					const ctx = dispatchStore.getStore();
					if (ctx) ctx.collectorMatched = true;
					return callback(...args);
				});
			};
			const waitFor = collector.waitFor.bind(collector);
			collector.waitFor = (match, timeout) => {
				// Seyfert registers the matcher synchronously inside waitFor's Promise executor. Call it first,
				// then publish the checkpoint: a render by itself is not enough to declare the flow actionable.
				const row = componentHooks.values.get(messageId);
				const before = new Set(row?.components ?? []);
				const registeredMatch = stableCollectorMatch(match);
				const waiting = waitFor(registeredMatch, timeout);
				const component = row?.components.find(candidate => !before.has(candidate));
				if (component) {
					const callback = component.callback;
					component.callback = (interaction, ...args) => {
						const ctx = dispatchStore.getStore();
						if (ctx) ctx.collectorMatched = true;
						return callback(interaction, ...args);
					};
				}
				const ownerDispatchId = dispatchStore.getStore()?.dispatchId;
				const pending = component
					? {
							messageId,
							...(ownerDispatchId === undefined ? {} : { ownerDispatchId }),
							cancel: () => {
								component.callback(null);
							},
						}
					: undefined;
				if (pending) state.pendingComponentWaits.add(pending);
				if (ownerDispatchId !== undefined && component && !state.closing) {
					const checkpoint: InputCheckpoint = {
						kind: 'component',
						ownerDispatchId,
						messageId,
						channelId,
						...(guildId === undefined ? {} : { guildId }),
						match: registeredMatch,
					};
					state.deps.onCheckpoint?.(checkpoint);
					const onCheckpointSettled = state.deps.onCheckpointSettled;
					void waiting.then(
						() => {
							if (pending) state.pendingComponentWaits.delete(pending);
							onCheckpointSettled?.(checkpoint);
						},
						() => {
							if (pending) state.pendingComponentWaits.delete(pending);
							onCheckpointSettled?.(checkpoint);
						},
					);
				} else if (pending) {
					void waiting.then(
						() => state.pendingComponentWaits.delete(pending),
						() => state.pendingComponentWaits.delete(pending),
					);
				}
				if (state.closing) pending?.cancel();
				return waiting;
			};
			return collector;
		};
	}
	if (canDetectModalCollector) {
		const onModalSubmit = componentHooks.onModalSubmit?.bind(componentHooks);
		componentHooks.onModalSubmit = interaction => {
			const ctx = dispatchStore.getStore();
			if (ctx) ctx.modalMatched = true;
			return onModalSubmit?.(interaction);
		};
	}
	// Modal registration signal: seyfert's ctx.interaction.modal() calls components.modals.set(userId, exec)
	// synchronously while replying. Wrap set() ONCE so any pending untilModal() waiter for that user resolves
	// the instant the modal is registered — event-driven, no wall-clock poll.
	const modals = modalRegistry(client);
	const realSet = modals.set.bind(modals);
	modals.set = (key: string, value: unknown) => {
		const ctx = dispatchStore.getStore();
		const ownerId = ctx?.dispatchId;
		const storedValue =
			typeof value === 'function'
				? (interaction: unknown) => {
						if (interaction === null) {
							modals.delete(key);
							state.deps.onModalTimedOut?.(key, ownerId);
						}
						return (value as (input: unknown) => unknown)(interaction);
					}
				: value;
		if (state.closing) {
			const result = realSet(key, storedValue);
			if (ownerId !== undefined) state.deps.modalOwners.set(key, ownerId);
			if (typeof storedValue === 'function') storedValue(null);
			return result;
		}
		const existingOwner = state.deps.modalOwners.get(key);
		if (modals.has(key) && existingOwner !== undefined && existingOwner !== ownerId) {
			throw new TypeError(
				`A modal is already waiting for user ${key} from dispatch ${existingOwner}; ` +
					`dispatch ${ownerId ?? '(unknown)'} would overwrite it. Same-user modal flows must be driven sequentially.`,
			);
		}
		const waiters = state.deps.modalWaiters.get(key);
		if (waiters) {
			const matching = ownerId === undefined ? waiters : waiters.filter(waiter => waiter.dispatchId === ownerId);
			if (matching.length === 0) {
				throw new TypeError(
					`A modal was opened for user ${key} by dispatch ${ownerId ?? '(unknown)'}, but another dispatch is ` +
						`already waiting for that user's modal. Same-user modal flows must be driven sequentially.`,
				);
			}
			const result = realSet(key, storedValue);
			if (ownerId !== undefined) state.deps.modalOwners.set(key, ownerId);
			const customId = state.deps.onModalDisplayed?.(key, ownerId);
			state.deps.modalWaiters.delete(key);
			for (const waiter of matching) waiter.resolve();
			if (ownerId !== undefined) {
				state.deps.onCheckpoint?.({
					kind: 'modal',
					ownerDispatchId: ownerId,
					userId: key,
					...(customId === undefined ? {} : { customId }),
				});
			}
			return result;
		}
		if (ctx?.sessionKey === undefined) {
			throw new TypeError(
				`A modal was opened for user ${key} from a raw dispatch, but nothing is driving it. ` +
					'Use `await raw.submitModal(customId, fields)` or `await raw.timeoutModal()`.',
			);
		}
		const result = realSet(key, storedValue);
		if (ownerId !== undefined) state.deps.modalOwners.set(key, ownerId);
		const customId = state.deps.onModalDisplayed?.(key, ownerId);
		if (ownerId !== undefined) {
			state.deps.onCheckpoint?.({
				kind: 'modal',
				ownerDispatchId: ownerId,
				userId: key,
				...(customId === undefined ? {} : { customId }),
			});
		}
		return result;
	};
	installMiddlewareDenialHooks(client, state);
	installPermissionDenialHooks(client);

	return state.capabilities;
}

/**
 * Put the client's input hooks into shutdown mode, cancel every live input timer, and return the dispatches
 * whose natural null/timeout continuations must be awaited before registries are cleared.
 */
export function beginInputShutdown(client: Client): Set<number> {
	const state = dispatchHookInstalls.get(client);
	if (!state) return new Set();
	state.closing = true;

	const owners = new Set<number>();
	for (const pending of [...state.pendingComponentWaits]) {
		if (pending.ownerDispatchId !== undefined) owners.add(pending.ownerDispatchId);
		pending.cancel();
	}

	const modals = modalRegistry(client);
	for (const userId of [...modals.keys()]) {
		const ownerDispatchId = state.deps.modalOwners.get(userId);
		if (ownerDispatchId !== undefined) owners.add(ownerDispatchId);
		modals.get(userId)?.(null);
	}

	const components = componentInternals(client);
	for (const messageId of [...components.values.keys()]) components.clearValue(messageId);
	return owners;
}

/** Re-enable input registration after an awaited reset. Close intentionally leaves shutdown mode enabled. */
export function endInputShutdown(client: Client): void {
	const state = dispatchHookInstalls.get(client);
	if (state) state.closing = false;
}

function installMiddlewareDenialHooks(client: Client, state: DispatchHookInstallState): void {
	const middlewares = client.middlewares as Record<string, WrappedMiddleware> | undefined;
	if (!middlewares) return;
	let wrapped = middlewareHookFunctions.get(client);
	if (!wrapped) {
		wrapped = new WeakSet<WrappedMiddleware>();
		middlewareHookFunctions.set(client, wrapped);
	}
	for (const key of Object.keys(middlewares)) {
		const real = middlewares[key];
		if (wrapped.has(real)) continue;
		const wrapper: WrappedMiddleware = controls => {
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
			// stop(reason) is a denial; stop() is Seyfert v5's silent-skip form. Both terminate the
			// chain, so expose the public control that actually ran and preserve its optional reason.
			const stop: MiddlewareControl = (...args) => {
				if (ctx) ctx.denial = { kind: 'stop', reason: args[0], middleware: key };
				progressed = true;
				return controls.stop(...args);
			};
			const result = real({
				...controls,
				next: mark(controls.next),
				stop,
			});
			Promise.resolve(result).then(
				() => {
					if (progressed) return;
					// The middleware denied (replied + returned without next/stop). Its reply may still be
					// recording through async REST hops, so don't settle after a single tick. Drain until this
					// dispatch's REST surface is quiescent: action count stable across a tick AND none in flight.
					if (ctx && !ctx.denial) ctx.denial = { kind: 'no-next', middleware: key };
					void state.deps
						.drainUntilQuiescent(ctx?.dispatchId, () => progressed)
						.then(() => {
							if (!progressed) ctx?.resolveDenial?.();
						});
				},
				() => {},
			);
			return result;
		};
		wrapped.add(real);
		wrapped.add(wrapper);
		middlewares[key] = wrapper;
		const installed = (
			client as unknown as {
				pluginRegistry?: { installedMiddlewares?: Map<string, { middleware: WrappedMiddleware }> };
			}
		).pluginRegistry?.installedMiddlewares;
		const entry = installed?.get(key);
		if (entry?.middleware === real) entry.middleware = wrapper;
	}
}

/**
 * Seyfert checks `defaultMemberPermissions` / `botPermissions` BEFORE the middleware chain and, on failure,
 * calls the command's own `onPermissionsFail` / `onBotPermissionsFail` and returns — `run` is never reached.
 * These are command-instance methods (optional), so we wrap each command (and its subcommands) to record a
 * structured permissions denial. The original hook still fires, so existing copy-based assertions keep working.
 */
function installPermissionDenialHooks(client: Client): void {
	let wrapped = permissionHookCommands.get(client);
	if (!wrapped) {
		wrapped = new WeakSet<object>();
		permissionHookCommands.set(client, wrapped);
	}
	const wrap = (command: PermissionGuardedCommand): void => {
		if (wrapped.has(command)) return;
		wrapped.add(command);
		const real = {
			onPermissionsFail: command.onPermissionsFail,
			onBotPermissionsFail: command.onBotPermissionsFail,
		};
		command.onPermissionsFail = function (this: unknown, context: unknown, missing: unknown) {
			const ctx = dispatchStore.getStore();
			if (ctx) ctx.denial = { kind: 'permissions', missing: toPermissionNames(missing) };
			return real.onPermissionsFail?.call(this, context, missing);
		};
		command.onBotPermissionsFail = function (this: unknown, context: unknown, missing: unknown) {
			const ctx = dispatchStore.getStore();
			if (ctx) ctx.denial = { kind: 'bot-permissions', missing: toPermissionNames(missing) };
			return real.onBotPermissionsFail?.call(this, context, missing);
		};
		for (const option of command.options ?? []) {
			if (option && typeof option === 'object' && 'run' in option) wrap(option as PermissionGuardedCommand);
		}
	};
	for (const command of client.commands.values as unknown as PermissionGuardedCommand[]) wrap(command);
}
