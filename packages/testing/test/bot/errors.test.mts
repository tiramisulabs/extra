import { join } from 'node:path';
import { Command, type CommandContext, createPlugin, Declare, MessageFlags, Middlewares } from 'seyfert';
import { describe, expect, test, vi } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { GreetCommand, globalCalls, seedGuildFixture, testMiddlewares } from './_setup';

const englishLang = { greeting: 'Hello!' };
const missingVideoMessage = {
	flags: MessageFlags.IsComponentsV2,
	components: [
		{
			type: 12,
			items: [{ media: { url: 'attachment://vid7.mp4', content_type: 'video/mp4' } }],
		},
	],
};

declare module 'seyfert' {
	interface SeyfertRegistry {
		langs: typeof englishLang;
	}
}

describe('middlewares and error hooks', () => {
	@Declare({ name: 'also-greet', description: 'Second command' })
	class AlsoGreetCommand extends Command {
		async run(ctx: CommandContext) {
			await ctx.write({ content: 'also' });
		}
	}

	@Declare({ name: 'blocked-command', description: 'Blocked by middleware' })
	@Middlewares(['blocker'])
	class BlockedCommand extends Command {
		async onMiddlewaresError(ctx: CommandContext, error: string) {
			await ctx.write({ content: `middleware:${error}` });
		}
		async run(ctx: CommandContext) {
			await ctx.write({ content: 'should not run' });
		}
	}

	@Declare({ name: 'throwing-command', description: 'Throws' })
	class ThrowingCommand extends Command {
		async onRunError(ctx: CommandContext, error: unknown) {
			await ctx.write({ content: error instanceof Error ? error.message : 'unknown' });
		}
		async run() {
			throw new Error('boom');
		}
	}

	@Declare({ name: 'default-throwing-command', description: 'Throws for defaults' })
	class DefaultThrowingCommand extends Command {
		async run() {
			throw new Error('default boom');
		}
	}

	test('global middlewares run for every dispatched command', async () => {
		globalCalls.length = 0;
		const bot = await createMockBot({
			commands: [GreetCommand, AlsoGreetCommand],
			middlewares: testMiddlewares,
			globalMiddlewares: ['globalCounter'],
		});

		await bot.slash({ name: 'greet', options: { name: 'one' } });
		await bot.slash({ name: 'also-greet' });

		expect(globalCalls).toEqual(['global', 'global']);
		await bot.close();
	});

	test('middleware stops route through onMiddlewaresError without running the command', async () => {
		const bot = await createMockBot({ commands: [BlockedCommand], middlewares: testMiddlewares });
		const result = await bot.slash({ name: 'blocked-command' });

		expect(result.content).toBe('middleware:blocked');
		await bot.close();
	});

	test('command onRunError replies for thrown command errors', async () => {
		const bot = await createMockBot({ commands: [ThrowingCommand] });
		const result = await bot.slash({ name: 'throwing-command' });

		expect(result.content).toBe('boom');
		await bot.close();
	});

	test('client command defaults provide fallback onRunError', async () => {
		const bot = await createMockBot({
			commands: [DefaultThrowingCommand],
			clientOptions: {
				commands: {
					defaults: {
						onRunError: async ctx => {
							await ctx.write({ content: 'default handled' });
						},
					},
				},
			},
		});
		const result = await bot.slash({ name: 'default-throwing-command' });

		expect(result.content).toBe('default handled');
		await bot.close();
	});

	test('onCommandError capture covers plugin-loaded command REST validation failures without fatal noise', async () => {
		const { world, guild, actor, channel } = seedGuildFixture('plugin-rest-capture');
		const logs: unknown[][] = [];
		const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
			logs.push(args);
		});

		@Declare({ name: 'plugin-broken-video', description: 'Sends a missing attachment reference through proxy REST' })
		class PluginBrokenVideo extends Command {
			async run(ctx: CommandContext) {
				await ctx.proxy.channels(channel.id).messages.post({ body: missingVideoMessage });
			}
		}

		const plugin = createPlugin({
			name: 'plugin-rest-capture',
			register(api) {
				api.commands.add(PluginBrokenVideo);
			},
		});

		const bot = await createMockBot({ plugins: [plugin], world, onCommandError: 'capture' });
		try {
			const result = await bot.slash({
				name: 'plugin-broken-video',
				guildId: guild.id,
				channel,
				user: actor.user,
			});
			expect(result.error).toBeInstanceOf(Error);
			expect(bot.created('message')[0]?.error).toBeInstanceOf(Error);
			expect(logs.flat().some(value => String(value).includes('FATAL'))).toBe(false);
		} finally {
			await bot.close();
			logSpy.mockRestore();
		}
	});

	test('onCommandError capture covers commandsDir REST validation failures without fatal noise', async () => {
		const { world, guild, actor, channel } = seedGuildFixture('dir-rest-capture');
		const logs: unknown[][] = [];
		const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
			logs.push(args);
		});

		const bot = await createMockBot({
			commandsDir: join(process.cwd(), 'test/fixtures/e2e-commands'),
			loadModule: path => import(path),
			world,
			onCommandError: 'capture',
		});
		try {
			const result = await bot.slash({
				name: 'dir-broken-video',
				guildId: guild.id,
				channel,
				user: actor.user,
			});
			expect(result.error).toBeInstanceOf(Error);
			expect(bot.created('message')[0]?.error).toBeInstanceOf(Error);
			expect(logs.flat().some(value => String(value).includes('FATAL'))).toBe(false);
		} finally {
			await bot.close();
			logSpy.mockRestore();
		}
	});

	test('close is idempotent and reset clears recorded REST actions for reuse', async () => {
		const bot = await createMockBot({ commands: [AlsoGreetCommand] });
		await bot.rest.request('POST', '/channels/reset/messages', { body: { content: 'before reset' } });
		expect(bot.actions.length).toBeGreaterThan(0);

		await bot.reset();
		expect(bot.actions).toHaveLength(0);
		await expect(bot.slash({ name: 'also-greet' })).resolves.toMatchObject({ content: 'also' });

		await bot.close();
		await expect(bot.close()).resolves.toBeUndefined();
		await expect(bot.slash({ name: 'also-greet' })).rejects.toThrow(/closed/i);
	});
});
