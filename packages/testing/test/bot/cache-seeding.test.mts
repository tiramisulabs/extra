import { Command, type CommandContext, Declare } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { apiUser } from '../../src/bot/payloads';
import { Routes } from '../../src/bot/routes';
import { mockWorld } from '../../src/bot/world';

type CacheStore = {
	get?: (id: string, guildId?: string) => unknown;
	values?: (guildId?: string) => unknown;
};

async function cacheGet<T>(store: unknown, id: string, guildId?: string): Promise<T | undefined> {
	const value = await (store as CacheStore | undefined)?.get?.(id, guildId);
	if (value === null) return undefined;
	return value as T | undefined;
}

async function cacheValues<T>(store: unknown, guildId?: string): Promise<T[]> {
	const values = await (store as CacheStore | undefined)?.values?.(guildId);
	return (Array.isArray(values) ? values : []) as T[];
}

describe('seeded world data reaches seyfert cache reads', () => {
	test('emojis, stickers, overwrites and stage instances seeded into the world are visible via ctx.client.cache', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'cache-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'cache-actor' }) });
		const channel = world.registerChannel(guild.id, {
			id: 'cache-chan',
			overwrites: [{ id: 'cache-actor', type: 'member', deny: ['SendMessages'] }],
		});
		const stageChannel = world.registerChannel(guild.id, { id: 'cache-stage-chan', type: 13 });
		world.registerStageInstance(stageChannel.id, { topic: 'Seeded Stage' });
		world.registerEmoji(guild.id, { id: 'emo1', name: 'sparkle' });
		world.registerSticker(guild.id, { id: 'stk1', name: 'wow' });

		const seen: { emojis?: (string | null)[]; stickers?: string[]; overwrites?: unknown; stageTopic?: string } = {};
		@Declare({ name: 'inspect-cache', description: 'reads seyfert cache' })
		class InspectCache extends Command {
			async run(ctx: CommandContext) {
				seen.emojis = (await ctx.client.cache.emojis?.values(guild.id))?.map(emoji => emoji.name);
				seen.stickers = (await ctx.client.cache.stickers?.values(guild.id))?.map(sticker => sticker.name);
				seen.overwrites = await ctx.client.cache.overwrites?.raw(channel.id);
				seen.stageTopic = (await cacheGet<{ topic?: string }>(
					ctx.client.cache.stageInstances,
					stageChannel.id,
					guild.id,
				))?.topic;
				await ctx.write({ content: 'ok' });
			}
		}

		const bot = await createMockBot({ commands: [InspectCache], world });
		await bot.slash({ name: 'inspect-cache', guildId: guild.id, channel, user: actor.user });

		expect(seen.emojis).toContain('sparkle');
		expect(seen.stickers).toContain('wow');
		expect(seen.overwrites).toBeTruthy();
		expect(seen.stageTopic).toBe('Seeded Stage');
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

	test('REST mutations converge channels, roles and stage instances before request resolution', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'entity-cache-guild' });
		const stageChannel = world.registerChannel(guild.id, { id: 'entity-cache-stage', type: 13 });
		const bot = await createMockBot({ world });

		const channel = (await bot.rest.call(Routes.createChannel, { guildId: guild.id }, {
			body: { name: 'live-channel' },
		})) as { id: string; name: string };
		const role = (await bot.rest.call(Routes.createRole, { guildId: guild.id }, {
			body: { name: 'live-role' },
		})) as { id: string; name: string };
		const stage = (await bot.rest.call(Routes.createStageInstance, {}, {
			body: { channel_id: stageChannel.id, topic: 'Live Stage' },
		})) as { channel_id: string; topic: string };

		const channels = await cacheValues<{ id: string; name: string }>(bot.client.cache.channels, guild.id);
		const roles = await cacheValues<{ id: string; name: string }>(bot.client.cache.roles, guild.id);
		const cachedStage = await cacheGet<{ channel_id: string; topic: string }>(
			bot.client.cache.stageInstances,
			stage.channel_id,
			guild.id,
		);
		expect(channels.some(entry => entry.id === channel.id && entry.name === 'live-channel')).toBe(true);
		expect(roles.some(entry => entry.id === role.id && entry.name === 'live-role')).toBe(true);
		expect(cachedStage?.topic).toBe('Live Stage');

		await bot.rest.call(Routes.deleteRole, { guildId: guild.id, roleId: role.id });
		await bot.rest.call(Routes.deleteStageInstance, { channelId: stage.channel_id });
		const rolesAfterDelete = await cacheValues<{ id: string }>(bot.client.cache.roles, guild.id);
		const stageAfterDelete = await cacheGet(bot.client.cache.stageInstances, stage.channel_id, guild.id);
		expect(rolesAfterDelete.some(entry => entry.id === role.id)).toBe(false);
		expect(stageAfterDelete).toBeUndefined();
		await bot.close();
	});
});
