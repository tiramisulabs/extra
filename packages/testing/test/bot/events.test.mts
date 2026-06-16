import { createEvent } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { apiMember, apiUser, memberAddEvent, memberRemoveEvent } from '../../src/bot/payloads';
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

		expect(bot.cachedMember(guild.id, 'alice')?.roles).toEqual(['r1']);
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
		await expect(
			bot.emitEvent('guildMemberAdd' as 'GUILD_MEMBER_ADD', { guild_id: '1' }),
		).rejects.toThrow(/no handler ran/);

		// A correct name with a registered handler runs fine.
		await expect(bot.emitEvent('GUILD_MEMBER_ADD', { guild_id: '1', ...apiMember({ user: apiUser() }) })).resolves
			.toBeDefined();

		// An unregistered event used purely to seed world state opts out explicitly.
		await expect(
			bot.emitEvent('CHANNEL_CREATE', { id: 'c', guild_id: '1', name: 'x', type: 0 }, { allowNoHandler: true }),
		).resolves.toBeDefined();

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
