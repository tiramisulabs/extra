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
		await expect(bot.slash({ name: 'ban-target', guildId: guild.id, channel, user: actor.user })).rejects.toThrow(
			/Missing Permissions/,
		);
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
		await expect(bot.slash({ name: 'ban-target', guildId: guild.id, channel, user: actor.user })).rejects.toThrow(
			/Missing Permissions/,
		);
		await bot.close();
	});
});

describe('role-assignment & bulk-ban edge enforcement', () => {
	const seedRoles = () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'role-guild', ownerId: 'owner-id' });
		const channel = world.registerChannel(guild.id);
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'role-actor' }) });
		const botRole = world.registerRole(guild.id, {
			id: 'bot-role',
			permissions: ['ManageRoles', 'BanMembers'],
			position: 5,
		});
		const highRole = world.registerRole(guild.id, { id: 'high-role', position: 10 });
		world.registerBotMember(guild.id, { roles: [botRole.id] });
		world.registerMember(guild.id, { user: apiUser({ id: 'subject' }), roles: [] });
		return { world, guild, channel, actor, highRole };
	};

	test('editMember assigning a role above the bot is rejected', async () => {
		const { world, guild, channel, actor, highRole } = seedRoles();
		@Declare({ name: 'promote', description: 'assigns a high role via editMember' })
		class Promote extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.members.edit(ctx.guildId ?? '', 'subject', { roles: [highRole.id] });
				await ctx.write({ content: 'promoted' });
			}
		}
		const bot = await createMockBot({ commands: [Promote], world });
		await expect(bot.slash({ name: 'promote', guildId: guild.id, channel, user: actor.user })).rejects.toThrow(
			/Missing Permissions/,
		);
		await bot.close();
	});

	test('adding the @everyone role to a member is a 400', async () => {
		const { world, guild, channel, actor } = seedRoles();
		@Declare({ name: 'add-everyone', description: 'adds @everyone via addRole' })
		class AddEveryone extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.members.addRole(ctx.guildId ?? '', 'subject', guild.id); // roleId === guildId == @everyone
				await ctx.write({ content: 'added' });
			}
		}
		const bot = await createMockBot({ commands: [AddEveryone], world });
		await expect(bot.slash({ name: 'add-everyone', guildId: guild.id, channel, user: actor.user })).rejects.toThrow(
			/@everyone role cannot be added/,
		);
		await bot.close();
	});

	test('bulkBan is partial: bannable users banned, un-outrankable owner reported in failed_users', async () => {
		const { world, guild, channel, actor } = seedRoles();
		world.registerMember(guild.id, { user: apiUser({ id: 'bannable' }), roles: [] });
		let result: { banned_users: string[]; failed_users: string[] } | undefined;
		@Declare({ name: 'bulk', description: 'bulk-bans two users incl. the owner' })
		class Bulk extends Command {
			async run(ctx: CommandContext) {
				result = (await ctx.client.bans.bulkCreate(ctx.guildId ?? '', {
					user_ids: ['bannable', 'owner-id'],
				})) as typeof result;
				await ctx.write({ content: 'done' });
			}
		}
		const bot = await createMockBot({ commands: [Bulk], world });
		await bot.slash({ name: 'bulk', guildId: guild.id, channel, user: actor.user });
		expect(result?.banned_users).toEqual(['bannable']);
		expect(result?.failed_users).toEqual(['owner-id']);
		expect(bot.world.isBanned(guild.id, 'bannable')).toBe(true);
		expect(bot.world.isBanned(guild.id, 'owner-id')).toBe(false);
		await bot.close();
	});
});

describe('expanded management-route enforcement (+ channel overwrites)', () => {
	const seedManage = (rolePerms: ('ManageChannels' | 'ManageMessages')[], overwriteDeny?: 'ManageChannels') => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'mgmt-guild', ownerId: 'mgmt-owner' });
		const role = world.registerRole(guild.id, { id: 'mgmt-role', permissions: rolePerms, position: 5 });
		const channel = world.registerChannel(guild.id, {
			id: 'mgmt-chan',
			...(overwriteDeny ? { overwrites: [{ id: 'mgmt-role', type: 'role' as const, deny: [overwriteDeny] }] } : {}),
		});
		world.registerBotMember(guild.id, { roles: [role.id] });
		return { world, guild, channel };
	};

	test('editChannel without ManageChannels is denied', async () => {
		const { world, channel } = seedManage([]);
		const bot = await createMockBot({ world });
		await expect(bot.rest.request('PATCH', `/channels/${channel.id}`, { body: { name: 'renamed' } })).rejects.toThrow(
			/Missing Permissions/,
		);
		await bot.close();
	});

	test('editChannel with ManageChannels succeeds', async () => {
		const { world, channel } = seedManage(['ManageChannels']);
		const bot = await createMockBot({ world });
		await expect(
			bot.rest.request('PATCH', `/channels/${channel.id}`, { body: { name: 'renamed' } }),
		).resolves.toBeDefined();
		await bot.close();
	});

	test('a channel deny-overwrite beats a guild-wide grant (channel-level permissions are honored)', async () => {
		const { world, channel } = seedManage(['ManageChannels'], 'ManageChannels');
		const bot = await createMockBot({ world });
		await expect(bot.rest.request('PATCH', `/channels/${channel.id}`, { body: { name: 'renamed' } })).rejects.toThrow(
			/Missing Permissions/,
		);
		await bot.close();
	});

	test('creating a guild emoji without ManageGuildExpressions is denied', async () => {
		const { world, guild } = seedManage([]);
		const bot = await createMockBot({ world });
		await expect(
			bot.rest.request('POST', `/guilds/${guild.id}/emojis`, { body: { name: 'sparkle', image: '' } }),
		).rejects.toThrow(/Missing Permissions/);
		await bot.close();
	});
});
