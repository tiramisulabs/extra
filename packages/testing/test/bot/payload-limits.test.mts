import { Command, type CommandContext, Declare } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { seedGuildFixture } from './_setup';

function botWith(run: (ctx: CommandContext, channelId: string) => Promise<unknown>) {
	return async () => {
		const { world, guild, actor, channel } = seedGuildFixture('lim');
		@Declare({ name: 'lim', description: 'exercises a payload limit' })
		class Lim extends Command {
			async run(ctx: CommandContext) {
				await run(ctx, channel.id);
				await ctx.write({ content: 'ok' });
			}
		}
		const bot = await createMockBot({ commands: [Lim], world });
		const dispatch = bot.slash({ name: 'lim', guildId: guild.id, channel, user: actor.user });
		return { dispatch, close: () => bot.close() };
	};
}

describe('outgoing message payload limits (fail loud)', () => {
	test('content over 2000 chars is rejected', async () => {
		const { dispatch, close } = await botWith((ctx, channelId) =>
			ctx.client.messages.write(channelId, { content: 'x'.repeat(2001) }),
		)();
		await expect(dispatch).rejects.toThrow(/2000 or fewer/);
		await close();
	});

	test('an empty message is rejected', async () => {
		const { dispatch, close } = await botWith((ctx, channelId) => ctx.client.messages.write(channelId, {}))();
		await expect(dispatch).rejects.toThrow(/empty message/i);
		await close();
	});

	test('more than 10 embeds is rejected', async () => {
		const { dispatch, close } = await botWith((ctx, channelId) =>
			ctx.client.messages.write(channelId, { embeds: Array.from({ length: 11 }, () => ({ title: 't' })) }),
		)();
		await expect(dispatch).rejects.toThrow(/10 embeds/);
		await close();
	});

	test('posting to a category channel is rejected', async () => {
		const { world, guild, actor, channel } = seedGuildFixture('cat');
		const category = world.registerChannel(guild.id, { id: 'a-category', type: 4 });
		@Declare({ name: 'cat', description: 'posts to a category' })
		class Cat extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.messages.write(category.id, { content: 'nope' });
				await ctx.write({ content: 'ok' });
			}
		}
		const bot = await createMockBot({ commands: [Cat], world });
		await expect(bot.slash({ name: 'cat', guildId: guild.id, channel, user: actor.user })).rejects.toThrow(
			/channel type/i,
		);
		await bot.close();
	});
});
