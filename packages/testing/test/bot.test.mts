import { describe, expect, test } from 'vitest';
import { apiChannel, apiGuild, apiMember, apiMessage, apiUser } from '../src/bot/payloads';

describe('api payload factories', () => {
	test('apiUser produces a snake_case user with unique ids', () => {
		const a = apiUser();
		const b = apiUser({ username: 'socram', globalName: null, bot: true });
		expect(a.id).not.toBe(b.id);
		expect(a).toMatchObject({ username: 'slipher-test-user', global_name: 'Slipher Test User', bot: false });
		expect(b).toMatchObject({ username: 'socram', global_name: null, bot: true });
	});

	test('apiGuild and apiChannel link via guild_id', () => {
		const guild = apiGuild({ name: 'Slipher Lab' });
		const channel = apiChannel({ guildId: guild.id });
		expect(guild).toMatchObject({ name: 'Slipher Lab', preferred_locale: 'en-US' });
		expect(channel.guild_id).toBe(guild.id);
		expect(channel.type).toBe(0);
	});

	test('apiMember wraps a user and apiMessage wraps an author', () => {
		const user = apiUser();
		const member = apiMember({ user });
		const message = apiMessage({ author: user, content: 'hi' });
		expect(member.user.id).toBe(user.id);
		expect(member.roles).toEqual([]);
		expect(message).toMatchObject({ author: { id: user.id }, content: 'hi', type: 0 });
	});
});
