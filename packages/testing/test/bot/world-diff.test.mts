import { Command, type CommandContext, Declare } from 'seyfert';
import { ChannelType } from 'seyfert/lib/types';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { apiUser } from '../../src/bot/payloads';
import { mockWorld } from '../../src/bot/world';

describe('world snapshot and diff', () => {
	test('diff reports a role grant, a ban, and a created channel without point queries', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'diff-guild' });
		const role = world.registerRole(guild.id, { id: 'diff-role' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'diff-actor' }) });
		world.registerMember(guild.id, { user: apiUser({ id: 'diff-target' }), roles: [] });
		world.registerMember(guild.id, { user: apiUser({ id: 'diff-ban-target' }) });
		const channel = world.registerChannel(guild.id, { id: 'diff-channel' });

		@Declare({ name: 'mutate-world', description: 'Grants a role, bans a user, creates a channel' })
		class MutateWorld extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.members.addRole(ctx.guildId ?? '', 'diff-target', role.id);
				await ctx.client.members.ban(ctx.guildId ?? '', 'diff-ban-target');
				await ctx.client.guilds.channels.create(ctx.guildId ?? '', {
					name: 'created-chan',
					type: ChannelType.GuildText,
				});
				await ctx.write({ content: 'done' });
			}
		}

		const bot = await createMockBot({ commands: [MutateWorld], world });
		const before = bot.worldSnapshot();
		await bot.slash({ name: 'mutate-world', guildId: guild.id, channel, user: actor.user });
		const diff = bot.worldDiff(before);

		const changedMember = diff.members.changed.find(entry => entry.after.userId === 'diff-target');
		expect(changedMember?.fields).toContain('roles');
		expect(changedMember?.after.roles).toContain(role.id);

		expect(diff.bans.added).toContainEqual({ guildId: guild.id, userId: 'diff-ban-target' });
		expect(diff.members.removed.map(entry => entry.userId)).toContain('diff-ban-target');

		expect(diff.channels.added.map(entry => entry.name)).toContain('created-chan');
		await bot.close();
	});

	test('a captured snapshot is immutable across later dispatches', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'immutable-guild' });
		const role = world.registerRole(guild.id, { id: 'immutable-role' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'immutable-actor' }) });
		world.registerMember(guild.id, { user: apiUser({ id: 'immutable-target' }), roles: [] });
		const channel = world.registerChannel(guild.id);

		@Declare({ name: 'grant-role', description: 'Grants a role' })
		class GrantRole extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.members.addRole(ctx.guildId ?? '', 'immutable-target', role.id);
				await ctx.write({ content: 'granted' });
			}
		}

		const bot = await createMockBot({ commands: [GrantRole], world });
		const before = bot.worldSnapshot();
		const targetBefore = before.members.find(entry => entry.userId === 'immutable-target');
		expect(targetBefore?.roles).toEqual([]);

		await bot.slash({ name: 'grant-role', guildId: guild.id, channel, user: actor.user });

		expect(Object.isFrozen(before)).toBe(true);
		expect(Object.isFrozen(targetBefore)).toBe(true);
		expect(targetBefore?.roles).toEqual([]);
		expect(bot.cachedMember(guild.id, 'immutable-target')?.roles).toContain(role.id);
		await bot.close();
	});

	test('a no-op dispatch yields an empty diff', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'noop-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'noop-actor' }) });
		const channel = world.registerChannel(guild.id);

		@Declare({ name: 'noop', description: 'Does nothing stateful' })
		class NoOp extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.guilds.fetch(ctx.guildId ?? '');
			}
		}

		const bot = await createMockBot({ commands: [NoOp], world });
		const before = bot.worldSnapshot();
		await bot.slash({ name: 'noop', guildId: guild.id, channel, user: actor.user });
		const diff = bot.worldDiff(before);

		for (const entity of [diff.members, diff.channels, diff.messages, diff.roles, diff.bans]) {
			expect(entity.added).toEqual([]);
			expect(entity.removed).toEqual([]);
			expect(entity.changed).toEqual([]);
		}
		await bot.close();
	});
});
