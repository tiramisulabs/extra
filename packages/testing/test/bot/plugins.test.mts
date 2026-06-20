import {
	Command,
	type CommandContext,
	ComponentCommand,
	type ComponentContext,
	ContextMenuCommand,
	createMiddleware,
	createPlugin,
	createSharedKey,
	Declare,
	EntryPointCommand,
	type MenuCommandContext,
	ModalCommand,
	type ModalContext,
	type UserCommandInteraction,
} from 'seyfert';
import { ApplicationCommandType, EntryPointCommandHandlerType } from 'seyfert/lib/types';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { apiUser } from '../../src/bot/payloads';

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

function pluginCtxValue(ctx: unknown): string {
	return (ctx as { pluginCtxValue: string }).pluginCtxValue;
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

	test('clientOptions does not load plugins', async () => {
		const { plugin, state } = makeTrackerPlugin();
		// @ts-expect-error plugin loading must use createMockBot({ plugins }).
		const bot = await createMockBot({ clientOptions: { plugins: [plugin] } });
		expect(state.setupRan).toBe(false);
		expect(bot.plugins).toEqual([]);
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
				api.hooks.on('plugins:ready', client => {
					readyClients.push(client);
					calls.push('plugins:ready');
				});
				api.hooks.on('commands:beforeLoad', (_client, dir) => {
					calls.push(`commands:beforeLoad:${dir ?? '<none>'}`);
				});
				api.hooks.on('commands:afterLoad', metadata => {
					calls.push(`commands:afterLoad:${metadata.total}`);
				});
				api.hooks.on('components:afterLoad', metadata => {
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

	test('plugin shared values are lazy, cached, and disposed on close', async () => {
		const containerKey = createSharedKey<{ id: string; createdAt: number }>()('slipher-test-container');
		let factories = 0;
		const disposed: string[] = [];
		const plugin = createPlugin({
			name: 'slipher-shared-provider',
			register(api) {
				api.shared.set(
					containerKey,
					() => {
						factories++;
						return { id: 'container-1', createdAt: factories };
					},
					{
						dispose(value) {
							disposed.push(value.id);
						},
					},
				);
			},
		});

		const bot = await createMockBot({ plugins: [plugin] });

		expect(bot.client.shared.has(containerKey)).toBe(true);
		expect(factories).toBe(0);
		const first = bot.client.shared.unwrap(containerKey);
		const second = bot.client.shared.unwrap(containerKey);
		expect(second).toBe(first);
		expect(first).toEqual({ id: 'container-1', createdAt: 1 });
		expect(factories).toBe(1);

		await bot.close();
		expect(disposed).toEqual(['container-1']);
	});

	test('plugin shared values reject conflicts and allow explicit override', async () => {
		const key = createSharedKey<string>()('slipher-test-shared-conflict');
		const first = createPlugin({
			name: 'slipher-shared-first',
			register(api) {
				api.shared.set(key, () => 'first');
			},
		});
		const second = createPlugin({
			name: 'slipher-shared-second',
			register(api) {
				api.shared.set(key, () => 'second');
			},
		});
		const override = createPlugin({
			name: 'slipher-shared-owner-override',
			register(api) {
				api.shared.set(key, () => 'first');
				api.shared.set(key, () => 'override', { override: true });
			},
		});

		await expect(createMockBot({ plugins: [first, second] })).rejects.toThrow(/already claimed/);

		const bot = await createMockBot({ plugins: [override] });
		expect(bot.client.shared.unwrap(key)).toBe('override');
		await bot.close();
	});

	test('plugin ctx extensions reach every command and component surface', async () => {
		@Declare({ name: 'ctx-slash', description: 'Reads plugin ctx from slash' })
		class CtxSlashCommand extends Command {
			async run(ctx: CommandContext) {
				await ctx.write({ content: `slash:${pluginCtxValue(ctx)}` });
			}
		}

		@Declare({ name: 'ctx-prefix', description: 'Reads plugin ctx from prefix' })
		class CtxPrefixCommand extends Command {
			async run(ctx: CommandContext) {
				await ctx.write({ content: `prefix:${pluginCtxValue(ctx)}` });
			}
		}

		class CtxUserMenu extends ContextMenuCommand {
			type = ApplicationCommandType.User as const;
			name = 'Ctx User';

			async run(ctx: MenuCommandContext<UserCommandInteraction>) {
				await ctx.write({ content: `menu:${pluginCtxValue(ctx)}` });
			}
		}

		class CtxEntryPoint extends EntryPointCommand {
			name = 'ctx-entry';
			description = 'Reads plugin ctx from entry point';
			handler = EntryPointCommandHandlerType.AppHandler;

			async run(ctx: Parameters<NonNullable<EntryPointCommand['run']>>[0]) {
				await ctx.write({ content: `entry:${pluginCtxValue(ctx)}` });
			}
		}

		class CtxButton extends ComponentCommand {
			componentType = 'Button' as const;
			filter(ctx: ComponentContext<'Button'>) {
				return ctx.customId === 'ctx-button';
			}
			async run(ctx: ComponentContext<'Button'>) {
				await ctx.write({ content: `button:${pluginCtxValue(ctx)}` });
			}
		}

		class CtxModal extends ModalCommand {
			filter(ctx: ModalContext) {
				return ctx.customId === 'ctx-modal';
			}
			async run(ctx: ModalContext) {
				await ctx.write({ content: `modal:${pluginCtxValue(ctx)}` });
			}
		}

		const plugin = createPlugin({
			name: 'slipher-ctx-plugin',
			ctx: {
				pluginCtxValue() {
					return 'ctx-ok';
				},
			},
		});

		const bot = await createMockBot({
			plugins: [plugin],
			commands: [CtxSlashCommand, CtxPrefixCommand, CtxUserMenu, CtxEntryPoint],
			components: [CtxButton, CtxModal],
			prefixes: ['!'],
		});

		await expect(bot.slash({ name: 'ctx-slash' })).resolves.toMatchObject({ content: 'slash:ctx-ok' });
		await expect(bot.say('!ctx-prefix')).resolves.toMatchObject({ content: 'prefix:ctx-ok' });
		await expect(bot.userMenu({ name: 'Ctx User', target: apiUser({ id: 'ctx-target' }) })).resolves.toMatchObject({
			content: 'menu:ctx-ok',
		});
		await expect(bot.entryPoint({ name: 'ctx-entry' })).resolves.toMatchObject({ content: 'entry:ctx-ok' });
		bot.reset();
		await expect(bot.clickButton('ctx-button', { allowSyntheticSource: true })).resolves.toMatchObject({
			content: 'button:ctx-ok',
		});
		await expect(bot.fillModal('ctx-modal', {})).resolves.toMatchObject({ content: 'modal:ctx-ok' });
		await bot.close();
	});

	test('plugin middlewares cover declared, global, dynamic, and denial paths', async () => {
		const calls: string[] = [];
		const declaredGuard = createMiddleware<void>(middle => {
			calls.push('declared');
			middle.next();
		});
		const globalGuard = createMiddleware<void>(middle => {
			calls.push('global');
			middle.next();
		});
		const dynamicBlocker = createMiddleware<void>(middle => {
			calls.push('dynamic');
			middle.stop('blocked-by-plugin');
		});

		@Declare({ name: 'plugin-guarded', description: 'Uses plugin middlewares' })
		class PluginGuardedCommand extends Command {
			middlewares = ['declaredGuard', 'dynamicBlocker'] as never[];

			async onMiddlewaresError(ctx: CommandContext, error: string, metadata: { middleware: string; scope: string }) {
				calls.push(`command-error:${error}:${metadata.middleware}:${metadata.scope}`);
				await ctx.write({ content: `denied:${error}:${metadata.middleware}:${metadata.scope}` });
			}

			async run(ctx: CommandContext) {
				calls.push('run');
				await ctx.write({ content: 'should-not-run' });
			}
		}

		const plugin = createPlugin({
			name: 'slipher-plugin-middlewares',
			middlewares: { declaredGuard, globalGuard },
			globalMiddlewares: ['globalGuard'],
			register(api) {
				api.middlewares.add('dynamicBlocker', dynamicBlocker);
				api.commands.observe({
					onMiddlewaresError(_ctx, error, metadata) {
						calls.push(`observer-error:${error}:${metadata.middleware}:${metadata.scope}`);
					},
				});
			},
		});

		const bot = await createMockBot({ plugins: [plugin], commands: [PluginGuardedCommand] });
		const result = await bot.slash({ name: 'plugin-guarded' });

		expect(result.content).toBe('denied:blocked-by-plugin:dynamicBlocker:command');
		expect(calls).toEqual([
			'global',
			'declared',
			'dynamic',
			'command-error:blocked-by-plugin:dynamicBlocker:command',
			'observer-error:blocked-by-plugin:dynamicBlocker:command',
		]);
		await bot.close();
	});

	test('plugin lang contributions are merged into the client locale table', async () => {
		@Declare({ name: 'plugin-lang', description: 'Reads plugin lang contribution' })
		class PluginLangCommand extends Command {
			async run(ctx: CommandContext) {
				const values = ctx.t.get() as unknown as { plugin: { greeting: string } };
				await ctx.write({ content: values.plugin.greeting });
			}
		}

		const plugin = createPlugin({
			name: 'slipher-plugin-langs',
			register(api) {
				api.langs.contribute('es-ES', { greeting: 'Hola desde plugin' }, { prefix: 'plugin' });
			},
		});

		const bot = await createMockBot({
			plugins: [plugin],
			commands: [PluginLangCommand],
			langs: { 'en-US': { base: 'Base' } },
			defaultLang: 'en-US',
		});

		const result = await bot.slash({ name: 'plugin-lang', locale: 'es-ES' });
		expect(result.content).toBe('Hola desde plugin');
		await bot.close();
	});
});
