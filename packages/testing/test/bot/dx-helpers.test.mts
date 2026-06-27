import { ActionRow, Button, Command, type CommandContext, Declare, Embed } from 'seyfert';
import { ButtonStyle } from 'seyfert/lib/types';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { apiUser } from '../../src/bot/payloads';
import { mockWorld } from '../../src/bot/world';
import { GreetCommand } from './_setup';

describe('F37 symmetric readers', () => {
	test('worldChannel/worldRole resolve by id alone and the role view keeps permissions/color', async () => {
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

		expect(bot.worldChannel(channel.id)?.name).toBe('general');
		expect(bot.worldChannel('missing')).toBeUndefined();

		const view = bot.worldRole(role.id);
		expect(view?.name).toBe('mods');
		expect(view?.position).toBe(3);
		expect(BigInt(view?.permissions ?? '0') & 4n).toBe(4n);

		expect(bot.worldGuild(guild.id)?.role(role.id)?.permissions).toBe(view?.permissions);
		await bot.close();
	});

	test('worldVoiceState delegates to the state reader', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'dx-vc-guild' });
		const channel = world.registerChannel(guild.id, { type: 2 });
		world.registerMember(guild.id, { user: apiUser({ id: 'dx-vc-user' }) });
		world.registerVoiceState(guild.id, { userId: 'dx-vc-user', channelId: channel.id });
		const bot = await createMockBot({ commands: [GreetCommand], world });

		expect(bot.worldVoiceState(guild.id, 'dx-vc-user')?.channel_id).toBe(channel.id);
		expect(bot.world.voiceState(guild.id, 'dx-vc-user')?.channel_id).toBe(channel.id);
		expect(bot.worldVoiceState(guild.id, 'absent')).toBeUndefined();
		await bot.close();
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
