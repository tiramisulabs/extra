import { type ParseLocales } from 'seyfert';
import { ApplicationCommandOptionType, ComponentType, InteractionType } from 'seyfert/lib/types';
import { describe, expect, test } from 'vitest';
import {
	buttonInteraction,
	chatInputInteraction,
	modalSubmitInteraction,
	userOption,
} from '../../src/bot/interactions';
import { apiChannel, apiGuild, apiMember, apiMessage, apiUser } from '../../src/bot/payloads';

const englishLang = { greeting: 'Hello!' };

declare module 'seyfert' {
	interface DefaultLocale extends ParseLocales<typeof englishLang> {}
}

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

describe('interaction payload builders', () => {
	test('chatInputInteraction encodes primitive options by type', () => {
		const payload = chatInputInteraction({
			name: 'config',
			options: { key: 'volume', amount: 3, exact: 1.5, enabled: true },
		});
		expect(payload.type).toBe(2);
		expect(payload.data).toMatchObject({ name: 'config', type: 1 });
		expect(payload.data.options).toEqual([
			{ name: 'key', type: 3, value: 'volume' },
			{ name: 'amount', type: ApplicationCommandOptionType.Integer, value: 3 },
			{ name: 'exact', type: 10, value: 1.5 },
			{ name: 'enabled', type: ApplicationCommandOptionType.Boolean, value: true },
		]);
		expect(payload.guild_id).toBeDefined();
		expect(payload.member?.user).toBeDefined();
		expect(payload.token).toContain('slipher');
	});

	test('chatInputInteraction encodes user options into resolved data', () => {
		const target = { id: '42', username: 'target', global_name: null, discriminator: '0', avatar: null, bot: false };
		const payload = chatInputInteraction({ name: 'ban', options: { user: userOption(target) } });
		expect(payload.data.options).toEqual([{ name: 'user', type: 6, value: '42' }]);
		expect(payload.data.resolved?.users?.['42']).toMatchObject({ username: 'target' });
	});

	test('chatInputInteraction nests subcommand and group', () => {
		const payload = chatInputInteraction({
			name: 'admin',
			group: 'users',
			subcommand: 'kick',
			options: { reason: 'spam' },
		});
		expect(payload.data.options).toEqual([
			{
				name: 'users',
				type: 2,
				options: [{ name: 'kick', type: 1, options: [{ name: 'reason', type: 3, value: 'spam' }] }],
			},
		]);
	});

	test('guildId: null builds a DM interaction', () => {
		const payload = chatInputInteraction({ name: 'ping', guildId: null });
		expect(payload.guild_id).toBeUndefined();
		expect(payload.member).toBeUndefined();
		expect(payload.user).toBeDefined();
	});

	test('buttonInteraction and modalSubmitInteraction build component payloads', () => {
		const button = buttonInteraction({ customId: 'confirm' });
		expect(button.type).toBe(3);
		expect(button.data).toMatchObject({ custom_id: 'confirm', component_type: 2 });
		expect(button.message).toBeDefined();

		const modal = modalSubmitInteraction({ customId: 'feedback', fields: { rating: '5' } });
		expect(modal.type).toBe(InteractionType.ModalSubmit);
		expect(modal.data).toMatchObject({ custom_id: 'feedback' });
		expect(modal.data.components).toEqual([
			{
				type: ComponentType.ActionRow,
				components: [{ type: ComponentType.TextInput, custom_id: 'rating', value: '5' }],
			},
		]);
	});
});
