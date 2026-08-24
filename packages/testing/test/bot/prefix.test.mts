import { Command, type CommandContext, createStringOption, Declare, Options } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { TEST_BOT_ID } from '../../src/bot/constants';
import { Routes } from '../../src/bot/routes';

const englishLang = { greeting: 'Hello!' };

declare module 'seyfert' {
	interface SeyfertRegistry {
		langs: typeof englishLang;
	}
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
		const result = await bot.say('?echo -text hello');
		expect(result.actions.filter(action => bot.rest.matches(Routes.createMessage, action))).toHaveLength(0);
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
		const accepted = await bot.say('!guild-echo -text hello', { guildId });
		expect(accepted.content).toBe('guild: hello');
		const ignored = await bot.say('!guild-echo -text nope', { guildId: 'other-guild' });
		expect(accepted.actions.filter(action => bot.rest.matches(Routes.createMessage, action))).toHaveLength(1);
		expect(ignored.actions.filter(action => bot.rest.matches(Routes.createMessage, action))).toHaveLength(0);
		await bot.close();
	});

	test('mentionAsPrefix dispatches through the effective bot id', async () => {
		const bot = await createMockBot({ commands: [EchoCommand], mentionAsPrefix: true });
		const result = await bot.say(`<@${TEST_BOT_ID}> echo -text hi`);

		expect(result.content).toBe('echo: hi');
		await bot.close();
	});
});
