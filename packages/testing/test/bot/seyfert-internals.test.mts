import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { clientLifecycle, componentInternals, eventsInternals, modalRegistry } from '../../src/bot/seyfert-internals';

// The mock bot reaches into seyfert internals that are not part of seyfert's public type surface (component
// hooks, modal registry, event plumbing, plugin/lang lifecycle). Those casts live in seyfert-internals.ts; this
// test boots a real Client and asserts each member still exists, so a seyfert version bump that renames or
// removes one fails HERE — loudly, at the named member — instead of silently degrading a fail-loud guard.
describe('seyfert internals contract', () => {
	test('the component/modal/event/lifecycle internals the package depends on exist on a real Client', async () => {
		const bot = await createMockBot({});
		const client = bot.client;

		const components = componentInternals(client);
		expect(
			typeof components.createComponentCollector,
			'client.components.createComponentCollector (stateful waitFor checkpoints)',
		).toBe('function');
		expect(typeof components.execute, 'client.components.execute (component-command detection)').toBe('function');
		expect(typeof components.onComponent, 'client.components.onComponent (collector detection)').toBe('function');
		expect(typeof components.hasComponent, 'client.components.hasComponent (collector detection)').toBe('function');
		expect(typeof components.onModalSubmit, 'client.components.onModalSubmit (modal-collector detection)').toBe(
			'function',
		);
		expect(typeof components.values?.clear, 'client.components.values (reset clears runtime collectors)').toBe(
			'function',
		);
		expect(
			typeof components.clearValue,
			'client.components.clearValue (close cancels collector idle/timeout handles)',
		).toBe('function');

		const modals = modalRegistry(client);
		for (const method of ['has', 'get', 'set', 'delete', 'clear', 'keys'] as const) {
			expect(typeof modals[method], `client.components.modals.${method} (modal registry)`).toBe('function');
		}

		const events = eventsInternals(client);
		expect(typeof events.values, 'client.events.values (emit handler lookup)').toBe('object');
		expect(typeof events.getPluginListeners, 'client.events.getPluginListeners').toBe('function');
		expect(typeof events.getPluginAnyListeners, 'client.events.getPluginAnyListeners').toBe('function');
		expect(typeof events.reportEventFailure, 'client.events.reportEventFailure (event-error capture)').toBe('function');

		const lifecycle = clientLifecycle(client);
		expect(typeof lifecycle.setupPlugins, 'client.setupPlugins (plugin lifecycle)').toBe('function');
		expect(typeof lifecycle.refreshPluginContributions, 'client.refreshPluginContributions (plugin lifecycle)').toBe(
			'function',
		);
		expect(typeof lifecycle.reloadPluginCommands, 'client.reloadPluginCommands (plugin lifecycle)').toBe('function');
		expect(typeof lifecycle.reloadPluginComponents, 'client.reloadPluginComponents (plugin lifecycle)').toBe(
			'function',
		);
		expect(typeof lifecycle.reloadPluginContributions, 'client.reloadPluginContributions (plugin lifecycle)').toBe(
			'function',
		);

		// Other internals the package writes/reads directly. middlewares is an optional keyed record (absent when
		// none registered — the package guards on that), so accept undefined but reject a shape change to non-object.
		expect(['object', 'undefined'], 'client.middlewares (denial detection wrapping)').toContain(
			typeof client.middlewares,
		);
		expect(typeof client.events.runEvent, 'client.events.runEvent (emit dispatch)').toBe('function');
		expect(typeof client.handleCommand?.interaction, 'client.handleCommand.interaction (dispatch entry)').toBe(
			'function',
		);

		// Surfaces the cacheStore()/asClientGateway() helpers index into during world seeding + setServices.
		expect(typeof client.cache, 'client.cache (world cache seeding via cacheStore)').toBe('object');
		expect(typeof client.gateway, 'client.gateway (MockGateway swapped via setServices)').toBe('object');

		await bot.close();
	});
});
