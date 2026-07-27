import { Command, type CommandContext, Declare } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { type ApiUser, apiUser, createMockBot, mockWorld, richUser } from '../../src';

@Declare({ name: 'roster', description: 'Counts members it can see in the guild' })
class Roster extends Command {
	async run(ctx: CommandContext) {
		const members = await ctx.client.cache.members?.values(ctx.guildId ?? '');
		await ctx.write({ content: `${members?.length ?? 0}` });
	}
}

describe('the world keeps growing after the bot is built', () => {
	test('a member seeded against a live bot reaches the cache and the readers', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'grow-guild' });
		const channel = world.registerChannel(guild.id);
		const first = world.registerMember(guild.id, { user: apiUser({ id: 'grow-first' }) });

		await using bot = await createMockBot({ commands: [Roster], world });
		await expect(bot.slash({ name: 'roster', guildId: guild.id, channel, user: first.user })).resolves.toMatchObject({
			content: '1',
		});

		await bot.seed(w => {
			w.registerMember(guild.id, { user: apiUser({ id: 'grow-second' }) });
		});

		expect(bot.world.query.member({ guildId: guild.id, userId: 'grow-second' })).toBeDefined();
		await expect(bot.slash({ name: 'roster', guildId: guild.id, channel, user: first.user })).resolves.toMatchObject({
			content: '2',
		});
	});

	test('a guild and its channel can appear mid-scenario', async () => {
		const world = mockWorld();
		world.registerGuild({ id: 'first-guild' });

		await using bot = await createMockBot({ world });
		await bot.seed(w => {
			const later = w.registerGuild({ id: 'later-guild', name: 'Later' });
			later.registerChannel({ id: 'later-channel' });
		});

		expect(bot.world.query.guild({ id: 'later-guild' })?.name).toBe('Later');
		expect(await bot.client.cache.channels?.get('later-channel')).toBeDefined();
	});

	test('derived lookups are reindexed, not just the arrays', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'invite-guild' });
		const channel = world.registerChannel(guild.id);

		await using bot = await createMockBot({ world });
		await bot.seed(w => {
			w.registerInvite(channel.id, { code: 'later-invite' });
		});

		// invitesByCode is built in the WorldState constructor; without a reindex this read misses.
		expect(bot.world.query.invite({ code: 'later-invite' })).toBeDefined();
	});

	test('seeding does not resurrect what the mock already removed', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'kick-guild' });
		// no bot member: moderation enforcement is opt-in, and this test is about reseeding, not permissions
		world.registerMember(guild.id, { user: apiUser({ id: 'kick-target' }) });

		await using bot = await createMockBot({ world });
		await bot.client.members.kick(guild.id, 'kick-target');
		expect(await bot.client.cache.members?.get('kick-target', guild.id)).toBeUndefined();

		await bot.seed(w => {
			w.registerMember(guild.id, { user: apiUser({ id: 'kick-newcomer' }) });
		});

		expect(await bot.client.cache.members?.get('kick-newcomer', guild.id)).toBeDefined();
		expect(await bot.client.cache.members?.get('kick-target', guild.id)).toBeUndefined();
	});

	test('seeding without a world says so', async () => {
		await using bot = await createMockBot({});

		await expect(bot.seed(() => {})).rejects.toThrow(/without a world/);
	});

	test('a mock* fixture is refused here exactly as createMockBot refuses it', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'guard-guild' });

		await using bot = await createMockBot({ world });
		await expect(
			bot.seed(w => {
				// The cast is the point: `seed` takes a callback, so the types are bypassable here by design.
				// richUser carries methods, so it cannot be cloned into the cache — without the runtime guard it
				// lands there and nothing ever complains.
				w.registerMember(guild.id, { user: richUser({ id: 'guard-user' }) as unknown as ApiUser });
			}),
		).rejects.toThrow(/^seed: the seeded world holds a value that cannot be cloned/);
		expect(await bot.client.cache.members?.get('guard-user', guild.id)).toBeUndefined();
	});
});
