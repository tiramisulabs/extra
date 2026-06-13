import { Command, type CommandContext, createStringOption, Declare, Options, type ParseLocales } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { TEST_BOT_ID } from '../../src/bot/constants';
import { Routes } from '../../src/bot/routes';

const englishLang = { greeting: 'Hello!' };

declare module 'seyfert' {
	interface DefaultLocale extends ParseLocales<typeof englishLang> {}
}

describe('message (prefix) commands', () => {
	const echoOptions = {
		text: createStringOption({ description: 'What to echo', required: true }),
	};

	@Declare({ name: 'echo', description: 'Echoes text' })
	@Options(echoOptions)
	class EchoCommand extends Command {
		async run(ctx: CommandContext<typeof echoOptions>) {
			await ctx.write({ content: `echo: ${ctx.options.text}` });
		}
	}

	test('say runs a prefix command and returns the replies', async () => {
		const bot = await createMockBot({ commands: [EchoCommand], prefixes: ['!'] });
		const result = await bot.say('!echo -text hello');

		expect(result.content).toBe('echo: hello');
		expect(result.messages).toHaveLength(1);
		expect(result.messages[0]).toMatchObject({ content: 'echo: hello' });
		await bot.close();
	});

	test('non-matching prefix does nothing', async () => {
		const bot = await createMockBot({ commands: [EchoCommand], prefixes: ['!'] });
		await bot.say('?echo -text hello');
		expect(bot.calls(Routes.createMessage)).toHaveLength(0);
		await bot.close();
	});

	test('guild-scoped prefix commands only run in matching guilds', async () => {
		const guildId = 'prefix-guild';

		@Declare({ name: 'guild-echo', description: 'Guild echo', guildId: [guildId] })
		@Options(echoOptions)
		class GuildEchoCommand extends Command {
			async run(ctx: CommandContext<typeof echoOptions>) {
				await ctx.write({ content: `guild: ${ctx.options.text}` });
			}
		}

		const bot = await createMockBot({ commands: [GuildEchoCommand], prefixes: ['!'] });
		const result = await bot.say('!guild-echo -text hello', { guildId });
		expect(result.content).toBe('guild: hello');
		await bot.say('!guild-echo -text nope', { guildId: 'other-guild' });
		expect(bot.calls(Routes.createMessage)).toHaveLength(1);
		await bot.close();
	});

	test('mentionAsPrefix dispatches through the effective bot id', async () => {
		const bot = await createMockBot({ commands: [EchoCommand], mentionAsPrefix: true });
		const result = await bot.say(`<@${TEST_BOT_ID}> echo -text hi`);

		expect(result.content).toBe('echo: hi');
		await bot.close();
	});
});
