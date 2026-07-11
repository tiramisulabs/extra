import { Client, type Command, type ContextMenuCommand, type EntryPointCommand } from 'seyfert';
import { type RouteMatcher } from './rest';
import { Routes } from './routes';

export * from './contracts';
export { Dispatch } from './dispatch';
export { WORLD_EVENT_NAMES } from './world-events';

export type ClientConstructorOptions = ConstructorParameters<typeof Client>[0];
export type ClientOptions = NonNullable<ClientConstructorOptions>;

/** Upper bound on drain loop iterations: terminates the loop even when Date.now() is frozen by fake timers. */
export const DRAIN_MAX_ITERATIONS = 1000;

/**
 * Capture the real setImmediate at module load so a drain tick can yield a macrotask even after the user has
 * faked global timers (vi.useFakeTimers() replaces globalThis.setImmediate). If the runtime has no
 * setImmediate, fall through to a microtask yield.
 */
export const capturedSetImmediate: typeof setImmediate | undefined =
	typeof setImmediate === 'function' ? setImmediate : undefined;
export const realSetImmediate: typeof setImmediate | undefined = capturedSetImmediate
	? capturedSetImmediate.bind(globalThis)
	: undefined;

/**
 * Entity-create routes for {@link MockBot.created}, mapping a friendly resource name to the POST route that
 * creates it. `message` is a direct channel send (`POST /channels/:id/messages`), NOT an interaction reply —
 * for those query {@link Routes.editOriginalResponse}/`followup`.
 */
export const CREATE_ROUTES = {
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
export function drainTick(): Promise<void> {
	if (realSetImmediate) return new Promise<void>(resolve => realSetImmediate(() => resolve()));
	return Promise.resolve();
}

/**
 * Fail fast if the global setImmediate the drain relies on has been faked since module load. vi.useFakeTimers()
 * with its default toFake replaces globalThis.setImmediate, which deadlocks {@link drainTick} (it would spin to
 * the iteration cap and return non-quiescent). Only trips when a real setImmediate was captured at load and the
 * current global no longer matches it; on runtimes without setImmediate the guard is skipped.
 */
export function assertRealSetImmediate(): void {
	if (!capturedSetImmediate) return;
	if (globalThis.setImmediate === capturedSetImmediate) return;
	throw new Error(
		'advanceTime/flushPending: global setImmediate has been replaced by fake timers, which deadlocks the ' +
			"mock's async drain. Fake only the timers seyfert uses: " +
			"vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }).",
	);
}

export interface SubcommandClassRoute {
	commandClass: Function;
	parentName: string;
	group?: string;
	subcommand: string;
}

export type CommandRuntime = (Command | ContextMenuCommand | EntryPointCommand) & {
	__filePath?: string;
	__autoload?: true;
	name: string;
	type: number;
	options?: unknown[];
};
