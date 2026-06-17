import { Command, type CommandContext, Declare } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { seedGuildFixture } from './_setup';

describe('worldMessage', () => {
	test('resolves a stored message view by channel and id', async () => {
		const { world, guild, actor, channel } = seedGuildFixture('cm');

		@Declare({ name: 'post', description: 'writes a message' })
		class Post extends Command {
			async run(ctx: CommandContext) {
				const sent = await ctx.client.messages.write(channel.id, { content: 'hello' });
				await ctx.write({ content: sent.id });
			}
		}

		const bot = await createMockBot({ commands: [Post], world });
		const res = await bot.slash({ name: 'post', guildId: guild.id, channel, user: actor.user });
		const view = bot.worldMessage(channel.id, res.content ?? '');
		expect(view?.content).toBe('hello');
		expect(bot.worldMessage(channel.id, 'missing')).toBeUndefined();
		await bot.close();
	});
});
