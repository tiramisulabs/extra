import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { mockWorld } from '../../src/bot/world';

const englishLang = { greeting: 'Hello!' };

declare module 'seyfert' {
	interface SeyfertRegistry {
		langs: typeof englishLang;
	}
}

describe('mockWorld', () => {
	test('builds linked guilds, channels, users and members', () => {
		const world = mockWorld();
		const guild = world.registerGuild({ name: 'Lab' });
		const channel = world.registerChannel(guild.id, { name: 'general' });
		const member = world.registerMember(guild.id, { nick: 'soc' });
		const built = world.build();

		expect(built.guilds).toHaveLength(1);
		expect(channel.guild_id).toBe(guild.id);
		expect(built.members[0]).toMatchObject({ guildId: guild.id, member: { nick: 'soc' } });
		expect(built.users.some(user => user.id === member.user.id)).toBe(true);
	});

	test('a registered guild carries its own registrars, so the guild id is stated once', () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'scoped-guild', name: 'Scoped' });

		const role = guild.registerRole({ name: 'mod' });
		const channel = guild.registerChannel({ name: 'general' });
		const member = guild.registerMember({ nick: 'soc' });
		const botMember = guild.registerBotMember({ roles: [role.id] });
		const emoji = guild.registerEmoji({ name: 'wave' });
		const built = world.build();

		expect(channel.guild_id).toBe('scoped-guild');
		expect(built.roles).toContainEqual({ guildId: 'scoped-guild', role });
		expect(built.members).toContainEqual({ guildId: 'scoped-guild', member });
		expect(built.members).toContainEqual({ guildId: 'scoped-guild', member: botMember });
		expect(built.guildEmojis).toContainEqual({ guildId: 'scoped-guild', emoji });
	});

	test('the scoped and threaded registrars seed the same world', () => {
		const scoped = mockWorld();
		const scopedGuild = scoped.registerGuild({ id: 'same-guild', ownerId: 'same-owner' });
		scopedGuild.registerRole({ id: 'same-role', name: 'mod' });
		scopedGuild.registerChannel({ id: 'same-channel', name: 'general' });

		const threaded = mockWorld();
		const threadedGuild = threaded.registerGuild({ id: 'same-guild', ownerId: 'same-owner' });
		threaded.registerRole(threadedGuild.id, { id: 'same-role', name: 'mod' });
		threaded.registerChannel(threadedGuild.id, { id: 'same-channel', name: 'general' });

		expect(scoped.build()).toEqual(threaded.build());
	});

	test('a scoped guild is still the plain payload it also is', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'payload-guild', name: 'Payload' });
		guild.registerChannel({ id: 'payload-channel' });

		// The registrars must stay non-enumerable: createMockBot clones the built world, and structuredClone
		// throws DataCloneError on an enumerable function.
		expect(Object.keys(guild)).not.toContain('registerChannel');
		expect(JSON.parse(JSON.stringify(guild))).toEqual({ ...guild });
		expect(() => structuredClone(world.build())).not.toThrow();
		expect(world.build().guilds[0]).toBe(guild);

		await using bot = await createMockBot({ world });
		expect(bot.world.query.guild({ id: 'payload-guild' })?.name).toBe('Payload');
	});

	test('seeds voice states resolvable from the cache', async () => {
		const world = mockWorld();
		const guild = world.registerGuild();
		const channel = world.registerChannel(guild.id, { name: 'General' });
		const member = world.registerMember(guild.id);
		const voiceState = world.registerVoiceState(guild.id, { userId: member.user.id, channelId: channel.id });

		expect(world.build().voiceStates).toEqual([{ guildId: guild.id, voiceState }]);

		await using bot = await createMockBot({ world });
		const cached = await bot.client.cache.voiceStates?.get(member.user.id, guild.id);
		expect(cached?.channelId).toBe(channel.id);
	});
});
