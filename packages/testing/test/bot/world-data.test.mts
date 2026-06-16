import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { apiUser } from '../../src/bot/payloads';
import { mockWorld } from '../../src/bot/world';

interface EconomyState {
	balances: Record<string, number>;
	currency: string;
}

describe('worldData passthrough store', () => {
	test('seeds via createMockBot({ worldData }) isolated from the caller-owned input object', async () => {
		const economy: EconomyState = { balances: { alice: 100, bob: 50 }, currency: 'gold' };
		await using bot = await createMockBot({ worldData: { economy } });

		const read = bot.worldData<EconomyState>('economy');
		expect(read).toEqual(economy);
		expect(read?.balances.alice).toBe(100);
		expect(bot.worldData('missing')).toBeUndefined();

		// The store is seeded by value, not by reference: mutating the original input after construction must not
		// leak into the bot's copy, and the bot's copy is a distinct object from what the caller still holds.
		expect(read).not.toBe(economy);
		economy.balances.alice = 999;
		economy.currency = 'mutated';
		expect(bot.worldData<EconomyState>('economy')?.balances.alice).toBe(100);
		expect(bot.worldData<EconomyState>('economy')?.currency).toBe('gold');
	});

	test('worldData returns the live stored reference, so a write through it is observed by later reads', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ name: 'Lab' });
		world.set('featureFlags', { economy: true, beta: false });
		world.set('seedGuildId', guild.id);

		await using bot = await createMockBot({ world });

		expect(bot.worldData<Record<string, boolean>>('featureFlags')).toEqual({ economy: true, beta: false });
		expect(bot.worldData<string>('seedGuildId')).toBe(guild.id);

		// worldData() hands back the live store entry (no per-read clone): two reads are the same object, and a
		// domain layer that mutates the returned object sees the change on the next read.
		const flags = bot.worldData<Record<string, boolean>>('featureFlags');
		expect(bot.worldData('featureFlags')).toBe(flags);
		flags!.beta = true;
		expect(bot.worldData<Record<string, boolean>>('featureFlags')?.beta).toBe(true);
	});

	test('worldData option deep-merges over world.set() data, overriding only the colliding key', async () => {
		const world = mockWorld();
		world.set('a', 1);
		world.set('b', 2);
		world.set('nested', { keep: 'me' });

		await using bot = await createMockBot({ world, worldData: { b: 20, c: 30 } });

		expect(bot.worldData('a')).toBe(1);
		expect(bot.worldData('b')).toBe(20);
		expect(bot.worldData('c')).toBe(30);
		// Keys the option did not touch survive the merge untouched.
		expect(bot.worldData('nested')).toEqual({ keep: 'me' });
	});

	test('the mock never interprets the data: it survives a dispatch verbatim', async () => {
		const payload = { nested: { list: [1, 2, 3], when: new Date(0).toISOString() }, n: 42 };
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'wd-guild' });
		const member = world.registerMember(guild.id, { user: apiUser({ id: 'wd-user' }), roles: [] });

		await using bot = await createMockBot({ world, worldData: { custom: payload } });

		await bot.emitEvent('GUILD_MEMBER_UPDATE', { guild_id: guild.id, user: member.user, roles: ['r1'] });

		expect(bot.cachedMember(guild.id, 'wd-user')?.roles).toEqual(['r1']);
		expect(bot.worldData('custom')).toEqual(payload);
	});
});
