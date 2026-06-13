import { Command, type CommandContext, Declare, Middlewares, type ParseLocales } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { GreetCommand, globalCalls, testMiddlewares } from './_setup';

const englishLang = { greeting: 'Hello!' };

declare module 'seyfert' {
	interface DefaultLocale extends ParseLocales<typeof englishLang> {}
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
});
