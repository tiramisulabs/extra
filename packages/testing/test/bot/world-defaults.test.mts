import { Command, type CommandContext, createEvent, Declare, type ParseLocales } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { apiMember, apiUser } from '../../src/bot/payloads';
import { apiError, MockApiError } from '../../src/bot/rest';
import { Routes } from '../../src/bot/routes';
import { mockWorld } from '../../src/bot/world';

const englishLang = { greeting: 'Hello!' };

declare module 'seyfert' {
	interface DefaultLocale extends ParseLocales<typeof englishLang> {}
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
		expect(bot.guild(guild.id)?.member(target.user.id)).toBeUndefined();
		expect(bot.guild(guild.id)?.bans).toContain(target.user.id);
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
		expect(bot.guild(guild.id)?.member(target.user.id)?.roles).toEqual([role.id]);
		expect(bot.guild(guild.id)?.member(target.user.id)?.communicationDisabledUntil).toBe(timeoutAt);
		expect(updates).toEqual([]);
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
		expect(bot.call(Routes.ban)).toMatchObject({ method: 'PUT' });
		await bot.close();
	});

	test('world-backed user fetches return seeded and synthetic users', async () => {
		@Declare({ name: 'fetch-users', description: 'Fetches users through REST' })
		class FetchUsers extends Command {
			async run(ctx: CommandContext) {
				const seeded = await ctx.client.users.fetch('seed-user', true);
				const synthetic = await ctx.client.users.fetch('missing-user', true);
				await ctx.write({ content: `${seeded.username}:${synthetic.id}` });
			}
		}

		const world = mockWorld();
		const guild = world.registerGuild();
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'user-fetch-actor' }) });
		const channel = world.registerChannel(guild.id);
		world.registerUser({ id: 'seed-user', username: 'Seeded' });
		const bot = await createMockBot({ commands: [FetchUsers], world });
		const result = await bot.slash({ name: 'fetch-users', guildId: guild.id, channel, user: actor.user });
		expect(result.content).toBe('Seeded:missing-user');
		await bot.close();
	});
});
