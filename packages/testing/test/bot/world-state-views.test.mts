import { Command, type CommandContext, Declare } from 'seyfert';
import { ChannelType } from 'seyfert/lib/types';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { apiMember, apiUser } from '../../src/bot/payloads';
import { mockWorld } from '../../src/bot/world';

const englishLang = { greeting: 'Hello!' };

declare module 'seyfert' {
	interface SeyfertRegistry {
		langs: typeof englishLang;
	}
}

describe('world state views', () => {
	test('materializes created channels, messages, embeds, and buttons', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'state-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'state-actor' }) });
		const dispatchChannel = world.registerChannel(guild.id, { id: 'dispatch-channel' });

		@Declare({ name: 'build-campaign', description: 'Builds a campaign channel' })
		class BuildCampaign extends Command {
			async run(ctx: CommandContext) {
				const channel = await ctx.client.guilds.channels.create(ctx.guildId ?? '', {
					name: 'acme-s1',
					type: ChannelType.GuildText,
				});
				await ctx.client.messages.write(channel.id, {
					content: 'Welcome Acme S1',
					embeds: [{ title: 'Acme S1', fields: [{ name: 'Budget', value: '$5,000' }] }],
					components: [
						{
							type: 1,
							components: [{ type: 2, style: 1, custom_id: 'approve', label: 'Approve' }],
						},
					],
				});
				await ctx.write({ content: 'built' });
			}
		}

		const bot = await createMockBot({ commands: [BuildCampaign], world });
		await bot.slash({ name: 'build-campaign', guildId: guild.id, channel: dispatchChannel, user: actor.user });
		const channel = bot.cachedGuild(guild.id)?.channel('acme-s1');
		expect(channel?.lastMessage?.content).toContain('Welcome Acme S1');
		expect(channel?.lastMessage?.buttons).toMatchObject([{ customId: 'approve', label: 'Approve' }]);
		expect(channel?.lastMessage?.embeds[0]).toMatchObject({
			title: 'Acme S1',
			fields: [{ name: 'Budget', value: '$5,000' }],
		});
		await bot.close();
	});

	test('materializes replies, edits, followups, DMs, and original-response fetch identity', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'reply-state-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'reply-state-actor' }) });
		const channel = world.registerChannel(guild.id, { id: 'reply-state-channel' });
		let fetchedOriginalId: string | undefined;

		@Declare({ name: 'reply-state', description: 'Writes reply state' })
		class ReplyState extends Command {
			async run(ctx: CommandContext) {
				await ctx.write({ content: 'initial' });
				const original = await ctx.fetchResponse();
				fetchedOriginalId = original.id;
				await ctx.editOrReply({ content: 'edited' });
				await ctx.followup({ content: 'followup' });
				await ctx.author.write({ content: 'dm hi' });
			}
		}

		const bot = await createMockBot({ commands: [ReplyState], world });
		await bot.slash({ name: 'reply-state', guildId: guild.id, channel, user: actor.user });
		const messages = bot.cachedGuild(guild.id)?.channel(channel.id)?.messages;
		expect(messages?.map(message => message.content)).toEqual(['edited', 'followup']);
		expect(messages?.[0]?.id).toBe(fetchedOriginalId);
		expect(bot.cachedDm(actor.user.id)?.lastMessage?.content).toBe('dm hi');
		await bot.close();
	});

	test('serves seeded message history newest-first and keeps view contract rules', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'history-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'history-actor' }) });
		const first = world.registerChannel(guild.id, { id: 'dup-1', name: 'dupe' });
		const second = world.registerChannel(guild.id, { id: 'dup-2', name: 'dupe' });
		world.registerMessage(first.id, { id: 'old-message', content: 'old' });
		world.registerMessage(first.id, { id: 'new-message', content: 'new' });

		@Declare({ name: 'fetch-history', description: 'Fetches message history' })
		class FetchHistory extends Command {
			async run(ctx: CommandContext) {
				const messages = await ctx.client.channels.fetchMessages(first.id);
				await ctx.client.messages.delete('missing-message', first.id);
				await ctx.client.members.kick(ctx.guildId ?? '', actor.user.id);
				await ctx.write({ content: messages.map(message => message.id).join(',') });
			}
		}

		const bot = await createMockBot({ commands: [FetchHistory], world });
		const result = await bot.slash({ name: 'fetch-history', guildId: guild.id, channel: second, user: actor.user });
		expect(result.content).toBe('new-message,old-message');
		expect(bot.cachedGuild(guild.id)?.channel('dupe')?.id).toBe(first.id);
		expect(bot.cachedGuild(guild.id)?.bans).toEqual([]);
		expect(bot.cachedGuild(guild.id)).not.toBe(bot.cachedGuild(guild.id));
		await bot.close();
	});

	test('materializes followup edit and delete webhook routes', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'followup-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'followup-actor' }) });
		const channel = world.registerChannel(guild.id, { id: 'followup-channel' });
		let followupId: string | undefined;

		@Declare({ name: 'followup-lifecycle', description: 'Mutates a followup' })
		class FollowupLifecycle extends Command {
			async run(ctx: CommandContext) {
				await ctx.write({ content: 'original' });
				const followup = await ctx.followup({ content: 'followup' });
				followupId = followup.id;
				await ctx.interaction.editMessage(followup.id, { content: 'followup edited' });
				await ctx.interaction.deleteMessage(followup.id);
				await ctx.editOrReply({ content: 'original edited' });
			}
		}

		const bot = await createMockBot({ commands: [FollowupLifecycle], world });
		await bot.slash({ name: 'followup-lifecycle', guildId: guild.id, channel, user: actor.user });

		expect(followupId).toBeDefined();
		expect(
			bot
				.cachedGuild(guild.id)
				?.channel(channel.id)
				?.messages.map(message => message.content),
		).toEqual(['original edited']);
		await bot.close();
	});
});

