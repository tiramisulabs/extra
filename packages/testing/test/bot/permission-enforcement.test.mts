import { Command, type CommandContext, Declare } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { apiUser } from '../../src/bot/payloads';
import { mockWorld } from '../../src/bot/world';

@Declare({ name: 'ban-target', description: 'Bans the seeded target' })
class BanTarget extends Command {
	async run(ctx: CommandContext) {
		await ctx.client.members.ban(ctx.guildId ?? '', 'enforce-target');
		await ctx.write({ content: 'banned' });
	}
}

const seed = (botRolePerms: 'BanMembers'[], botPos: number, targetPos: number) => {
	const world = mockWorld();
	const guild = world.registerGuild({ id: 'enforce-guild', ownerId: 'enforce-owner' });
	const channel = world.registerChannel(guild.id);
	const actor = world.registerMember(guild.id, { user: apiUser({ id: 'enforce-actor' }) });
	const botRole = world.registerRole(guild.id, { id: 'enforce-bot-role', permissions: botRolePerms, position: botPos });
	const targetRole = world.registerRole(guild.id, { id: 'enforce-target-role', position: targetPos });
	world.registerBotMember(guild.id, { roles: [botRole.id] });
	world.registerMember(guild.id, { user: apiUser({ id: 'enforce-target' }), roles: [targetRole.id] });
	return { world, guild, channel, actor };
};

describe('permission enforcement (opt-in via seeded bot member)', () => {
	test('ban without BanMembers is rejected 403 Missing Permissions', async () => {
		const { world, guild, channel, actor } = seed([], 5, 1);
		const bot = await createMockBot({ commands: [BanTarget], world });
		await expect(
			bot.slash({ name: 'ban-target', guildId: guild.id, channel, user: actor.user }),
		).rejects.toThrow(/Missing Permissions/);
		await bot.close();
	});

	test('ban with BanMembers above the target succeeds', async () => {
		const { world, guild, channel, actor } = seed(['BanMembers'], 5, 1);
		const bot = await createMockBot({ commands: [BanTarget], world });
		await expect(
			bot.slash({ name: 'ban-target', guildId: guild.id, channel, user: actor.user }),
		).resolves.toMatchObject({ content: 'banned' });
		await bot.close();
	});

	test('ban with BanMembers but a target ranked at/above the bot is rejected (hierarchy)', async () => {
		const { world, guild, channel, actor } = seed(['BanMembers'], 5, 5);
		const bot = await createMockBot({ commands: [BanTarget], world });
		await expect(
			bot.slash({ name: 'ban-target', guildId: guild.id, channel, user: actor.user }),
		).rejects.toThrow(/Missing Permissions/);
		await bot.close();
	});
});
