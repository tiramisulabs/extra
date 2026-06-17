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

	test('a REST mutation converges seyfert cache: create an emoji / ban a user, then read it back from cache', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'conv-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'conv-actor' }) });
		world.registerMember(guild.id, { user: apiUser({ id: 'conv-target' }) });
		const channel = world.registerChannel(guild.id, { id: 'conv-chan' });

		const seen: { emojis?: (string | null)[]; banned?: boolean } = {};
		@Declare({ name: 'mutate-then-read', description: 'creates an emoji and a ban, then reads cache' })
		class MutateThenRead extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.proxy.guilds(guild.id).emojis.post({ body: { name: 'live', image: '' } });
				await ctx.client.members.ban(guild.id, 'conv-target');
				seen.emojis = (await ctx.client.cache.emojis?.values(guild.id))?.map(emoji => emoji.name);
				// seyfert keys cached bans by the user id (and strips the user from the stored value), so a present
				// entry for that id is the convergence signal.
				seen.banned = Boolean(await ctx.client.cache.bans?.get('conv-target', guild.id));
				await ctx.write({ content: 'ok' });
			}
		}

		const bot = await createMockBot({ commands: [MutateThenRead], world });
		await bot.slash({ name: 'mutate-then-read', guildId: guild.id, channel, user: actor.user });

		expect(seen.emojis).toContain('live');
		expect(seen.banned).toBe(true);
		await bot.close();
	});
});
