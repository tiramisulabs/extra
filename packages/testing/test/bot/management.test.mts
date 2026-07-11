import { Command, type CommandContext, Declare } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { apiUser } from '../../src/bot/payloads';
import { MockApiError } from '../../src/bot/rest';
import { mockWorld } from '../../src/bot/world';

describe('management routes', () => {
	test('editRole renames a role in the world', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'edit-role-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'edit-role-actor' }) });
		const role = world.registerRole(guild.id, { id: 'edit-role-target', name: 'before' });
		const channel = world.registerChannel(guild.id);

		@Declare({ name: 'rename-role', description: 'Renames a role' })
		class RenameRole extends Command {
			async run(ctx: CommandContext) {
				const updated = await ctx.client.roles.edit(ctx.guildId ?? '', role.id, { name: 'after' });
				await ctx.write({ content: updated.name });
			}
		}

		const bot = await createMockBot({ commands: [RenameRole], world });
		await expect(
			bot.slash({ name: 'rename-role', guildId: guild.id, channel, user: actor.user }),
		).resolves.toMatchObject({ content: 'after' });
		expect(bot.world.query.role({ guildId: guild.id, id: role.id })?.name).toBe('after');
		await bot.close();
	});

	test('deleteRole removes a role from the world', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'delete-role-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'delete-role-actor' }) });
		const role = world.registerRole(guild.id, { id: 'delete-role-target' });
		world.registerMember(guild.id, { user: apiUser({ id: 'delete-role-member' }), roles: [role.id] });
		const channel = world.registerChannel(guild.id);

		@Declare({ name: 'drop-role', description: 'Deletes a role' })
		class DropRole extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.roles.delete(ctx.guildId ?? '', role.id);
				await ctx.write({ content: 'deleted' });
			}
		}

		const bot = await createMockBot({ commands: [DropRole], world });
		expect(bot.world.query.role({ guildId: guild.id, id: role.id })).toBeDefined();
		await expect(bot.slash({ name: 'drop-role', guildId: guild.id, channel, user: actor.user })).resolves.toMatchObject(
			{ content: 'deleted' },
		);
		expect(bot.world.query.role({ guildId: guild.id, id: role.id })).toBeUndefined();
		expect(bot.world.query.member({ guildId: guild.id, userId: 'delete-role-member' })?.roles).toEqual([]);
		await bot.close();
	});

	test('editGuild renames the guild in the world', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'edit-guild-guild', name: 'before' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'edit-guild-actor' }) });
		const channel = world.registerChannel(guild.id);

		@Declare({ name: 'rename-guild', description: 'Renames the guild' })
		class RenameGuild extends Command {
			async run(ctx: CommandContext) {
				const updated = await ctx.client.guilds.edit(ctx.guildId ?? '', { name: 'after' });
				await ctx.write({ content: updated.name });
			}
		}

		const bot = await createMockBot({ commands: [RenameGuild], world });
		await expect(
			bot.slash({ name: 'rename-guild', guildId: guild.id, channel, user: actor.user }),
		).resolves.toMatchObject({ content: 'after' });
		expect(bot.world.query.guild({ id: guild.id })?.name).toBe('after');
		await bot.close();
	});

	test('fetchBan returns the ban for a banned user and 404s for a non-banned user', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'fetch-ban-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'fetch-ban-actor' }) });
		const target = world.registerMember(guild.id, { user: apiUser({ id: 'fetch-ban-target' }) });
		const channel = world.registerChannel(guild.id);

		@Declare({ name: 'ban-then-fetch', description: 'Bans the target then fetches the ban' })
		class BanThenFetch extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.members.ban(ctx.guildId ?? '', target.user.id);
				const ban = await ctx.client.bans.fetch(ctx.guildId ?? '', target.user.id, true);
				await ctx.write({ content: ban.id });
			}
		}

		@Declare({ name: 'fetch-missing-ban', description: 'Fetches a ban that does not exist' })
		class FetchMissingBan extends Command {
			async run(ctx: CommandContext) {
				try {
					await ctx.client.bans.fetch(ctx.guildId ?? '', 'never-banned', true);
					await ctx.write({ content: 'found' });
				} catch (error) {
					await ctx.write({ content: error instanceof MockApiError ? error.message : 'other error' });
				}
			}
		}

		const bot = await createMockBot({ commands: [BanThenFetch, FetchMissingBan], world });
		await expect(
			bot.slash({ name: 'ban-then-fetch', guildId: guild.id, channel, user: actor.user }),
		).resolves.toMatchObject({ content: target.user.id });
		await expect(
			bot.slash({ name: 'fetch-missing-ban', guildId: guild.id, channel, user: actor.user }),
		).resolves.toMatchObject({ content: 'Unknown Ban' });
		await bot.close();
	});

	test('editChannelPermissions sets an overwrite and deleteChannelPermission removes it', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'overwrite-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'overwrite-actor' }) });
		const channel = world.registerChannel(guild.id);
		const role = world.registerRole(guild.id, { id: 'overwrite-role' });

		@Declare({ name: 'set-overwrite', description: 'Sets a permission overwrite' })
		class SetOverwrite extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.channels.editOverwrite(
					channel.id,
					role.id,
					{ type: 0, allow: ['ViewChannel'] },
					{ guildId: ctx.guildId },
				);
				await ctx.write({ content: 'set' });
			}
		}

		@Declare({ name: 'clear-overwrite', description: 'Removes a permission overwrite' })
		class ClearOverwrite extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.channels.deleteOverwrite(channel.id, role.id, { guildId: ctx.guildId });
				await ctx.write({ content: 'cleared' });
			}
		}

		const bot = await createMockBot({ commands: [SetOverwrite, ClearOverwrite], world });
		await expect(
			bot.slash({ name: 'set-overwrite', guildId: guild.id, channel, user: actor.user }),
		).resolves.toMatchObject({ content: 'set' });
		const overwrite = bot.world.query
			.channel({ guildId: guild.id, id: channel.id })
			?.overwrites.find(entry => entry.id === role.id);
		expect(overwrite).toMatchObject({ id: role.id, type: 0, deny: '0' });
		expect(BigInt(overwrite?.allow ?? '0')).toBeGreaterThan(0n);
		await expect(
			bot.slash({ name: 'clear-overwrite', guildId: guild.id, channel, user: actor.user }),
		).resolves.toMatchObject({ content: 'cleared' });
		expect(
			bot.world.query.channel({ guildId: guild.id, id: channel.id })?.overwrites.find(entry => entry.id === role.id),
		).toBeUndefined();
		await bot.close();
	});
});
