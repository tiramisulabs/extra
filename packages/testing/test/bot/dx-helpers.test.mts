import { ActionRow, Button, Command, type CommandContext, Declare, Embed } from 'seyfert';
import { ButtonStyle } from 'seyfert/lib/types';
import { describe, expect, test } from 'vitest';
import { WorldStateError } from '../../src';
import { createMockBot } from '../../src/bot/bot';
import { apiUser } from '../../src/bot/payloads';
import { WorldState } from '../../src/bot/state';
import { mockWorld } from '../../src/bot/world';
import { GreetCommand } from './_setup';

describe('F37 symmetric readers', () => {
	test('world get/query/all resolve by exact query and diagnose ambiguous matches', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'reader-guild' });
		const first = world.registerChannel(guild.id, { id: 'reader-first', name: 'dupe' });
		const second = world.registerChannel(guild.id, { id: 'reader-second', name: 'dupe' });
		world.registerMember(guild.id, { user: apiUser({ id: 'reader-user' }), roles: ['reader-role'] });
		const bot = await createMockBot({ world });

		expect(bot.world.get.channel({ id: first.id }).name).toBe('dupe');
		expect(bot.world.query.channel({ id: 'missing' })).toBeUndefined();
		expect(bot.world.all.channel({ name: 'dupe' }).map(channel => channel.id)).toEqual([first.id, second.id]);
		expect(bot.world.get.member({ guildId: guild.id, userId: 'reader-user' }).roles).toEqual(['reader-role']);

		let error: unknown;
		try {
			bot.world.get.channel({ name: 'dupe' });
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(WorldStateError);
		expect(error).toMatchObject({
			entity: 'channel',
			matches: expect.arrayContaining([
				expect.objectContaining({ path: `channel:${first.id}` }),
				expect.objectContaining({ path: `channel:${second.id}` }),
			]),
		});
		expect(String(error)).toContain('Expected exactly one world channel');
		await bot.close();
	});

	test('world channel/role readers resolve by id alone and the role view keeps permissions/color', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'dx-guild' });
		const channel = world.registerChannel(guild.id, { name: 'general' });
		const role = world.registerRole(guild.id, {
			id: 'dx-role',
			name: 'mods',
			permissions: ['BanMembers'],
			position: 3,
		});
		world.registerMember(guild.id, { user: apiUser({ id: 'dx-user' }) });
		const bot = await createMockBot({ commands: [GreetCommand], world });

		expect(bot.world.query.channel({ id: channel.id })?.name).toBe('general');
		expect(bot.world.query.channel({ id: 'missing' })).toBeUndefined();

		const view = bot.world.query.role({ id: role.id });
		expect(view?.name).toBe('mods');
		expect(view?.position).toBe(3);
		expect(BigInt(view?.permissions ?? '0') & 4n).toBe(4n);

		expect(bot.world.query.role({ guildId: guild.id, id: role.id })?.permissions).toBe(view?.permissions);
		await bot.close();
	});

	test('world voice state delegates to the state reader', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'dx-vc-guild' });
		const channel = world.registerChannel(guild.id, { type: 2 });
		world.registerMember(guild.id, { user: apiUser({ id: 'dx-vc-user' }) });
		world.registerVoiceState(guild.id, { userId: 'dx-vc-user', channelId: channel.id });
		const bot = await createMockBot({ commands: [GreetCommand], world });

		expect(bot.world.query.voiceState({ guildId: guild.id, userId: 'dx-vc-user' })?.channel_id).toBe(channel.id);
		expect(bot.world.query.voiceState({ guildId: guild.id, userId: 'dx-vc-user' })?.channel_id).toBe(channel.id);
		expect(bot.world.query.voiceState({ guildId: guild.id, userId: 'absent' })).toBeUndefined();
		await bot.close();
	});

	test('guild-scoped readers use world wrapper scope even when raw payload guild_id is absent', () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'wrapper-guild' });
		const channel = world.registerChannel(guild.id, { id: 'wrapper-voice', type: 2 });
		world.registerVoiceState(guild.id, { userId: 'wrapper-user', channelId: channel.id });
		world.registerEmoji(guild.id, { id: 'wrapper-emoji', name: 'wrapped' });
		world.registerSoundboardSound(guild.id, { soundId: 'wrapper-sound', name: 'airhorn' });

		const state = new WorldState(world.build());

		expect(state.query.voiceState({ guildId: guild.id, userId: 'wrapper-user' })?.channel_id).toBe(channel.id);
		expect(state.query.emoji({ guildId: guild.id, id: 'wrapper-emoji' })?.name).toBe('wrapped');
		expect(state.query.soundboardSound({ guildId: guild.id, soundId: 'wrapper-sound' })?.name).toBe('airhorn');
	});
});

@Declare({ name: 'panel', description: 'Replies with an embed and a button' })
class PanelCommand extends Command {
	async run(ctx: CommandContext) {
		const embed = new Embed().setTitle('Profile').setDescription('Level 7');
		const row = new ActionRow<Button>().setComponents([
			new Button().setCustomId('approve').setLabel('Approve').setStyle(ButtonStyle.Success),
		]);
		await ctx.write({ embeds: [embed], components: [row] });
	}
}

describe('F34 typed DispatchResult accessors', () => {
	test('embedView and component(...) read parsed views without casts', async () => {
		const bot = await createMockBot({ commands: [PanelCommand] });
		const result = await bot.slash({ name: 'panel' });

		// embedView is typed EmbedView — no `as APIEmbed`.
		expect(result.embedView?.title).toBe('Profile');
		expect(result.embedView?.description).toBe('Level 7');
		expect(result.embedViews).toHaveLength(1);

		expect(result.components.map(view => view.customId)).toEqual(['approve']);
		expect(result.component('Approve')?.customId).toBe('approve');
		expect(result.component('approve')?.label).toBe('Approve');
		expect(result.component('missing')).toBeUndefined();
		await bot.close();
	});
});
