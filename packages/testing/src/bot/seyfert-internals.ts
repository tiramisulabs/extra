import type { Client, UsingClient } from 'seyfert';
import { isGatewayEventName, normalizeEventName } from 'seyfert/lib/events/utils';

/*
 * The mock bot drives a REAL seyfert Client, which means it reaches into a handful of seyfert internals that are
 * not part of seyfert's public type surface: component/modal handler hooks, the middleware registry, event
 * plumbing, and the plugin/lang lifecycle. Those `as unknown as {...}` casts live HERE, in one module, so a
 * seyfert version bump has a single blast radius — and `test/bot/seyfert-internals.test.mts` boots a fresh Client
 * and asserts every member below still exists, turning a silent peer-break into a loud, located test failure.
 *
 * CONTRACT: each accessor's return type names exactly the internal members the package depends on. If seyfert
 * renames or moves one, update it here and the contract test will point at the gap.
 */

/** The per-user modal registry (seyfert keys the `interaction.modal({ waitFor })` callback by user id). */
export interface ModalRegistry {
	has(key: string): boolean;
	get(key: string): ((interaction: unknown) => unknown) | undefined;
	set(key: string, value: unknown): unknown;
	delete(key: string): unknown;
	clear(): void;
	keys(): IterableIterator<string>;
}

/** The component handler's overridable hooks the mock wraps to detect component/collector/modal matches. */
export interface ComponentInternals {
	execute?: (...args: unknown[]) => Promise<unknown>;
	onComponent?: (id: string, interaction: { customId: string }) => Promise<unknown>;
	hasComponent?: (id: string, customId: string) => boolean | undefined;
	onModalSubmit?: (interaction: { user: { id: string } }) => unknown;
	values: Map<string, unknown>;
	modals: ModalRegistry;
}

/** The events handler internals the mock reads for emitEvent fail-loud + event-error capture. */
export interface EventsInternals {
	values: Record<string, { data: { once?: boolean }; fired?: boolean } | undefined>;
	getPluginListeners(name: string): unknown[];
	getPluginAnyListeners(): unknown[];
	reportEventFailure?: (name: string, error: unknown) => unknown;
}

/** Construction-time plugin/lang lifecycle the mock must drive by hand (not exposed publicly by seyfert). */
export interface ClientLifecycleInternals {
	setupPlugins(): Promise<void>;
	refreshPluginContributions(): void;
	reloadPluginCommands(): Promise<void>;
	reloadPluginComponents(): Promise<void>;
	reloadPluginContributions(): Promise<void>;
	langBaseValues: unknown;
}

export function componentInternals(client: Client): ComponentInternals {
	return client.components as unknown as ComponentInternals;
}

export function modalRegistry(client: Client): ModalRegistry {
	return client.components.modals as unknown as ModalRegistry;
}

export function eventsInternals(client: Client): EventsInternals {
	return client.events as unknown as EventsInternals;
}

/** Active named plugin event listeners, normalized to the gateway UPPER_SNAKE the events handler keys on. */
export function pluginEventNames(client: Client): string[] {
	const registry = (client as unknown as { pluginRegistry?: { events?: { name: string; active?: boolean }[] } })
		.pluginRegistry;
	return (registry?.events ?? [])
		.filter(listener => listener.active)
		.map(listener => normalizeEventName(listener.name));
}

export function normalizeGatewayEventName(name: string): string | undefined {
	return isGatewayEventName(name) ? normalizeEventName(name) : undefined;
}

export function clientLifecycle(client: Client): ClientLifecycleInternals {
	return client as unknown as ClientLifecycleInternals;
}

/** Seed a fresh world into the client cache — `seedWorld` needs the `UsingClient` cache/rest surface. */
export function asUsingClient(client: Client): UsingClient {
	return client as unknown as UsingClient;
}
