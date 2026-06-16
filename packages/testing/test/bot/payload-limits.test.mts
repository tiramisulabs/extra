import { ActionRow, Button, Command, type CommandContext, Declare, MessageFlags, PollBuilder } from 'seyfert';
import { ButtonStyle } from 'seyfert/lib/types';
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

	test('duplicate component custom_id is rejected (F5)', async () => {
		const { dispatch, close } = await botWith((ctx, channelId) => {
			const row = new ActionRow<Button>().setComponents([
				new Button().setCustomId('dup').setLabel('A').setStyle(ButtonStyle.Primary),
				new Button().setCustomId('dup').setLabel('B').setStyle(ButtonStyle.Primary),
			]);
			return ctx.client.messages.write(channelId, { content: 'x', components: [row] });
		})();
		await expect(dispatch).rejects.toThrow(/duplicate component custom_id/);
		await close();
	});

	test('IsComponentsV2 alongside content is rejected (F19)', async () => {
		const { dispatch, close } = await botWith((ctx, channelId) => {
			const row = new ActionRow<Button>().setComponents([
				new Button().setCustomId('ok').setLabel('A').setStyle(ButtonStyle.Primary),
			]);
			return ctx.client.messages.write(channelId, {
				content: 'not allowed',
				flags: MessageFlags.IsComponentsV2,
				components: [row],
			});
		})();
		await expect(dispatch).rejects.toThrow(/IsComponentsV2/);
		await close();
	});

	test('more than 3 stickers is rejected (F20)', async () => {
		// discord-api-types already caps sticker_ids at a 3-tuple, so the runtime guard only fires for raw
		// (`as any`) payloads — drive the create route directly to exercise it.
		const { world, channel } = seedGuildFixture('stk');
		const bot = await createMockBot({ world });
		await expect(
			bot.rest.request('POST', `/channels/${channel.id}/messages`, {
				body: { content: 'x', sticker_ids: ['1', '2', '3', '4'] },
			}),
		).rejects.toThrow(/3 stickers/);
		await bot.close();
	});

	test('more than 10 poll answers is rejected (F21)', async () => {
		const { dispatch, close } = await botWith((ctx, channelId) => {
			const poll = new PollBuilder()
				.setQuestion({ text: 'Pick' })
				.setAnswers(...Array.from({ length: 11 }, (_, i) => ({ text: `A${i}` })));
			return ctx.client.messages.write(channelId, { poll });
		})();
		await expect(dispatch).rejects.toThrow(/10 answers/);
		await close();
	});

	test('editing a channel name over 100 chars is rejected (F22)', async () => {
		const { world, guild, actor, channel } = seedGuildFixture('cn');
		@Declare({ name: 'cn', description: 'renames a channel too long' })
		class Cn extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.channels.edit(channel.id, { name: 'x'.repeat(101) }, { guildId: ctx.guildId });
				await ctx.write({ content: 'ok' });
			}
		}
		const bot = await createMockBot({ commands: [Cn], world });
		await expect(bot.slash({ name: 'cn', guildId: guild.id, channel, user: actor.user })).rejects.toThrow(
			/channel name must be between 1 and 100/,
		);
		await bot.close();
	});
});
