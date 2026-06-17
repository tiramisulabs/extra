import { createEvent } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { apiMember, apiMessage, apiUser, memberAddEvent, memberRemoveEvent } from '../../src/bot/payloads';
import { mockWorld } from '../../src/bot/world';

describe('emitEvent result and factories', () => {
	test('returns the channel messages the handler wrote', async () => {
		const onJoin = createEvent({
			data: { name: 'guildMemberAdd' },
			async run(member, client) {
				await client.messages.write(member.id, { content: `Welcome ${member.user.username}` });
			},
		});
		const bot = await createMockBot({ events: [onJoin] });

		const result = await bot.emitEvent(
			'GUILD_MEMBER_ADD',
			memberAddEvent(apiMember({ user: apiUser({ username: 'newbie' }) }), { guildId: '123' }),
		);

		expect(result.messages.at(-1)?.content).toBe('Welcome newbie');
		expect(result.content).toBe('Welcome newbie');
		await bot.close();
	});

	test('actor.emitEvent auto-fills guild_id and the bound user', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'evt-guild' });
		const alice = world.registerMember(guild.id, { user: apiUser({ id: 'alice' }), roles: [] });
		const bot = await createMockBot({ world });

		await bot
			.actor({ member: alice, guildId: guild.id })
			.emitEvent('GUILD_MEMBER_UPDATE', { roles: ['r1'] }, { allowNoHandler: true });

		expect(bot.worldMember(guild.id, 'alice')?.roles).toEqual(['r1']);
		await bot.close();
	});

	test('emitEvent fails loud when no handler ran, unless allowNoHandler is set', async () => {
		const onJoin = createEvent({
			data: { name: 'guildMemberAdd' },
			run() {},
		});
		const bot = await createMockBot({ events: [onJoin] });

		expect(bot.registeredEvents()).toContain('GUILD_MEMBER_ADD');

		// Mis-cased gateway name: seyfert finds no handler and silently no-ops — now it throws.
		await expect(bot.emitEvent('guildMemberAdd' as 'GUILD_MEMBER_ADD', { guild_id: '1' })).rejects.toThrow(
			/no handler ran/,
		);

		// A correct name with a registered handler runs fine.
		await expect(
			bot.emitEvent('GUILD_MEMBER_ADD', { guild_id: '1', ...apiMember({ user: apiUser() }) }),
		).resolves.toBeDefined();

		// An unregistered event used purely to seed world state opts out explicitly.
		await expect(
			bot.emitEvent('CHANNEL_CREATE', { id: 'c', guild_id: '1', name: 'x', type: 0 }, { allowNoHandler: true }),
		).resolves.toBeDefined();

		await bot.close();
	});

	test('a rejected emit (no handler) does not dirty the world', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'g' });
		const bot = await createMockBot({ world });

		await expect(
			bot.emitEvent('GUILD_MEMBER_ADD', { guild_id: guild.id, ...apiMember({ user: apiUser({ id: 'ghost' }) }) }),
		).rejects.toThrow(/no handler ran/);
		// guard runs BEFORE the world bridge, so the member was never added
		expect(bot.worldMember(guild.id, 'ghost')).toBeUndefined();
		await bot.close();
	});

	test('GUILD_MEMBER_UPDATE upserts an unseeded member into world and cache', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'member-update-guild' });
		const bot = await createMockBot({ world });

		await bot.emitEvent(
			'GUILD_MEMBER_UPDATE',
			{ guild_id: guild.id, user: apiUser({ id: 'ghost-member' }), roles: ['r1'], nick: 'Ghost' },
			{ allowNoHandler: true },
		);

		expect(bot.worldMember(guild.id, 'ghost-member')).toMatchObject({ roles: ['r1'], nick: 'Ghost' });
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
			bot.emitEvent(
				'MESSAGE_CREATE',
				{ ...apiMessage({ id: 'invalid-message', channelId: channel.id }), author: undefined },
				{ allowNoHandler: true },
			),
		).rejects.toThrow(/MESSAGE_CREATE requires id, channel_id, and author\.id/);
		expect(bot.worldMessage(channel.id, 'invalid-message')).toBeUndefined();

		await expect(
			bot.emitEvent(
				'THREAD_CREATE',
				{ id: 'guildless-thread', parent_id: channel.id, type: 11 },
				{ allowNoHandler: true },
			),
		).rejects.toThrow(/THREAD_CREATE requires guild_id/);
		expect(bot.worldChannel('guildless-thread')).toBeUndefined();
		await bot.close();
	});

	test('allowNoHandler on a non-bridged / typo name fails loud (it would do nothing)', async () => {
		const bot = await createMockBot({});
		await expect(
			bot.emitEvent('GUILD_MEMBER_ADDD' as 'GUILD_MEMBER_ADD', { guild_id: '1' }, { allowNoHandler: true }),
		).rejects.toThrow(/had no effect/);
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

		await bot.emitEvent('GUILD_MEMBER_REMOVE', memberRemoveEvent(apiUser({ username: 'gone' }), { guildId: '123' }));

		expect(left).toEqual(['gone']);
		await bot.close();
	});
});
