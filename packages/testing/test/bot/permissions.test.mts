import { Command, type CommandContext, Declare } from 'seyfert';
import { PermissionFlagsBits } from 'seyfert/lib/types';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { chatInputInteraction } from '../../src/bot/interactions';
import { apiRole, apiUser } from '../../src/bot/payloads';
import {
	ALL_PERMISSIONS,
	combineRolePermissions,
	computeChannelPermissions,
	permissionBits,
} from '../../src/bot/permissions';
import { mockWorld } from '../../src/bot/world';

const englishLang = { greeting: 'Hello!' };

declare module 'seyfert' {
	interface SeyfertRegistry {
		langs: typeof englishLang;
	}
}

describe('permission helpers', () => {
	test('permissionBits normalizes named permissions and rejects unknown names', () => {
		expect(permissionBits(['BanMembers', 'KickMembers'])).toBe(
			(PermissionFlagsBits.BanMembers | PermissionFlagsBits.KickMembers).toString(),
		);
		expect(() => permissionBits(['NotRealPermission' as keyof typeof PermissionFlagsBits])).toThrow(/Valid names/);
	});

	test('combineRolePermissions ORs role bitfields', () => {
		expect(
			combineRolePermissions([
				{ permissions: permissionBits(['BanMembers']) },
				{ permissions: permissionBits(['KickMembers']) },
			]),
		).toBe((PermissionFlagsBits.BanMembers | PermissionFlagsBits.KickMembers).toString());
	});

	test('computeChannelPermissions follows owner, admin, overwrite, and timeout rules', () => {
		const guild = { id: 'guild', owner_id: 'owner' };
		const everyone = {
			id: guild.id,
			permissions: permissionBits(['ViewChannel', 'ReadMessageHistory', 'SendMessages']),
		};
		const mod = { id: 'mod', permissions: permissionBits(['BanMembers', 'KickMembers']) };

		expect(
			computeChannelPermissions({
				guild,
				roles: [everyone, mod],
				member: { userId: 'owner', roles: [] },
			}),
		).toBe(ALL_PERMISSIONS.toString());

		expect(
			computeChannelPermissions({
				guild,
				roles: [everyone, { id: 'admin', permissions: permissionBits(['Administrator']) }],
				member: { userId: 'admin-user', roles: ['admin'] },
			}),
		).toBe(ALL_PERMISSIONS.toString());

		expect(
			computeChannelPermissions({
				guild,
				roles: [everyone, mod],
				member: { userId: 'member', roles: [mod.id] },
				channel: {
					permission_overwrites: [
						{ id: mod.id, type: 0, allow: '0', deny: permissionBits(['BanMembers']) },
						{ id: 'member', type: 1, allow: permissionBits(['BanMembers']), deny: '0' },
					],
				},
			}),
		).toBe(permissionBits(['ViewChannel', 'ReadMessageHistory', 'SendMessages', 'BanMembers', 'KickMembers']));

		expect(
			computeChannelPermissions({
				guild,
				roles: [everyone],
				member: { userId: 'member', roles: [] },
				channel: {
					permission_overwrites: [
						{ id: guild.id, type: 0, allow: permissionBits(['KickMembers']), deny: permissionBits(['SendMessages']) },
						{ id: guild.id, type: 0, allow: permissionBits(['Administrator']), deny: '0' },
					],
				},
			}),
		).toBe(permissionBits(['ViewChannel', 'ReadMessageHistory', 'KickMembers']));

		expect(() =>
			computeChannelPermissions({
				guild,
				roles: [mod],
				member: { userId: 'member', roles: [mod.id] },
			}),
		).toThrow(/@everyone role/);

		expect(
			computeChannelPermissions({
				guild,
				roles: [everyone, mod],
				member: {
					userId: 'member',
					roles: [mod.id],
					communicationDisabledUntil: new Date(Date.now() + 60_000).toISOString(),
				},
			}),
		).toBe(permissionBits(['ViewChannel', 'ReadMessageHistory']));

		expect(
			computeChannelPermissions({
				guild,
				roles: [everyone, mod],
				member: { userId: 'member', roles: [mod.id], communicationDisabledUntil: new Date(0).toISOString() },
			}),
		).toBe(permissionBits(['ViewChannel', 'ReadMessageHistory', 'SendMessages', 'BanMembers', 'KickMembers']));
	});
});

