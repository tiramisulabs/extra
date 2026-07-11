import { createEvent, createPlugin } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import {
	apiMember,
	apiMessage,
	apiUser,
	channelCreateEvent,
	memberAddEvent,
	memberRemoveEvent,
	messageCreateEvent,
	messageReactionAddEvent,
	messageReactionRemoveEvent,
	threadCreateEvent,
	voiceStateUpdateEvent,
} from '../../src/bot/payloads';
import { mockWorld } from '../../src/bot/world';

declare module 'seyfert/lib/events/event' {
	interface CustomEvents {
		'di:ready': (payload: { id: string }) => void;
	}
}

describe('emit result and factories', () => {
	test('returns the channel messages the handler wrote', async () => {
		const onJoin = createEvent({
			data: { name: 'guildMemberAdd' },
			async run(member, client) {
				await client.messages.write(member.id, { content: `Welcome ${member.user.username}` });
			},
		});
		const bot = await createMockBot({ events: [onJoin] });

		const result = await bot.emit(
			'GUILD_MEMBER_ADD',
			memberAddEvent(apiMember({ user: apiUser({ username: 'newbie' }) }), { guildId: '123' }),
		);

		expect(result.messages.at(-1)?.content).toBe('Welcome newbie');
		expect(result.content).toBe('Welcome newbie');
		await bot.close();
	});

	test('emit dispatches camelCase gateway events', async () => {
		const onJoin = createEvent({
			data: { name: 'guildMemberAdd' },
			async run(member, client) {
				await client.messages.write(member.id, { content: `Welcome ${member.user.username}` });
			},
		});
		const bot = await createMockBot({ events: [onJoin] });

		const result = await bot.emit(
			'guildMemberAdd',
			memberAddEvent(apiMember({ user: apiUser({ username: 'newbie' }) }), { guildId: '123' }),
		);

		expect(result.content).toBe('Welcome newbie');
		await bot.close();
	});

	test('emit dispatches custom plugin events through runCustom', async () => {
		const seen: string[] = [];
		const plugin = createPlugin({
			name: 'custom-event-plugin',
			register(api) {
				api.events.on('di:ready', async (payload, client) => {
					seen.push(payload.id);
					await client.messages.write('custom-event-channel', { content: `custom:${payload.id}` });
				});
			},
		});
		const bot = await createMockBot({ plugins: [plugin] });

		const result = await bot.emit('di:ready', { id: 'container' });

		expect(seen).toEqual(['container']);
		expect(result.content).toBe('custom:container');
		await bot.close();
	});

	test('emit fails loud when a custom event has no handler', async () => {
		const bot = await createMockBot({});

		await expect(bot.emit('custom:missing')).rejects.toThrow(/no custom handler ran/);
		await bot.close();
	});

	test('actor.emit auto-fills guild_id and the bound user', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'evt-guild' });
		const alice = world.registerMember(guild.id, { user: apiUser({ id: 'alice' }), roles: [] });
		const bot = await createMockBot({ world });

		await bot
			.actor({ member: alice, guildId: guild.id })
			.emit('GUILD_MEMBER_UPDATE', { roles: ['r1'] }, { allowNoHandler: true });

		expect(bot.world.query.member({ guildId: guild.id, userId: 'alice' })?.roles).toEqual(['r1']);
		await bot.close();
	});

	test('actor.emit auto-fills guild_id and the bound user for gateway events', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'actor-emit-guild' });
		const alice = world.registerMember(guild.id, { user: apiUser({ id: 'actor-emit-alice' }), roles: [] });
		const bot = await createMockBot({ world });

		await bot.actor({ member: alice, guildId: guild.id }).emit(
			'guildMemberUpdate',
			{ roles: ['r2'] },
			{
				allowNoHandler: true,
			},
		);

		expect(bot.world.query.member({ guildId: guild.id, userId: 'actor-emit-alice' })?.roles).toEqual(['r2']);
		await bot.close();
	});

	test('emit fails loud when no handler ran, unless allowNoHandler is set', async () => {
		const onJoin = createEvent({
			data: { name: 'guildMemberAdd' },
			run() {},
		});
		const bot = await createMockBot({ events: [onJoin] });

		expect(bot.registeredEvents()).toContain('GUILD_MEMBER_ADD');

		await expect(bot.emit('GUILD_MEMBER_REMOVE', { guild_id: '1', user: apiUser() })).rejects.toThrow(/no handler ran/);

		await expect(
			bot.emit('GUILD_MEMBER_ADD', { guild_id: '1', ...apiMember({ user: apiUser() }) }),
		).resolves.toBeDefined();

		await expect(
			bot.emit('CHANNEL_CREATE', { id: 'c', guild_id: '1', name: 'x', type: 0 }, { allowNoHandler: true }),
		).resolves.toBeDefined();

		await bot.close();
	});

	test('a rejected emit (no handler) does not dirty the world', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'g' });
		const bot = await createMockBot({ world });

		await expect(
			bot.emit('GUILD_MEMBER_ADD', { guild_id: guild.id, ...apiMember({ user: apiUser({ id: 'ghost' }) }) }),
		).rejects.toThrow(/no handler ran/);
		// guard runs BEFORE the world bridge, so the member was never added
		expect(bot.world.query.member({ guildId: guild.id, userId: 'ghost' })).toBeUndefined();
		await bot.close();
	});

	test('GUILD_MEMBER_UPDATE upserts an unseeded member into world and cache', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'member-update-guild' });
		const bot = await createMockBot({ world });

		await bot.emit(
			'GUILD_MEMBER_UPDATE',
			{ guild_id: guild.id, user: apiUser({ id: 'ghost-member' }), roles: ['r1'], nick: 'Ghost' },
			{ allowNoHandler: true },
		);

		expect(bot.world.query.member({ guildId: guild.id, userId: 'ghost-member' })).toMatchObject({
			roles: ['r1'],
			nick: 'Ghost',
		});
		await expect(Promise.resolve(bot.client.cache.members?.raw('ghost-member', guild.id))).resolves.toMatchObject({
			roles: ['r1'],
			nick: 'Ghost',
		});
		await bot.close();
	});

	test('gateway event validation fails before dirtying world when Seyfert cache would reject', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'invalid-event-guild' });
		const channel = world.registerChannel(guild.id, { id: 'invalid-event-channel' });
		const bot = await createMockBot({ world, onCommandError: 'capture' });

		await expect(
			bot.emit(
				'MESSAGE_CREATE',
				{ ...apiMessage({ id: 'invalid-message', channelId: channel.id }), author: undefined },
				{ allowNoHandler: true },
			),
		).rejects.toThrow(/MESSAGE_CREATE requires id, channel_id, and author\.id/);
		expect(bot.world.query.message({ channelId: channel.id, id: 'invalid-message' })).toBeUndefined();

		await expect(
			bot.emit('THREAD_CREATE', { id: 'guildless-thread', parent_id: channel.id, type: 11 }, { allowNoHandler: true }),
		).rejects.toThrow(/THREAD_CREATE requires guild_id/);
		expect(bot.world.query.channel({ id: 'guildless-thread' })).toBeUndefined();
		await bot.close();
	});

	test('unknown event names are custom events and fail loud without a listener', async () => {
		const bot = await createMockBot({});
		await expect(bot.emit('GUILD_MEMBER_ADDD', { guild_id: '1' })).rejects.toThrow(/no custom handler ran/);
		await bot.close();
	});

	test('memberRemoveEvent builds the removal payload', async () => {
		const left: string[] = [];
		const onLeave = createEvent({
			data: { name: 'guildMemberRemove' },
			run(member) {
				left.push(member.user.username);
			},
		});
		const bot = await createMockBot({ events: [onLeave] });

		await bot.emit('GUILD_MEMBER_REMOVE', memberRemoveEvent(apiUser({ username: 'gone' }), { guildId: '123' }));

		expect(left).toEqual(['gone']);
		await bot.close();
	});

	test('world event builders produce payloads that emit can apply', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'builder-guild' });
		const channel = world.registerChannel(guild.id, { id: 'builder-channel' });
		const bot = await createMockBot({ world });

		await bot.emit(
			'MESSAGE_CREATE',
			messageCreateEvent({ id: 'builder-message', channelId: channel.id, guildId: guild.id, content: 'created' }),
			{ allowNoHandler: true },
		);
		expect(bot.world.query.message({ channelId: channel.id, id: 'builder-message' })?.content).toBe('created');

		await bot.emit(
			'CHANNEL_CREATE',
			channelCreateEvent({ id: 'builder-created-channel', guildId: guild.id, name: 'created-channel' }),
			{ allowNoHandler: true },
		);
		expect(bot.world.query.channel({ id: 'builder-created-channel' })?.name).toBe('created-channel');

		await bot.emit(
			'THREAD_CREATE',
			threadCreateEvent({ id: 'builder-thread', parentId: channel.id, guildId: guild.id, name: 'thread' }),
			{ allowNoHandler: true },
		);
		expect(bot.world.query.channel({ id: 'builder-thread' })?.parentId).toBe(channel.id);

		await bot.emit(
			'VOICE_STATE_UPDATE',
			voiceStateUpdateEvent({ userId: 'voice-user', channelId: channel.id }, { guildId: guild.id }),
			{ allowNoHandler: true },
		);
		expect(bot.world.query.voiceState({ guildId: guild.id, userId: 'voice-user' })?.channel_id).toBe(channel.id);

		await bot.emit(
			'MESSAGE_REACTION_ADD',
			messageReactionAddEvent({
				channelId: channel.id,
				messageId: 'builder-message',
				userId: 'reactor',
				emoji: 'ok:123',
			}),
			{ allowNoHandler: true },
		);
		expect(
			bot.world.query.message({ channelId: channel.id, id: 'builder-message' })?.reaction('ok:123')?.users,
		).toContain('reactor');
		await bot.emit(
			'MESSAGE_REACTION_REMOVE',
			messageReactionRemoveEvent({
				channelId: channel.id,
				messageId: 'builder-message',
				userId: 'reactor',
				emoji: 'ok:123',
			}),
			{ allowNoHandler: true },
		);
		expect(
			bot.world.query.message({ channelId: channel.id, id: 'builder-message' })?.reaction('ok:123'),
		).toBeUndefined();
		await bot.close();
	});
});
