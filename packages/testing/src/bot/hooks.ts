import type { Client } from 'seyfert';
import { dispatchStore } from './dispatch-context';

type MiddlewareControl = (...args: never[]) => unknown;
interface MiddlewareControls {
	context: unknown;
	next: MiddlewareControl;
	stop: MiddlewareControl;
	pass: MiddlewareControl;
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

/** Component/modal detection capabilities, fixed at install time from the client's component surface. */
export interface DispatchHookCapabilities {
	canDetectComponentCommand: boolean;
	canDetectCollector: boolean;
	canDetectModalCollector: boolean;
}

export interface DispatchHookDeps {
	/** Pending modal waiters keyed by userId; resolved when seyfert registers a modal via components.modals.set. */
	modalWaiters: Map<string, (() => void)[]>;
	/** Drain the given dispatch's REST surface until quiescent or aborted. */
	drainUntilQuiescent: (dispatchId: number | undefined, aborted: () => boolean) => Promise<void>;
}

/**
 * Install the component/middleware wrappers ONCE on the shared client singletons. Each wrapper reads the
 * active dispatch via AsyncLocalStorage (dispatchStore.getStore()) instead of closing over per-dispatch
 * call-local flags, so concurrent dispatches never clobber each other's resolution state.
 *
 * @internal Called once by createMockBot after setup; not part of the public surface.
 */
export function installDispatchHooks(client: Client, deps: DispatchHookDeps): DispatchHookCapabilities {
	const componentHooks = client.components as unknown as {
		execute?: (...args: unknown[]) => Promise<unknown>;
		onComponent?: (id: string, interaction: { customId: string }) => Promise<unknown>;
		hasComponent?: (id: string, customId: string) => boolean | undefined;
		onModalSubmit?: (interaction: { user: { id: string } }) => unknown;
	};
	const canDetectComponentCommand = typeof componentHooks.execute === 'function';
	const canDetectCollector =
		typeof componentHooks.onComponent === 'function' && typeof componentHooks.hasComponent === 'function';
	const canDetectModalCollector = typeof componentHooks.onModalSubmit === 'function';

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
		componentHooks.onComponent = async (id, interaction) => {
			const ctx = dispatchStore.getStore();
			if (ctx) ctx.collectorMatched = Boolean(componentHooks.hasComponent?.(id, interaction.customId));
			return onComponent?.(id, interaction);
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
	const modals = client.components.modals as unknown as {
		set: (key: string, value: unknown) => unknown;
	};
	const realSet = modals.set.bind(modals);
	modals.set = (key: string, value: unknown) => {
		const waiters = deps.modalWaiters.get(key);
		if (waiters) {
			const result = realSet(key, value);
			deps.modalWaiters.delete(key);
			for (const resolve of waiters) resolve();
			return result;
		}
		// F27: a `waitFor` modal was opened but nothing is waiting to fill it — the opener dispatch was awaited
		// directly instead of stepped. Awaiting it would stall on the real waitFor timer and silently take the
		// timeout branch. Fail loud instead of hanging. (Fire-and-forget modals never reach here — only the
		// suspending `interaction.modal(body, { waitFor })` form registers via modals.set.)
		throw new TypeError(
			`A modal was opened for user ${key} but the opener was awaited directly, so nothing resolved it. ` +
				'Submit it: `await bot.clickButton(...).fillModal(customId, fields)`, ' +
				'or take its timeout branch: `await bot.clickButton(...).timeoutModal()`.',
		);
	};
	// Denial detection: seyfert's __runMiddlewares only resolves on next()/stop()/pass(). A guard that
	// replies and returns without calling any of them leaves the chain pending forever, so command.run is
	// structurally never reached and handleCommand.interaction never settles. Wrap each middleware to notice
	// when it terminates the chain and settle the dispatch with whatever was already captured.
	const middlewares = client.middlewares as Record<string, WrappedMiddleware> | undefined;
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
				// stop(reason) terminates the chain and routes through onMiddlewaresError: record it as a
				// structured 'stop' denial, capturing the reason argument, before delegating.
				const stop: MiddlewareControl = (...args) => {
					if (ctx) ctx.denial = { kind: 'stop', reason: args[0], middleware: key };
					progressed = true;
					return controls.stop(...args);
				};
				// pass() short-circuits the chain so command.run is skipped — a distinct outcome from a normal
				// success. Record it as a structured 'pass' denial (denied=true) so a test can assert the gate
				// skipped the command, instead of it collapsing into the success shape.
				const pass: MiddlewareControl = (...args) => {
					if (ctx) ctx.denial = { kind: 'pass', middleware: key };
					progressed = true;
					return controls.pass(...args);
				};
				const result = real({
					...controls,
					next: mark(controls.next),
					stop,
					pass,
				});
				Promise.resolve(result).then(
					() => {
						if (progressed) return;
						// The middleware denied (replied + returned without next/stop/pass). Its reply may still be
						// recording through async REST hops, so don't settle after a single tick. Drain until this
						// dispatch's REST surface is quiescent: action count stable across a tick AND none in flight.
						if (ctx && !ctx.denial) ctx.denial = { kind: 'no-next', middleware: key };
						void deps
							.drainUntilQuiescent(ctx?.dispatchId, () => progressed)
							.then(() => {
								if (!progressed) ctx?.resolveDenial?.();
							});
					},
					() => {},
				);
				return result;
			};
		}
	}
	installPermissionDenialHooks(client);

	return { canDetectComponentCommand, canDetectCollector, canDetectModalCollector };
}

/**
 * Seyfert checks `defaultMemberPermissions` / `botPermissions` BEFORE the middleware chain and, on failure,
 * calls the command's own `onPermissionsFail` / `onBotPermissionsFail` and returns — `run` is never reached.
 * These are command-instance methods (optional), so we wrap each command (and its subcommands) to record a
 * structured permissions denial. The original hook still fires, so existing copy-based assertions keep working.
 */
function installPermissionDenialHooks(client: Client): void {
	const wrapped = new WeakSet<object>();
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
