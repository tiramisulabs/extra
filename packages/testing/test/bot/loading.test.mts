import { join } from 'node:path';
import { Command, type CommandContext, createPlugin, Declare } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';

const englishLang = { greeting: 'Hello!' };

declare module 'seyfert' {
	interface SeyfertRegistry {
		langs: typeof englishLang;
	}
}

describe('real bot loading', () => {
	test('loads command classes from an explicit commandsDir', async () => {
		const bot = await createMockBot({
			commandsDir: join(process.cwd(), 'test/.generated/fixtures/commands'),
		});

		const result = await bot.slash({ name: 'ping' });
		expect(result.content).toBe('pong');
		await bot.close();
	});

	test('dispatches plugin-contributed command classes', async () => {
		@Declare({ name: 'plugin-ping', description: 'Plugin ping' })
		class PluginPingCommand extends Command {
			async run(ctx: CommandContext) {
				await ctx.write({ content: 'plugin pong' });
			}
		}

		const plugin = createPlugin({
			name: 'testing-plugin-command',
			register(api) {
				api.commands.add(PluginPingCommand);
			},
		});

		const bot = await createMockBot({ clientOptions: { plugins: [plugin] } });
		const result = await bot.slash({ name: 'plugin-ping' });
		expect(result.content).toBe('plugin pong');
		await bot.close();
	});
});
