import { Command, type CommandContext, Declare } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { seedGuildFixture } from './_setup';

@Declare({ name: 'twice', description: 'writes twice (a bug — should be editOrReply/followup)' })
class WritesTwice extends Command {
	async run(ctx: CommandContext) {
		await ctx.write({ content: 'first' });
		await ctx.write({ content: 'second' });
	}
}

describe('unhandled command errors', () => {
	test('a naive double ctx.write fails the dispatch loud by default', async () => {
		const { world, guild, actor, channel } = seedGuildFixture('err');
		const bot = await createMockBot({ commands: [WritesTwice], world });
		await expect(bot.slash({ name: 'twice', guildId: guild.id, channel, user: actor.user })).rejects.toThrow(
			/already replied/i,
		);
		await bot.close();
	});

	test('onCommandError: "capture" surfaces it on result.error instead of throwing', async () => {
		const { world, guild, actor, channel } = seedGuildFixture('errc');
		const bot = await createMockBot({ commands: [WritesTwice], world, onCommandError: 'capture' });
		const res = await bot.slash({ name: 'twice', guildId: guild.id, channel, user: actor.user });
		expect(res.error).toBeInstanceOf(Error);
		expect((res.error as Error).message).toMatch(/already replied/i);
		expect(res.content).toBe('first');
		await bot.close();
	});
});