describe('permission emulation', () => {
	test('fires bot and member permission failure hooks from payload bitfields', async () => {
		let botRun = false;
		let memberRun = false;

		@Declare({ name: 'needs-bot-ban', description: 'Needs bot ban permission', botPermissions: ['BanMembers'] })
		class NeedsBotBan extends Command {
			async onBotPermissionsFail(ctx: CommandContext) {
				await ctx.editOrReply({ content: 'missing bot perms' });
			}
			async run(ctx: CommandContext) {
				botRun = true;
				await ctx.write({ content: 'bot ok' });
			}
		}

		@Declare({
			name: 'needs-member-ban',
			description: 'Needs member ban permission',
			defaultMemberPermissions: ['BanMembers'],
		})
		class NeedsMemberBan extends Command {
			async onPermissionsFail(ctx: CommandContext) {
				await ctx.editOrReply({ content: 'missing member perms' });
			}
			async run(ctx: CommandContext) {
				memberRun = true;
				await ctx.write({ content: 'member ok' });
			}
		}

		const bot = await createMockBot({ commands: [NeedsBotBan, NeedsMemberBan] });
		await expect(bot.slash({ name: 'needs-bot-ban', permissions: [] })).resolves.toMatchObject({
			content: 'missing bot perms',
		});
		await expect(bot.slash({ name: 'needs-member-ban', memberPermissions: [] })).resolves.toMatchObject({
			content: 'missing member perms',
		});
		expect(botRun).toBe(false);
		expect(memberRun).toBe(false);
		await bot.close();
	});

	test('memberRoles grant permissions and populate the payload member roles', async () => {
		const banRole = apiRole({ id: 'ban-role', permissions: permissionBits(['BanMembers']) });

		@Declare({
			name: 'member-role-pass',
			description: 'Needs member role permission',
			defaultMemberPermissions: ['BanMembers'],
		})
		class MemberRolePass extends Command {
			async onPermissionsFail(ctx: CommandContext) {
				await ctx.editOrReply({ content: 'missing member perms' });
			}
			async run(ctx: CommandContext) {
				await ctx.write({ content: 'member ok' });
			}
		}

		const payload = chatInputInteraction({ name: 'member-role-pass', memberRoles: [banRole] });
		expect(payload.member?.roles).toContain(banRole.id);
		const bot = await createMockBot({ commands: [MemberRolePass] });
		const result = await bot.slash({ name: 'member-role-pass', memberRoles: [banRole] });
		expect(result.content).toBe('member ok');
		await bot.close();
	});

	test('computes member permissions from world roles and channel overwrites', async () => {
		@Declare({
			name: 'world-member-ban',
			description: 'Needs computed member ban permission',
			defaultMemberPermissions: ['BanMembers'],
		})
		class WorldMemberBan extends Command {
			async onPermissionsFail(ctx: CommandContext) {
				await ctx.editOrReply({ content: 'missing member perms' });
			}
			async run(ctx: CommandContext) {
				await ctx.write({ content: 'member ok' });
			}
		}

		const world = mockWorld();
		const guild = world.registerGuild({
			id: 'world-guild',
			ownerId: 'owner-user',
			everyonePermissions: ['SendMessages'],
		});
		const banRole = world.registerRole(guild.id, { id: 'ban-role', permissions: ['BanMembers'], position: 1 });
		const member = world.registerMember(guild.id, { user: apiUser({ id: 'member-user' }), roles: [banRole.id] });
		const owner = world.registerMember(guild.id, { user: apiUser({ id: guild.owner_id }) });
		const plain = world.registerChannel(guild.id, { id: 'plain-channel' });
		const denied = world.registerChannel(guild.id, {
			id: 'denied-channel',
			overwrites: [{ id: banRole.id, type: 'role', deny: ['BanMembers'] }],
		});

		const bot = await createMockBot({ commands: [WorldMemberBan], world });
		await expect(
			bot.slash({ name: 'world-member-ban', guildId: guild.id, channel: plain, user: member.user }),
		).resolves.toMatchObject({ content: 'member ok' });
		await expect(
			bot.slash({ name: 'world-member-ban', guildId: guild.id, channel: denied, user: member.user }),
		).resolves.toMatchObject({ content: 'missing member perms' });
		await expect(
			bot.slash({ name: 'world-member-ban', guildId: guild.id, channel: denied, user: owner.user }),
		).resolves.toMatchObject({ content: 'member ok' });
		await expect(
			bot.slash({
				name: 'world-member-ban',
				guildId: guild.id,
				channel: denied,
				user: member.user,
				memberPermissions: ['Administrator'],
			}),
		).resolves.toMatchObject({ content: 'member ok' });
		expect(() => bot.slash({ name: 'world-member-ban', guildId: 'missing-guild', user: member.user })).toThrow(
			/Seeded guilds: world-guild/,
		);
		await bot.close();
	});

	test('computes app permissions from the seeded bot member', async () => {
		@Declare({
			name: 'world-bot-ban',
			description: 'Needs computed bot ban permission',
			botPermissions: ['BanMembers'],
		})
		class WorldBotBan extends Command {
			async onBotPermissionsFail(ctx: CommandContext) {
				await ctx.editOrReply({ content: 'missing bot perms' });
			}
			async run(ctx: CommandContext) {
				await ctx.write({ content: 'bot ok' });
			}
		}

		const world = mockWorld();
		const guild = world.registerGuild({ id: 'bot-perm-guild' });
		const weakRole = world.registerRole(guild.id, { id: 'weak-role', permissions: ['SendMessages'] });
		const member = world.registerMember(guild.id, { user: apiUser({ id: 'actor-user' }) });
		const channel = world.registerChannel(guild.id);
		world.registerBotMember(guild.id, { roles: [weakRole.id] });
		const bot = await createMockBot({ commands: [WorldBotBan], world });
		const result = await bot.slash({ name: 'world-bot-ban', guildId: guild.id, channel, user: member.user });
		expect(result.content).toBe('missing bot perms');
		await bot.close();
	});

	test('invoking member defaults to a non-admin permission set', async () => {
		let ran = false;

		@Declare({
			name: 'needs-ban-default',
			description: 'Requires BanMembers',
			defaultMemberPermissions: ['BanMembers'],
		})
		class NeedsBanDefault extends Command {
			async onPermissionsFail(ctx: CommandContext) {
				await ctx.editOrReply({ content: 'denied' });
			}
			async run(ctx: CommandContext) {
				ran = true;
				await ctx.write({ content: 'ran' });
			}
		}

		const bot = await createMockBot({ commands: [NeedsBanDefault] });

		await expect(bot.slash({ name: 'needs-ban-default' })).resolves.toMatchObject({ content: 'denied' });
		expect(ran).toBe(false);

		await expect(
			bot.slash({ name: 'needs-ban-default', memberPermissions: ALL_PERMISSIONS }),
		).resolves.toMatchObject({ content: 'ran' });
		expect(ran).toBe(true);

		ran = false;
		await expect(bot.slash({ name: 'needs-ban-default', memberPermissions: 'all' })).resolves.toMatchObject({
			content: 'ran',
		});
		expect(ran).toBe(true);

		ran = false;
		await expect(
			bot.slash({ name: 'needs-ban-default', memberPermissions: ['BanMembers'] }),
		).resolves.toMatchObject({ content: 'ran' });
		expect(ran).toBe(true);

		await bot.close();
	});

	test('role positions are available through the real cache for hierarchy checks', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'hierarchy-guild' });
		const mod = world.registerRole(guild.id, { id: 'mod-role', name: 'mod', position: 5 });
		const admin = world.registerRole(guild.id, { id: 'admin-role', name: 'admin', position: 10 });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'mod-user' }), roles: [mod.id] });
		const target = world.registerMember(guild.id, { user: apiUser({ id: 'admin-user' }), roles: [admin.id] });
		const channel = world.registerChannel(guild.id);
		let targetUserId = target.user.id;

		@Declare({ name: 'hierarchy-check', description: 'Checks cached role hierarchy' })
		class HierarchyCheck extends Command {
			async run(ctx: CommandContext) {
				const roles = await ctx.client.cache.roles?.values(ctx.guildId ?? '');
				const actorMember = await ctx.client.members.raw(ctx.guildId ?? '', ctx.author.id, true);
				const targetMember = await ctx.client.members.raw(ctx.guildId ?? '', targetUserId, true);
				const position = (roleId: string) => roles?.find(role => role.id === roleId)?.position ?? 0;
				const actorTop = Math.max(0, ...actorMember.roles.map(position));
				const targetTop = Math.max(0, ...targetMember.roles.map(position));
				await ctx.write({ content: targetTop > actorTop ? 'target outranks you' : 'can moderate' });
			}
		}

		const bot = await createMockBot({ commands: [HierarchyCheck], world });
		await expect(
			bot.slash({ name: 'hierarchy-check', guildId: guild.id, channel, user: actor.user }),
		).resolves.toMatchObject({ content: 'target outranks you' });
		targetUserId = actor.user.id;
		await expect(
			bot.slash({ name: 'hierarchy-check', guildId: guild.id, channel, user: target.user }),
		).resolves.toMatchObject({ content: 'can moderate' });
		await bot.close();
	});
});
