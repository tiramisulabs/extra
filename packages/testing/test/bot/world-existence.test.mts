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