describe('emitEvent bridges into world views', () => {
	test('member add, update, and remove flow through guild views', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'bridge-guild' });
		const bot = await createMockBot({ world });

		await bot.emitEvent('GUILD_MEMBER_ADD', {
			guild_id: guild.id,
			...apiMember({ user: apiUser({ id: 'joiner' }), roles: ['r1'] }),
		});
		expect(bot.cachedGuild(guild.id)?.member('joiner')?.roles).toEqual(['r1']);

		await bot.emitEvent('GUILD_MEMBER_UPDATE', {
			guild_id: guild.id,
			user: apiUser({ id: 'joiner' }),
			roles: ['r1', 'r2'],
			nick: 'Joey',
		});
		expect(bot.cachedGuild(guild.id)?.member('joiner')?.roles).toEqual(['r1', 'r2']);
		expect(bot.cachedGuild(guild.id)?.member('joiner')?.nick).toBe('Joey');

		await bot.emitEvent('GUILD_MEMBER_REMOVE', { guild_id: guild.id, user: apiUser({ id: 'joiner' }) });
		expect(bot.cachedGuild(guild.id)?.member('joiner')).toBeUndefined();
		expect(bot.cachedGuild(guild.id)?.bans).toEqual([]);
		expect(bot.cachedMember(guild.id, 'joiner')).toBeUndefined();
		await bot.close();
	});

	test('channel and message events flow through views', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'cm-guild' });
		const bot = await createMockBot({ world });

		await bot.emitEvent('CHANNEL_CREATE', { id: 'c1', guild_id: guild.id, name: 'new-chan', type: 0 });
		expect(bot.cachedGuild(guild.id)?.channel('new-chan')?.id).toBe('c1');

		await bot.emitEvent('MESSAGE_CREATE', { id: 'm1', channel_id: 'c1', author: apiUser({ id: 'u1' }), content: 'hi' });
		expect(bot.cachedGuild(guild.id)?.channel('c1')?.lastMessage?.content).toBe('hi');

		await bot.emitEvent('MESSAGE_DELETE', { id: 'm1', channel_id: 'c1' });
		expect(bot.cachedGuild(guild.id)?.channel('c1')?.messages).toEqual([]);

		await bot.emitEvent('CHANNEL_DELETE', { id: 'c1', guild_id: guild.id });
		expect(bot.cachedGuild(guild.id)?.channel('new-chan')).toBeUndefined();
		await bot.close();
	});

	test('updateCache:false skips the world bridge', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'nocache-guild' });
		const bot = await createMockBot({ world });

		await bot.emitEvent(
			'GUILD_MEMBER_ADD',
			{ guild_id: guild.id, ...apiMember({ user: apiUser({ id: 'ghost' }) }) },
			{ updateCache: false },
		);

		expect(bot.cachedGuild(guild.id)?.member('ghost')).toBeUndefined();
		await bot.close();
	});

	test('cachedMember reflects role mutations applied through REST', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'cached-guild' });
		const role = world.registerRole(guild.id, { id: 'cached-role' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'cached-actor' }) });
		world.registerMember(guild.id, { user: apiUser({ id: 'cached-target' }), roles: [] });
		const channel = world.registerChannel(guild.id);

		@Declare({ name: 'grant', description: 'grants a role' })
		class Grant extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.members.addRole(ctx.guildId ?? '', 'cached-target', role.id);
				await ctx.write({ content: 'granted' });
			}
		}

		const bot = await createMockBot({ commands: [Grant], world });
		expect(bot.cachedMember(guild.id, 'cached-target')?.roles).toEqual([]);

		await bot.slash({ name: 'grant', guildId: guild.id, channel, user: actor.user });

		expect(bot.cachedMember(guild.id, 'cached-target')?.roles).toContain('cached-role');
		expect(bot.cachedMember(guild.id, 'absent')).toBeUndefined();
		await bot.close();
	});
});
