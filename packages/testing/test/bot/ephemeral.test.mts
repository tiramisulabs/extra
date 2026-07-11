import { Command, type CommandContext, Declare, MessageFlags } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { seedGuildFixture } from './_setup';

describe('ephemeral replies do not leak into channel reads (F17)', () => {
	test('an ephemeral reply is visible in the result but absent from the channel', async () => {
		const { world, guild, actor, channel } = seedGuildFixture('eph');

		@Declare({ name: 'secret', description: 'replies ephemerally' })
		class Secret extends Command {
			async run(ctx: CommandContext) {
				await ctx.write({ content: 'top-secret', flags: MessageFlags.Ephemeral });
			}
		}

		const bot = await createMockBot({ commands: [Secret], world });
		const result = await bot.slash({ name: 'secret', guildId: guild.id, channel, user: actor.user });

		// The test author still sees the ephemeral reply in the dispatch result.
		expect(result.content).toBe('top-secret');
		expect(result.ephemeral).toBe(true);

		// But it is NOT part of the channel — absent from both the view and GET /channels/{id}/messages.
		expect(bot.world.query.channel({ id: channel.id }), 'channel must exist in the world').toBeDefined();
		expect(bot.world.query.channel({ id: channel.id })?.messages.map(message => message.content)).not.toContain(
			'top-secret',
		);
		expect(bot.world.all.message({ channelId: channel.id }).map(message => message.content)).not.toContain(
			'top-secret',
		);
		expect(bot.world.query.rawMessage({ channelId: channel.id, content: 'top-secret' })).toBeUndefined();
		await bot.close();
	});

	test('a normal (non-ephemeral) reply does appear in the channel', async () => {
		const { world, guild, actor, channel } = seedGuildFixture('pub');

		@Declare({ name: 'public', description: 'replies publicly' })
		class Public extends Command {
			async run(ctx: CommandContext) {
				await ctx.write({ content: 'everyone-sees-this' });
			}
		}

		const bot = await createMockBot({ commands: [Public], world });
		await bot.slash({ name: 'public', guildId: guild.id, channel, user: actor.user });

		expect(bot.world.query.channel({ id: channel.id })?.messages.map(message => message.content)).toContain(
			'everyone-sees-this',
		);
		await bot.close();
	});
});
