import { Command, type CommandContext, ComponentCommand, type ComponentContext, createPlugin, Declare } from 'seyfert';
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

	test('registeredEvents() includes events a plugin listens to, not just Event classes', async () => {
		const plugin = createPlugin({
			name: 'slipher-event-plugin',
			register(api) {
				api.events.on('messageCreate', () => {});
			},
		});
		const bot = await createMockBot({ plugins: [plugin] });
		expect(bot.registeredEvents()).toContain('MESSAGE_CREATE');
		await bot.close();
	});

	test('createMockBot drives plugin startup hooks without opening the gateway', async () => {
		const calls: string[] = [];
		const readyClients: unknown[] = [];

		@Declare({ name: 'lifecycle-ping', description: 'Lifecycle ping' })
		class LifecyclePingCommand extends Command {
			async run(ctx: CommandContext) {
				await ctx.write({ content: 'pong' });
			}
		}

		class LifecycleButton extends ComponentCommand {
			componentType = 'Button' as const;
			filter(ctx: ComponentContext<'Button'>) {
				return ctx.customId === 'lifecycle-button';
			}
			async run(ctx: ComponentContext<'Button'>) {
				await ctx.write({ content: 'clicked' });
			}
		}

		const plugin = createPlugin({
			name: 'slipher-startup-hooks',
			register(api) {
				api.hooks.tap('plugins:ready', client => {
					readyClients.push(client);
					calls.push('plugins:ready');
				});
				api.hooks.tap('commands:beforeLoad', (_client, dir) => {
					calls.push(`commands:beforeLoad:${dir ?? '<none>'}`);
				});
				api.hooks.tap('commands:afterLoad', metadata => {
					calls.push(`commands:afterLoad:${metadata.total}`);
				});
				api.hooks.tap('components:afterLoad', metadata => {
					calls.push(`components:afterLoad:${metadata.total}`);
				});
			},
		});

		const bot = await createMockBot({
			plugins: [plugin],
			commands: [LifecyclePingCommand],
			components: [LifecycleButton],
		});

		expect(readyClients).toEqual([bot.client]);
		expect(calls).toEqual([
			'plugins:ready',
			'commands:beforeLoad:<none>',
			'commands:afterLoad:1',
			'components:afterLoad:1',
		]);
		expect(bot.gateway.sent).toEqual([]);
		const result = await bot.slash({ name: 'lifecycle-ping' });
		expect(result.content).toBe('pong');
		await bot.close();
	});
});
