import { Command, type CommandContext, Declare } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { apiUser } from '../../src/bot/payloads';
import { mockWorld } from '../../src/bot/world';

describe('seeded world data reaches seyfert cache reads', () => {
	test('emojis, stickers and channel overwrites seeded into the world are visible via ctx.client.cache', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'cache-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'cache-actor' }) });
		const channel = world.registerChannel(guild.id, {
			id: 'cache-chan',
			overwrites: [{ id: 'cache-actor', type: 'member', deny: ['SendMessages'] }],
		});
		world.registerEmoji(guild.id, { id: 'emo1', name: 'sparkle' });
		world.registerSticker(guild.id, { id: 'stk1', name: 'wow' });

		const seen: { emojis?: (string | null)[]; stickers?: string[]; overwrites?: unknown } = {};
		@Declare({ name: 'inspect-cache', description: 'reads seyfert cache' })
		class InspectCache extends Command {
			async run(ctx: CommandContext) {
				seen.emojis = (await ctx.client.cache.emojis?.values(guild.id))?.map(emoji => emoji.name);
				seen.stickers = (await ctx.client.cache.stickers?.values(guild.id))?.map(sticker => sticker.name);
				seen.overwrites = await ctx.client.cache.overwrites?.raw(channel.id);
				await ctx.write({ content: 'ok' });
			}
		}

		const bot = await createMockBot({ commands: [InspectCache], world });
		await bot.slash({ name: 'inspect-cache', guildId: guild.id, channel, user: actor.user });

		expect(seen.emojis).toContain('sparkle');
		expect(seen.stickers).toContain('wow');
		expect(seen.overwrites).toBeTruthy();
		await bot.close();
	});
});
