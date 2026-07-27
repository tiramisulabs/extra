import { Command, type CommandContext, Declare } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { DiscordErrors } from '../../src/bot/rest';
import { expectDiscordError, seedGuildFixture } from './_setup';

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
		await expectDiscordError(
			bot.slash({ name: 'ban-ghost', guildId: guild.id, channel, user: actor.user }),
			DiscordErrors.UnknownGuild,
		);
		expect(bot.world.query.ban({ guildId: 'ghost-guild', userId: 'victim' }) !== undefined).toBe(false);
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
		await expectDiscordError(
			bot.slash({ name: 'write-ghost', guildId: guild.id, channel, user: actor.user }),
			DiscordErrors.UnknownChannel,
		);
		expect(bot.world.query.channel({ id: 'ghost-channel' })).toBeUndefined();
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
		await expectDiscordError(
			bot.slash({ name: 'edit-foreign', guildId: guild.id, channel, user: actor.user }),
			DiscordErrors.CannotEditAnotherUsersMessage,
		);
		expect(bot.world.query.message({ channelId: channel.id, id: 'human-msg' })?.content).toBe('theirs');
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
		await expectDiscordError(
			bot.slash({ name: 'del-missing', guildId: guild.id, channel, user: actor.user }),
			DiscordErrors.UnknownMessage,
		);
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
		await expectDiscordError(
			bot.slash({ name: 'unreact-ghost', guildId: guild.id, channel, user: actor.user }),
			DiscordErrors.UnknownMessage,
		);
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
		await expectDiscordError(
			bot.slash({ name: 'edit-ghost-chan', guildId: guild.id, channel, user: actor.user }),
			DiscordErrors.UnknownChannel,
		);
		await bot.close();
	});

	test('deleting a non-existent channel is a 404 Unknown Channel', async () => {
		const { world } = seedGuildFixture('chan-delete');
		const bot = await createMockBot({ world });

		await expectDiscordError(bot.rest.request('DELETE', '/channels/ghost-channel'), DiscordErrors.UnknownChannel);
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
		await expectDiscordError(
			bot.slash({ name: 'fetch-ghost-ban', guildId: guild.id, channel, user: actor.user }),
			DiscordErrors.UnknownGuild,
		);
		await bot.close();
	});

	test('editMember against a member that is not in the guild is a 404 Unknown Member', async () => {
		const { world, guild } = seedGuildFixture('em-missing');
		const bot = await createMockBot({ world });
		await expectDiscordError(
			bot.rest.request('PATCH', `/guilds/${guild.id}/members/ghost-user`, { body: { nick: 'x' } }),
			DiscordErrors.UnknownMember,
		);
		await bot.close();
	});

	test('creating a DM with an unknown user is a 404 Unknown User in world mode', async () => {
		const { world } = seedGuildFixture('dm-missing');
		const bot = await createMockBot({ world });
		await expectDiscordError(
			bot.rest.request('POST', '/users/@me/channels', { body: { recipient_id: 'ghost-user' } }),
			DiscordErrors.UnknownUser,
		);
		await bot.close();
	});

	test('kicking a user who is not a guild member is a 404 Unknown Member in world mode', async () => {
		const { world, guild } = seedGuildFixture('kick-missing');
		const bot = await createMockBot({ world });
		await expectDiscordError(
			bot.rest.request('DELETE', `/guilds/${guild.id}/members/ghost-user`),
			DiscordErrors.UnknownMember,
		);
		await bot.close();
	});

	test('adding a role that does not exist writes no phantom role — 404 Unknown Role', async () => {
		const { world, guild, actor } = seedGuildFixture('ar-role');
		const bot = await createMockBot({ world });
		await expectDiscordError(
			bot.rest.request('PUT', `/guilds/${guild.id}/members/${actor.user.id}/roles/ghost-role`),
			DiscordErrors.UnknownRole,
		);
		expect(bot.world.query.member({ guildId: guild.id, userId: actor.user.id })?.roles ?? []).not.toContain(
			'ghost-role',
		);
		await bot.close();
	});

	test('adding a real role to a member that is not in the guild is a 404 Unknown Member', async () => {
		const { world, guild } = seedGuildFixture('ar-member');
		const role = world.registerRole(guild.id, { id: 'real-role' });
		const bot = await createMockBot({ world });
		await expectDiscordError(
			bot.rest.request('PUT', `/guilds/${guild.id}/members/ghost-user/roles/${role.id}`),
			DiscordErrors.UnknownMember,
		);
		await bot.close();
	});

	test('editing/deleting a role that does not exist is a 404 Unknown Role', async () => {
		const { world, guild } = seedGuildFixture('role-missing');
		const bot = await createMockBot({ world });
		await expectDiscordError(
			bot.rest.request('PATCH', `/guilds/${guild.id}/roles/ghost-role`, { body: { name: 'x' } }),
			DiscordErrors.UnknownRole,
		);
		await expectDiscordError(
			bot.rest.request('DELETE', `/guilds/${guild.id}/roles/ghost-role`),
			DiscordErrors.UnknownRole,
		);
		await bot.close();
	});

	test('unbanning a user who is not banned is a 404 Unknown Ban', async () => {
		const { world, guild } = seedGuildFixture('unban-missing');
		const bot = await createMockBot({ world });
		await expectDiscordError(
			bot.rest.request('DELETE', `/guilds/${guild.id}/bans/never-banned`),
			DiscordErrors.UnknownBan,
		);
		await bot.close();
	});

	test('deleting an invite that does not exist is a 404 Unknown Invite', async () => {
		const { world } = seedGuildFixture('inv-missing');
		const bot = await createMockBot({ world });
		await expectDiscordError(bot.rest.request('DELETE', '/invites/ghost-code'), DiscordErrors.UnknownInvite);
		await bot.close();
	});

	test('editing a guild emoji that does not exist is a 404 Unknown Emoji', async () => {
		const { world, guild } = seedGuildFixture('emoji-missing');
		const bot = await createMockBot({ world });
		await expectDiscordError(
			bot.rest.request('PATCH', `/guilds/${guild.id}/emojis/ghost-emoji`, { body: { name: 'x' } }),
			DiscordErrors.UnknownEmoji,
		);
		await bot.close();
	});

	test('editing a webhook that does not exist is a 404 Unknown Webhook', async () => {
		const { world } = seedGuildFixture('wh-missing');
		const bot = await createMockBot({ world });
		await expectDiscordError(
			bot.rest.request('PATCH', '/webhooks/ghost-webhook', { body: { name: 'x' } }),
			DiscordErrors.UnknownWebhook,
		);
		await bot.close();
	});

	test('world-backed fetch and list routes require their parent entities', async () => {
		const { world, guild, channel } = seedGuildFixture('parents');
		const bot = await createMockBot({ world });

		await expectDiscordError(
			bot.rest.request('GET', `/guilds/${guild.id}/members/ghost-user`),
			DiscordErrors.UnknownMember,
		);
		await expectDiscordError(bot.rest.request('GET', '/guilds/ghost-guild/roles'), DiscordErrors.UnknownGuild);
		await expectDiscordError(bot.rest.request('GET', '/guilds/ghost-guild/channels'), DiscordErrors.UnknownGuild);
		await expectDiscordError(bot.rest.request('GET', '/guilds/ghost-guild/bans'), DiscordErrors.UnknownGuild);
		await expectDiscordError(bot.rest.request('GET', '/guilds/ghost-guild/threads/active'), DiscordErrors.UnknownGuild);
		await expectDiscordError(bot.rest.request('GET', '/guilds/ghost-guild/audit-logs'), DiscordErrors.UnknownGuild);
		await expectDiscordError(bot.rest.request('GET', '/channels/ghost-channel/messages'), DiscordErrors.UnknownChannel);
		await expectDiscordError(
			bot.rest.request('PATCH', '/channels/ghost-channel/messages/ghost-message', { body: { content: 'x' } }),
			DiscordErrors.UnknownChannel,
		);
		await expectDiscordError(
			bot.rest.request('DELETE', '/channels/ghost-channel/messages/ghost-message'),
			DiscordErrors.UnknownChannel,
		);
		await expectDiscordError(
			bot.rest.request('GET', '/channels/ghost-channel/messages/pins'),
			DiscordErrors.UnknownChannel,
		);
		await expectDiscordError(bot.rest.request('GET', '/channels/ghost-channel/invites'), DiscordErrors.UnknownChannel);
		await expectDiscordError(bot.rest.request('GET', '/channels/ghost-channel/webhooks'), DiscordErrors.UnknownChannel);
		await expectDiscordError(
			bot.rest.request('POST', '/channels/ghost-channel/webhooks', { body: { name: 'logs' } }),
			DiscordErrors.UnknownChannel,
		);
		await expectDiscordError(
			bot.rest.request('GET', `/channels/${channel.id}/thread-members/ghost-user`),
			DiscordErrors.UnknownMember,
		);
		await expectDiscordError(
			bot.rest.request('GET', '/channels/ghost-channel/thread-members'),
			DiscordErrors.UnknownChannel,
		);
		await expectDiscordError(bot.rest.request('GET', '/guilds/ghost-guild/emojis'), DiscordErrors.UnknownGuild);
		await expectDiscordError(
			bot.rest.request('GET', '/guilds/ghost-guild/emojis/ghost-emoji'),
			DiscordErrors.UnknownGuild,
		);
		await expectDiscordError(
			bot.rest.request('GET', '/guilds/ghost-guild/auto-moderation/rules'),
			DiscordErrors.UnknownGuild,
		);
		await expectDiscordError(
			bot.rest.request('GET', '/guilds/ghost-guild/auto-moderation/rules/ghost-rule'),
			DiscordErrors.UnknownGuild,
		);
		await expectDiscordError(bot.rest.request('GET', '/guilds/ghost-guild/stickers'), DiscordErrors.UnknownGuild);
		await expectDiscordError(
			bot.rest.request('GET', '/guilds/ghost-guild/stickers/ghost-sticker'),
			DiscordErrors.UnknownGuild,
		);
		await expectDiscordError(
			bot.rest.request('GET', '/guilds/ghost-guild/scheduled-events'),
			DiscordErrors.UnknownGuild,
		);
		await expectDiscordError(
			bot.rest.request('GET', '/guilds/ghost-guild/scheduled-events/ghost-event'),
			DiscordErrors.UnknownGuild,
		);
		await bot.close();
	});

	test('message-scoped world routes require the target message', async () => {
		const { world, channel } = seedGuildFixture('msg-scope');
		const bot = await createMockBot({ world });

		await expectDiscordError(
			bot.rest.request('POST', `/channels/${channel.id}/messages/ghost-message/threads`, { body: { name: 'thread' } }),
			DiscordErrors.UnknownMessage,
		);
		await expectDiscordError(
			bot.rest.request('PUT', `/channels/${channel.id}/messages/pins/ghost-message`),
			DiscordErrors.UnknownMessage,
		);
		await expectDiscordError(
			bot.rest.request('GET', `/channels/${channel.id}/messages/ghost-message/reactions/thumb`),
			DiscordErrors.UnknownMessage,
		);
		await expectDiscordError(
			bot.rest.request('POST', `/channels/${channel.id}/polls/ghost-message/expire`),
			DiscordErrors.UnknownMessage,
		);
		await expectDiscordError(
			bot.rest.request('GET', `/channels/${channel.id}/polls/ghost-message/answers/0`),
			DiscordErrors.UnknownMessage,
		);
		await bot.close();
	});

	test('invite, template and stage routes reject missing backing entities', async () => {
		const { world, guild, channel } = seedGuildFixture('low-entity');
		const bot = await createMockBot({ world });

		await expectDiscordError(bot.rest.request('GET', '/invites/ghost-code'), DiscordErrors.UnknownInvite);
		await expectDiscordError(
			bot.rest.request('GET', '/guilds/templates/ghost-template'),
			DiscordErrors.UnknownGuildTemplate,
		);
		await expectDiscordError(bot.rest.request('GET', '/guilds/ghost-guild/templates'), DiscordErrors.UnknownGuild);
		await expectDiscordError(
			bot.rest.request('POST', '/guilds/ghost-guild/templates', { body: { name: 'template' } }),
			DiscordErrors.UnknownGuild,
		);
		await expectDiscordError(
			bot.rest.request('GET', '/guilds/ghost-guild/soundboard-sounds'),
			DiscordErrors.UnknownGuild,
		);
		await expectDiscordError(
			bot.rest.request('POST', '/stage-instances', { body: { channel_id: 'ghost-channel' } }),
			DiscordErrors.UnknownChannel,
		);
		await expectDiscordError(
			bot.rest.request('GET', `/stage-instances/${channel.id}`),
			DiscordErrors.UnknownStageInstance,
		);
		await expectDiscordError(
			bot.rest.request('DELETE', `/stage-instances/${channel.id}`),
			DiscordErrors.UnknownStageInstance,
		);
		await expect(bot.rest.request('GET', `/guilds/${guild.id}/templates`)).resolves.toEqual([]);
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
