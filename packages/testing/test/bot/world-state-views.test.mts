import { Command, type CommandContext, Declare } from 'seyfert';
import { ChannelType } from 'seyfert/lib/types';
import { describe, expect, test } from 'vitest';
import { createMockBot, WORLD_EVENT_NAMES } from '../../src/bot/bot';
import { TEST_BOT_ID } from '../../src/bot/constants';
import { apiMember, apiUser } from '../../src/bot/payloads';
import { mockWorld } from '../../src/bot/world';

const englishLang = { greeting: 'Hello!' };

declare module 'seyfert' {
	interface SeyfertRegistry {
		langs: typeof englishLang;
	}
}

describe('world state views', () => {
	test('materializes created channels, messages, embeds, and interactive components', async () => {
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
		const channel = bot.world.get.channel({ guildId: guild.id, name: 'acme-s1' });
		expect(channel?.lastMessage?.content).toContain('Welcome Acme S1');
		expect(channel?.lastMessage?.interactiveComponents).toMatchObject([{ customId: 'approve', label: 'Approve' }]);
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
		const messages = bot.world.query.channel({ guildId: guild.id, id: channel.id })?.messages;
		expect(messages?.map(message => message.content)).toEqual(['edited', 'followup']);
		expect(messages?.[0]?.id).toBe(fetchedOriginalId);
		expect(bot.world.query.dm({ userId: actor.user.id })?.lastMessage?.content).toBe('dm hi');
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
				await ctx.client.messages.delete('old-message', first.id);
				await ctx.client.members.kick(ctx.guildId ?? '', actor.user.id);
				await ctx.write({ content: messages.map(message => message.id).join(',') });
			}
		}

		const bot = await createMockBot({ commands: [FetchHistory], world });
		const result = await bot.slash({ name: 'fetch-history', guildId: guild.id, channel: second, user: actor.user });
		expect(result.content).toBe('new-message,old-message');
		expect(bot.world.all.channel({ guildId: guild.id, name: 'dupe' }).map(channel => channel.id)).toEqual([
			first.id,
			second.id,
		]);
		expect(bot.world.query.guild({ id: guild.id })?.bans).toEqual([]);
		expect(bot.world.query.guild({ id: guild.id })).not.toBe(bot.world.query.guild({ id: guild.id }));
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
			bot.world.query.channel({ guildId: guild.id, id: channel.id })?.messages.map(message => message.content),
		).toEqual(['original edited']);
		await bot.close();
	});
});

