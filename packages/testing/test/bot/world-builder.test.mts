import { describe, expect, test } from 'vitest';
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
});
