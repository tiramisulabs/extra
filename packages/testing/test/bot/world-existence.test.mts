import { Command, type CommandContext, Declare } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { DiscordErrors } from '../../src/bot/rest';
import { seedGuildFixture } from './_setup';

describe('world-mode existence enforcement', () => {
	test('a ban against an unseeded guild is a 404, not a phantom ban (F15)', async () => {
		const { world, guild, actor, channel } = seedGuildFixture('exist');

		@Declare({ name: 'ban-ghost', description: 'bans in a guild that was never seeded' })
		class BanGhost extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.members.ban('ghost-guild', 'victim');
				await ctx.write({ content: 'banned' });
			}
		}

		const bot = await createMockBot({ commands: [BanGhost], world });
		await expect(bot.slash({ name: 'ban-ghost', guildId: guild.id, channel, user: actor.user })).rejects.toMatchObject({
			status: 404,
			code: DiscordErrors.UnknownGuild.code,
		});
		expect(bot.world.isBanned('ghost-guild', 'victim')).toBe(false);
		await bot.close();
	});

	test('writing to an unseeded channel is a 404 (F14)', async () => {
		const { world, guild, actor, channel } = seedGuildFixture('chan-exist');

		@Declare({ name: 'write-ghost', description: 'writes to a channel that was never seeded' })
		class WriteGhost extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.messages.write('ghost-channel', { content: 'hi' });
				await ctx.write({ content: 'sent' });
			}
		}

		const bot = await createMockBot({ commands: [WriteGhost], world });
		await expect(
			bot.slash({ name: 'write-ghost', guildId: guild.id, channel, user: actor.user }),
		).rejects.toMatchObject({
			code: DiscordErrors.UnknownChannel.code,
		});
		expect(bot.worldChannel('ghost-channel')).toBeUndefined();
		await bot.close();
	});

	test('editing a message the bot did not author is a 403 (F13)', async () => {
		const { world, guild, actor, channel } = seedGuildFixture('edit-foreign');
		world.registerMessage(channel.id, { id: 'human-msg', author: actor.user, content: 'theirs' });

		@Declare({ name: 'edit-foreign', description: 'edits a human-authored message' })
		class EditForeign extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.messages.edit('human-msg', channel.id, { content: 'hijacked' });
				await ctx.write({ content: 'edited' });
			}
		}

		const bot = await createMockBot({ commands: [EditForeign], world });
		await expect(
			bot.slash({ name: 'edit-foreign', guildId: guild.id, channel, user: actor.user }),
		).rejects.toMatchObject({ status: 403, code: DiscordErrors.CannotEditAnotherUsersMessage.code });
		expect(bot.worldMessage(channel.id, 'human-msg')?.content).toBe('theirs');
		await bot.close();
	});

	test('deleting a non-existent message is a 404 (F13)', async () => {
		const { world, guild, actor, channel } = seedGuildFixture('del-missing');

		@Declare({ name: 'del-missing', description: 'deletes a message that does not exist' })
		class DelMissing extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.messages.delete('nope', channel.id);
				await ctx.write({ content: 'deleted' });
			}
		}

		const bot = await createMockBot({ commands: [DelMissing], world });
		await expect(
			bot.slash({ name: 'del-missing', guildId: guild.id, channel, user: actor.user }),
		).rejects.toMatchObject({ code: DiscordErrors.UnknownMessage.code });
		await bot.close();
	});

	test('removing a reaction from a non-existent message is a 404, like adding (parity)', async () => {
		const { world, guild, actor, channel } = seedGuildFixture('react-missing');

		@Declare({ name: 'unreact-ghost', description: 'removes a reaction from a message that does not exist' })
		class UnreactGhost extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.reactions.delete('ghost-msg', channel.id, '👍');
				await ctx.write({ content: 'removed' });
			}
		}

		const bot = await createMockBot({ commands: [UnreactGhost], world });
		await expect(
			bot.slash({ name: 'unreact-ghost', guildId: guild.id, channel, user: actor.user }),
		).rejects.toMatchObject({ code: DiscordErrors.UnknownMessage.code });
		await bot.close();
	});

	test('editing a non-existent channel is a 404 (no phantom edit)', async () => {
		const { world, guild, actor, channel } = seedGuildFixture('chan-edit');

		@Declare({ name: 'edit-ghost-chan', description: 'edits a channel that was never seeded' })
		class EditGhostChan extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.channels.edit('ghost-channel', { name: 'renamed' });
				await ctx.write({ content: 'edited' });
			}
		}

		const bot = await createMockBot({ commands: [EditGhostChan], world });
		await expect(
			bot.slash({ name: 'edit-ghost-chan', guildId: guild.id, channel, user: actor.user }),
		).rejects.toMatchObject({ code: DiscordErrors.UnknownChannel.code });
		await bot.close();
	});

	test('fetching a ban in an unseeded guild is Unknown Guild, not Unknown Ban', async () => {
		const { world, guild, actor, channel } = seedGuildFixture('ban-fetch');

		@Declare({ name: 'fetch-ghost-ban', description: 'fetches a ban from a guild that was never seeded' })
		class FetchGhostBan extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.bans.fetch('ghost-guild', 'victim');
				await ctx.write({ content: 'fetched' });
			}
		}

		const bot = await createMockBot({ commands: [FetchGhostBan], world });
		await expect(
			bot.slash({ name: 'fetch-ghost-ban', guildId: guild.id, channel, user: actor.user }),
		).rejects.toMatchObject({ code: DiscordErrors.UnknownGuild.code });
		await bot.close();
	});

	test('editMember against a member that is not in the guild is a 404 Unknown Member', async () => {
		const { world, guild } = seedGuildFixture('em-missing');
		const bot = await createMockBot({ world });
		await expect(
			bot.rest.request('PATCH', `/guilds/${guild.id}/members/ghost-user`, { body: { nick: 'x' } }),
		).rejects.toMatchObject({ code: DiscordErrors.UnknownMember.code });
		await bot.close();
	});

	test('adding a role that does not exist writes no phantom role — 404 Unknown Role', async () => {
		const { world, guild, actor } = seedGuildFixture('ar-role');
		const bot = await createMockBot({ world });
		await expect(
			bot.rest.request('PUT', `/guilds/${guild.id}/members/${actor.user.id}/roles/ghost-role`),
		).rejects.toMatchObject({ code: DiscordErrors.UnknownRole.code });
		expect(bot.worldMember(guild.id, actor.user.id)?.roles ?? []).not.toContain('ghost-role');
		await bot.close();
	});

	test('adding a real role to a member that is not in the guild is a 404 Unknown Member', async () => {
		const { world, guild } = seedGuildFixture('ar-member');
		const role = world.registerRole(guild.id, { id: 'real-role' });
		const bot = await createMockBot({ world });
		await expect(
			bot.rest.request('PUT', `/guilds/${guild.id}/members/ghost-user/roles/${role.id}`),
		).rejects.toMatchObject({ code: DiscordErrors.UnknownMember.code });
		await bot.close();
	});

	test('editing/deleting a role that does not exist is a 404 Unknown Role', async () => {
		const { world, guild } = seedGuildFixture('role-missing');
		const bot = await createMockBot({ world });
		await expect(
			bot.rest.request('PATCH', `/guilds/${guild.id}/roles/ghost-role`, { body: { name: 'x' } }),
		).rejects.toMatchObject({ code: DiscordErrors.UnknownRole.code });
		await expect(bot.rest.request('DELETE', `/guilds/${guild.id}/roles/ghost-role`)).rejects.toMatchObject({
			code: DiscordErrors.UnknownRole.code,
		});
		await bot.close();
	});

	test('unbanning a user who is not banned is a 404 Unknown Ban', async () => {
		const { world, guild } = seedGuildFixture('unban-missing');
		const bot = await createMockBot({ world });
		await expect(bot.rest.request('DELETE', `/guilds/${guild.id}/bans/never-banned`)).rejects.toMatchObject({
			code: DiscordErrors.UnknownBan.code,
		});
		await bot.close();
	});

	test('deleting an invite that does not exist is a 404 Unknown Invite', async () => {
		const { world } = seedGuildFixture('inv-missing');
		const bot = await createMockBot({ world });
		await expect(bot.rest.request('DELETE', '/invites/ghost-code')).rejects.toMatchObject({
			code: DiscordErrors.UnknownInvite.code,
		});
		await bot.close();
	});

	test('editing a guild emoji that does not exist is a 404 Unknown Emoji', async () => {
		const { world, guild } = seedGuildFixture('emoji-missing');
		const bot = await createMockBot({ world });
		await expect(
			bot.rest.request('PATCH', `/guilds/${guild.id}/emojis/ghost-emoji`, { body: { name: 'x' } }),
		).rejects.toMatchObject({ code: DiscordErrors.UnknownEmoji.code });
		await bot.close();
	});

	test('editing a webhook that does not exist is a 404 Unknown Webhook', async () => {
		const { world } = seedGuildFixture('wh-missing');
		const bot = await createMockBot({ world });
		await expect(
			bot.rest.request('PATCH', '/webhooks/ghost-webhook', { body: { name: 'x' } }),
		).rejects.toMatchObject({ code: DiscordErrors.UnknownWebhook.code });
		await bot.close();
	});

	test('worldless mode stays lenient: a ban in any guild succeeds', async () => {
		@Declare({ name: 'ban-anywhere', description: 'bans with no world seeded' })
		class BanAnywhere extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.members.ban('any-guild', 'victim');
				await ctx.write({ content: 'banned' });
			}
		}

		const bot = await createMockBot({ commands: [BanAnywhere], onUnhandledRest: 'silent' });
		const result = await bot.slash({ name: 'ban-anywhere' });
		expect(result.content).toBe('banned');
		await bot.close();
	});
});