describe('emit bridges into world views', () => {
	test('member add, update, and remove flow through guild views', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'bridge-guild' });
		const bot = await createMockBot({ world });

		await bot.emit(
			'GUILD_MEMBER_ADD',
			{
				guild_id: guild.id,
				...apiMember({ user: apiUser({ id: 'joiner' }), roles: ['r1'] }),
			},
			{ allowNoHandler: true },
		);
		expect(bot.world.query.member({ guildId: guild.id, userId: 'joiner' })?.roles).toEqual(['r1']);

		await bot.emit(
			'GUILD_MEMBER_UPDATE',
			{
				guild_id: guild.id,
				user: apiUser({ id: 'joiner' }),
				roles: ['r1', 'r2'],
				nick: 'Joey',
			},
			{ allowNoHandler: true },
		);
		expect(bot.world.query.member({ guildId: guild.id, userId: 'joiner' })?.roles).toEqual(['r1', 'r2']);
		expect(bot.world.query.member({ guildId: guild.id, userId: 'joiner' })?.nick).toBe('Joey');

		await bot.emit(
			'GUILD_MEMBER_REMOVE',
			{ guild_id: guild.id, user: apiUser({ id: 'joiner' }) },
			{ allowNoHandler: true },
		);
		expect(bot.world.query.member({ guildId: guild.id, userId: 'joiner' })).toBeUndefined();
		expect(bot.world.query.guild({ id: guild.id })?.bans).toEqual([]);
		expect(bot.world.query.member({ guildId: guild.id, userId: 'joiner' })).toBeUndefined();
		await bot.close();
	});

	test('channel and message events flow through views', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'cm-guild' });
		const bot = await createMockBot({ world });

		await bot.emit(
			'CHANNEL_CREATE',
			{ id: 'c1', guild_id: guild.id, name: 'new-chan', type: 0 },
			{ allowNoHandler: true },
		);
		expect(bot.world.query.channel({ guildId: guild.id, name: 'new-chan' })?.id).toBe('c1');

		await bot.emit(
			'MESSAGE_CREATE',
			{ id: 'm1', channel_id: 'c1', author: apiUser({ id: 'u1' }), content: 'hi' },
			{ allowNoHandler: true },
		);
		expect(bot.world.query.channel({ guildId: guild.id, id: 'c1' })?.lastMessage?.content).toBe('hi');

		await bot.emit('MESSAGE_DELETE', { id: 'm1', channel_id: 'c1' }, { allowNoHandler: true });
		expect(bot.world.query.channel({ guildId: guild.id, id: 'c1' })?.messages).toEqual([]);

		await bot.emit('CHANNEL_DELETE', { id: 'c1', guild_id: guild.id }, { allowNoHandler: true });
		expect(bot.world.query.channel({ guildId: guild.id, name: 'new-chan' })).toBeUndefined();
		await bot.close();
	});

	test('updateCache:false skips the world bridge', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'nocache-guild' });
		const bot = await createMockBot({ world });

		await bot.emit(
			'GUILD_MEMBER_ADD',
			{ guild_id: guild.id, ...apiMember({ user: apiUser({ id: 'ghost' }) }) },
			{ updateCache: false, allowNoHandler: true },
		);

		expect(bot.world.query.member({ guildId: guild.id, userId: 'ghost' })).toBeUndefined();
		await bot.close();
	});

	test('world member reader reflects role mutations applied through REST', async () => {
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
		expect(bot.world.query.member({ guildId: guild.id, userId: 'cached-target' })?.roles).toEqual([]);

		await bot.slash({ name: 'grant', guildId: guild.id, channel, user: actor.user });

		expect(bot.world.query.member({ guildId: guild.id, userId: 'cached-target' })?.roles).toContain('cached-role');
		expect(bot.world.query.member({ guildId: guild.id, userId: 'absent' })).toBeUndefined();
		await bot.close();
	});

	test('WORLD_EVENT_NAMES exposes the bridged event set', () => {
		expect([...WORLD_EVENT_NAMES].sort()).toEqual(
			[
				'CHANNEL_CREATE',
				'CHANNEL_DELETE',
				'GUILD_MEMBER_ADD',
				'GUILD_MEMBER_REMOVE',
				'GUILD_MEMBER_UPDATE',
				'MESSAGE_CREATE',
				'MESSAGE_DELETE',
				'MESSAGE_REACTION_ADD',
				'MESSAGE_REACTION_REMOVE',
				'MESSAGE_REACTION_REMOVE_ALL',
				'MESSAGE_REACTION_REMOVE_EMOJI',
				'VOICE_STATE_UPDATE',
				'THREAD_CREATE',
				'THREAD_DELETE',
			].sort(),
		);
	});

	test('emit MESSAGE_REACTION_ADD updates reaction state through the event path', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'event-react-guild' });
		const channel = world.registerChannel(guild.id, { id: 'event-react-channel' });
		const message = world.registerMessage(channel.id, { id: 'event-react-message' });

		const bot = await createMockBot({ world });
		await bot.emit(
			'MESSAGE_REACTION_ADD',
			{
				channel_id: channel.id,
				message_id: message.id,
				user_id: 'reactor',
				emoji: { name: '👍', id: null },
				guild_id: guild.id,
			},
			{ updateCache: true, allowNoHandler: true },
		);

		expect(
			bot.world.query.reaction({ channelId: channel.id, messageId: message.id, emoji: '👍' })?.users ?? [],
		).toEqual(['reactor']);
		const view = bot.world.query.message({ channelId: channel.id, id: message.id })?.reaction('👍');
		expect(view).toMatchObject({ emoji: '👍', count: 1 });
		await bot.close();
	});

	test('emit MESSAGE_REACTION_ADD agrees with the REST path on the emoji key', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'agree-react-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'agree-react-actor' }) });
		const channel = world.registerChannel(guild.id, { id: 'agree-react-channel' });
		const message = world.registerMessage(channel.id, { id: 'agree-react-message' });

		@Declare({ name: 'react', description: 'Reacts via REST' })
		class React extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.reactions.add(message.id, channel.id, '🔥');
				await ctx.write({ content: 'reacted' });
			}
		}

		const bot = await createMockBot({ commands: [React], world });
		await bot.slash({ name: 'react', guildId: guild.id, channel, user: actor.user });
		await bot.emit(
			'MESSAGE_REACTION_ADD',
			{
				channel_id: channel.id,
				message_id: message.id,
				user_id: 'event-reactor',
				emoji: { name: '🔥', id: null },
				guild_id: guild.id,
			},
			{ updateCache: true, allowNoHandler: true },
		);

		expect(
			bot.world.query.reaction({ channelId: channel.id, messageId: message.id, emoji: '🔥' })?.users ?? [],
		).toEqual([TEST_BOT_ID, 'event-reactor']);
		await bot.close();
	});

	test('emit VOICE_STATE_UPDATE upserts then disconnect removes the voice state', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'voice-guild' });
		const channel = world.registerChannel(guild.id, { id: 'voice-channel' });

		const bot = await createMockBot({ world });
		await bot.emit(
			'VOICE_STATE_UPDATE',
			{ guild_id: guild.id, user_id: 'speaker', channel_id: channel.id },
			{ updateCache: true, allowNoHandler: true },
		);
		expect(bot.world.query.voiceState({ guildId: guild.id, userId: 'speaker' })?.channel_id).toBe(channel.id);

		await bot.emit(
			'VOICE_STATE_UPDATE',
			{ guild_id: guild.id, user_id: 'speaker', channel_id: null },
			{ updateCache: true, allowNoHandler: true },
		);
		expect(bot.world.query.voiceState({ guildId: guild.id, userId: 'speaker' })).toBeUndefined();
		await bot.close();
	});

	test('emit THREAD_CREATE materializes a thread and THREAD_DELETE removes it', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'thread-event-guild' });
		const parent = world.registerChannel(guild.id, { id: 'thread-event-parent' });

		const bot = await createMockBot({ world });
		await bot.emit(
			'THREAD_CREATE',
			{
				id: 'event-thread',
				guild_id: guild.id,
				parent_id: parent.id,
				type: 11,
				thread_metadata: { archived: false, locked: false, auto_archive_duration: 1440 },
			},
			{ allowNoHandler: true },
		);
		const thread = bot.world.query.thread({ guildId: guild.id, id: 'event-thread' });
		expect(thread?.id).toBe('event-thread');
		expect(thread?.parentId).toBe(parent.id);

		await bot.emit('THREAD_DELETE', { id: 'event-thread', guild_id: guild.id }, { allowNoHandler: true });
		expect(bot.world.query.thread({ guildId: guild.id, id: 'event-thread' })).toBeUndefined();
		await bot.close();
	});
});
