import { Command, type CommandContext, createEvent, Declare } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { apiMember, apiUser } from '../../src/bot/payloads';
import { apiError, MockApiError } from '../../src/bot/rest';
import { Routes } from '../../src/bot/routes';
import { mockWorld } from '../../src/bot/world';

const englishLang = { greeting: 'Hello!' };

declare module 'seyfert' {
	interface SeyfertRegistry {
		langs: typeof englishLang;
	}
}

describe('stateful world defaults', () => {
	test('world-backed member reads, synthetic reads, and user intercept overrides work', async () => {
		const targetId = 'fetch-target';

		@Declare({ name: 'fetch-member-world', description: 'Fetches a member through REST' })
		class FetchMemberWorld extends Command {
			async run(ctx: CommandContext) {
				const member = await ctx.client.members.raw(ctx.guildId ?? 'synthetic-guild', targetId, true);
				await ctx.write({ content: `${member.user.username}:${member.roles.join(',')}` });
			}
		}

		const world = mockWorld();
		const guild = world.registerGuild({ id: 'fetch-guild' });
		const role = world.registerRole(guild.id, { id: 'seed-role' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'fetch-actor' }) });
		world.registerMember(guild.id, { user: apiUser({ id: targetId, username: 'seeded' }), roles: [role.id] });
		const channel = world.registerChannel(guild.id);
		const bot = await createMockBot({ commands: [FetchMemberWorld], world });
		await expect(
			bot.slash({ name: 'fetch-member-world', guildId: guild.id, channel, user: actor.user }),
		).resolves.toMatchObject({ content: 'seeded:seed-role' });
		bot.rest.intercept(Routes.fetchMember, () =>
			apiMember({ user: apiUser({ id: targetId, username: 'stubbed' }), roles: ['stub-role'] }),
		);
		await expect(
			bot.slash({ name: 'fetch-member-world', guildId: guild.id, channel, user: actor.user }),
		).resolves.toMatchObject({ content: 'stubbed:stub-role' });
		await bot.close();

		const synthetic = await createMockBot({ commands: [FetchMemberWorld] });
		await expect(synthetic.slash({ name: 'fetch-member-world' })).resolves.toMatchObject({
			content: 'slipher-test-user:',
		});
		await synthetic.close();
	});

	test('ban removes the member from world, cache, later REST fetches, and emits remove events', async () => {
		const removed: string[] = [];
		const onRemove = createEvent({
			data: { name: 'guildMemberRemove' },
			run(member) {
				removed.push(member.user.id);
			},
		});
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'ban-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'ban-actor' }) });
		const target = world.registerMember(guild.id, { user: apiUser({ id: 'ban-target' }) });
		const channel = world.registerChannel(guild.id);

		@Declare({ name: 'ban-target', description: 'Bans the target' })
		class BanTarget extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.members.ban(ctx.guildId ?? '', target.user.id);
				await ctx.write({ content: 'banned' });
			}
		}

		@Declare({ name: 'fetch-banned', description: 'Fetches the banned target' })
		class FetchBanned extends Command {
			async run(ctx: CommandContext) {
				try {
					await ctx.client.members.fetch(ctx.guildId ?? '', target.user.id, true);
					await ctx.write({ content: 'found' });
				} catch (error) {
					await ctx.write({ content: error instanceof MockApiError ? error.message : 'other error' });
				}
			}
		}

		const bot = await createMockBot({ commands: [BanTarget, FetchBanned], events: [onRemove], world });
		await expect(
			bot.slash({ name: 'ban-target', guildId: guild.id, channel, user: actor.user }),
		).resolves.toMatchObject({
			content: 'banned',
		});
		expect(bot.world.query.member({ guildId: guild.id, userId: target.user.id })).toBeUndefined();
		expect(bot.world.query.guild({ id: guild.id })?.bans).toContain(target.user.id);
		await expect(Promise.resolve(bot.client.cache.members?.get(target.user.id, guild.id))).resolves.toBeUndefined();
		await expect(
			bot.slash({ name: 'fetch-banned', guildId: guild.id, channel, user: actor.user }),
		).resolves.toMatchObject({
			content: 'Unknown Member',
		});
		expect(removed).toEqual([target.user.id]);
		await bot.close();
	});

	test('role writes and member timeouts mutate the world and respect simulateGateway', async () => {
		const updates: string[] = [];
		const onUpdate = createEvent({
			data: { name: 'guildMemberUpdate' },
			run([member]) {
				updates.push(member.user.id);
			},
		});
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'mutate-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'mutate-actor' }) });
		const target = world.registerMember(guild.id, { user: apiUser({ id: 'mutate-target' }) });
		const role = world.registerRole(guild.id, { id: 'mutated-role' });
		const channel = world.registerChannel(guild.id);
		const timeoutAt = new Date(Date.now() + 60_000).toISOString();

		@Declare({ name: 'mutate-member', description: 'Mutates a member' })
		class MutateMember extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.members.addRole(ctx.guildId ?? '', target.user.id, role.id);
				await ctx.client.members.edit(ctx.guildId ?? '', target.user.id, {
					communication_disabled_until: timeoutAt,
				});
				const member = await ctx.client.members.raw(ctx.guildId ?? '', target.user.id, true);
				await ctx.write({ content: `${member.roles.join(',')}:${member.communication_disabled_until}` });
			}
		}

		const bot = await createMockBot({ commands: [MutateMember], events: [onUpdate], world, simulateGateway: false });
		const result = await bot.slash({ name: 'mutate-member', guildId: guild.id, channel, user: actor.user });
		expect(result.content).toBe(`${role.id}:${timeoutAt}`);
		expect(bot.world.query.member({ guildId: guild.id, userId: target.user.id })?.roles).toEqual([role.id]);
		expect(bot.world.query.member({ guildId: guild.id, userId: target.user.id })?.communicationDisabledUntil).toBe(
			timeoutAt,
		);
		expect(updates).toEqual([]);
		await bot.close();
	});

	test('ctx.member role manager add/remove mutates the world state', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'member-manager-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'member-manager-actor' }) });
		const role = world.registerRole(guild.id, { id: 'member-manager-role' });
		const channel = world.registerChannel(guild.id);

		@Declare({ name: 'add-self-role', description: 'Adds a role through ctx.member.roles' })
		class AddSelfRole extends Command {
			async run(ctx: CommandContext) {
				await ctx.member!.roles.add(role.id);
				await ctx.write({ content: 'added' });
			}
		}

		@Declare({ name: 'remove-self-role', description: 'Removes a role through ctx.member.roles' })
		class RemoveSelfRole extends Command {
			async run(ctx: CommandContext) {
				await ctx.member!.roles.remove(role.id);
				await ctx.write({ content: 'removed' });
			}
		}

		const bot = await createMockBot({ commands: [AddSelfRole, RemoveSelfRole], world });
		await bot.slash({ name: 'add-self-role', guildId: guild.id, channel, user: actor.user });
		expect(bot.world.query.member({ guildId: guild.id, userId: actor.user.id })?.roles).toContain(role.id);

		await bot.slash({ name: 'remove-self-role', guildId: guild.id, channel, user: actor.user });
		expect(bot.world.query.member({ guildId: guild.id, userId: actor.user.id })?.roles).not.toContain(role.id);
		await bot.close();
	});

	test('apiError responders propagate to command catch paths while recording the action', async () => {
		@Declare({ name: 'catch-rest-error', description: 'Catches REST errors' })
		class CatchRestError extends Command {
			async run(ctx: CommandContext) {
				try {
					await ctx.client.members.ban(ctx.guildId ?? '', 'error-target');
					await ctx.write({ content: 'banned' });
				} catch {
					await ctx.write({ content: 'no permission' });
				}
			}
		}

		const bot = await createMockBot({ commands: [CatchRestError] });
		bot.rest.intercept(Routes.ban, () => apiError(403, 50013, 'Missing Permissions'));
		const result = await bot.slash({ name: 'catch-rest-error' });
		expect(result.content).toBe('no permission');
		expect(bot.findAction(Routes.ban)).toMatchObject({ method: 'PUT' });
		await bot.close();
	});

	test('fetchBans lists banned members and unban clears them from the world', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'ban-list-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'ban-list-actor' }) });
		const target = world.registerMember(guild.id, { user: apiUser({ id: 'ban-list-target' }) });
		const channel = world.registerChannel(guild.id);

		@Declare({ name: 'ban-then-list', description: 'Bans the target then lists bans' })
		class BanThenList extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.members.ban(ctx.guildId ?? '', target.user.id);
				const bans = await ctx.client.bans.list(ctx.guildId ?? '', undefined, true);
				await ctx.write({ content: bans.map(ban => ban.user.id).join(',') });
			}
		}

		@Declare({ name: 'unban-then-list', description: 'Unbans the target then lists bans' })
		class UnbanThenList extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.bans.remove(ctx.guildId ?? '', target.user.id);
				const bans = await ctx.client.bans.list(ctx.guildId ?? '', undefined, true);
				await ctx.write({ content: bans.length ? bans.map(ban => ban.user.id).join(',') : 'none' });
			}
		}

		const bot = await createMockBot({ commands: [BanThenList, UnbanThenList], world });
		await expect(
			bot.slash({ name: 'ban-then-list', guildId: guild.id, channel, user: actor.user }),
		).resolves.toMatchObject({ content: target.user.id });
		expect(bot.world.query.guild({ id: guild.id })?.bans).toContain(target.user.id);
		await expect(
			bot.slash({ name: 'unban-then-list', guildId: guild.id, channel, user: actor.user }),
		).resolves.toMatchObject({ content: 'none' });
		expect(bot.world.query.guild({ id: guild.id }), 'guild must exist in the world').toBeDefined();
		expect(bot.world.query.guild({ id: guild.id })?.bans).not.toContain(target.user.id);
		await bot.close();
	});

	test('editChannel patches the channel name in the world', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'edit-channel-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'edit-channel-actor' }) });
		const channel = world.registerChannel(guild.id, { name: 'before' });

		@Declare({ name: 'rename-channel', description: 'Renames a channel' })
		class RenameChannel extends Command {
			async run(ctx: CommandContext) {
				const updated = await ctx.client.channels.edit(channel.id, { name: 'after' }, { guildId: ctx.guildId });
				await ctx.write({ content: 'name' in updated ? (updated.name ?? '') : '' });
			}
		}

		const bot = await createMockBot({ commands: [RenameChannel], world });
		await expect(
			bot.slash({ name: 'rename-channel', guildId: guild.id, channel, user: actor.user }),
		).resolves.toMatchObject({ content: 'after' });
		expect(bot.world.query.channel({ guildId: guild.id, id: channel.id })?.name).toBe('after');
		await bot.close();
	});

	test('an unhandled modeled route fails loud under onUnhandledRest: error', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'fail-loud-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'fail-loud-actor' }) });
		const channel = world.registerChannel(guild.id);

		@Declare({ name: 'crosspost', description: 'Crossposts a message' })
		class Crosspost extends Command {
			async run(ctx: CommandContext) {
				try {
					await ctx.client.messages.crosspost('some-message', channel.id);
					await ctx.write({ content: 'created' });
				} catch {
					await ctx.write({ content: 'rejected' });
				}
			}
		}

		const bot = await createMockBot({ commands: [Crosspost], world, onUnhandledRest: 'error' });
		await expect(bot.slash({ name: 'crosspost', guildId: guild.id, channel, user: actor.user })).resolves.toMatchObject(
			{ content: 'rejected' },
		);
		await bot.close();
	});

	test('world-backed user fetches return seeded users and reject missing users', async () => {
		@Declare({ name: 'fetch-users', description: 'Fetches users through REST' })
		class FetchUsers extends Command {
			async run(ctx: CommandContext) {
				const seeded = await ctx.client.users.fetch('seed-user', true);
				try {
					await ctx.client.users.fetch('missing-user', true);
					await ctx.write({ content: 'missing passed' });
				} catch (error) {
					await ctx.write({ content: `${seeded.username}:${error instanceof MockApiError ? error.message : 'error'}` });
				}
			}
		}

		const world = mockWorld();
		const guild = world.registerGuild();
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'user-fetch-actor' }) });
		const channel = world.registerChannel(guild.id);
		world.registerUser({ id: 'seed-user', username: 'Seeded' });
		const bot = await createMockBot({ commands: [FetchUsers], world });
		const result = await bot.slash({ name: 'fetch-users', guildId: guild.id, channel, user: actor.user });
		expect(result.content).toBe('Seeded:Unknown User');
		await bot.close();
	});
});
