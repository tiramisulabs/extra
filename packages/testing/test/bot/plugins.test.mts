import { createPlugin } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';

/**
 * Minimal seyfert plugin used to prove the mock drives the real plugin lifecycle:
 * `setup` flips a flag and stamps a surface on the client; `teardown` flips a teardown flag.
 * Each test builds a fresh plugin so the flags are isolated.
 */
function makeTrackerPlugin() {
	const state = { setupRan: false, teardownRan: false };
	const plugin = createPlugin({
		name: 'slipher-test-tracker',
		setup(client) {
			state.setupRan = true;
			(client as unknown as Record<string, unknown>).trackerSurface = 'contributed-by-setup';
		},
		teardown() {
			state.teardownRan = true;
		},
	});
	return { plugin, state };
}

describe('plugins', () => {
	test('createMockBot({ plugins }) runs each plugin setup', async () => {
		const { plugin, state } = makeTrackerPlugin();
		const bot = await createMockBot({ plugins: [plugin] });
		expect(state.setupRan).toBe(true);
		expect((bot.client as unknown as Record<string, unknown>).trackerSurface).toBe('contributed-by-setup');
		await bot.close();
	});

	test('bot.plugins surfaces the loaded plugins', async () => {
		const { plugin } = makeTrackerPlugin();
		const bot = await createMockBot({ plugins: [plugin] });
		const names = bot.plugins.map(info => info.name);
		expect(names).toContain('slipher-test-tracker');
		const info = bot.plugins.find(entry => entry.name === 'slipher-test-tracker');
		expect(info?.plugin).toBe(plugin);
		await bot.close();
	});

	test('bot.plugins is empty when no plugins are passed', async () => {
		const bot = await createMockBot({});
		expect(bot.plugins).toEqual([]);
		await bot.close();
	});

	test('bot.close() drives plugin teardown', async () => {
		const { plugin, state } = makeTrackerPlugin();
		const bot = await createMockBot({ plugins: [plugin] });
		expect(state.teardownRan).toBe(false);
		await bot.close();
		expect(state.teardownRan).toBe(true);
	});

	test('bot.teardownPlugins() invokes teardown without closing the session first', async () => {
		const { plugin, state } = makeTrackerPlugin();
		const bot = await createMockBot({ plugins: [plugin] });
		await bot.teardownPlugins();
		expect(state.teardownRan).toBe(true);
		await bot.close();
	});

	test('clientOptions.plugins keeps working alongside the first-class option', async () => {
		const { plugin, state } = makeTrackerPlugin();
		const bot = await createMockBot({ clientOptions: { plugins: [plugin] } });
		expect(state.setupRan).toBe(true);
		expect(bot.plugins.map(info => info.name)).toContain('slipher-test-tracker');
		await bot.close();
	});
});
