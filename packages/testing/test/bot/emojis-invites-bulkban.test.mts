import { Command, type CommandContext, Declare } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { apiUser } from '../../src/bot/payloads';
import { mockWorld } from '../../src/bot/world';

const PNG = { data: Buffer.from('x'), type: 'buffer' } as const;

describe('guild emojis', () => {
	test('create, edit and read back via the guild view', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'emoji-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'emoji-actor' }) });
		const channel = world.registerChannel(guild.id);

		@Declare({ name: 'make-emoji', description: 'creates then edits an emoji' })
		class MakeEmoji extends Command {
			async run(ctx: CommandContext) {
				const created = await ctx.client.emojis.create(ctx.guildId ?? '', { name: 'party', image: PNG });
				const edited = await ctx.client.emojis.edit(ctx.guildId ?? '', created.id, { name: 'party2' });
				await ctx.write({ content: `${created.id}:${edited.name}` });
			}
		}

		const bot = await createMockBot({ commands: [MakeEmoji], world });
		const res = await bot.slash({ name: 'make-emoji', guildId: guild.id, channel, user: actor.user });
		const [id] = (res.content ?? '').split(':');
		expect(res.content).toBe(`${id}:party2`);
		expect(bot.world.query.emoji({ guildId: guild.id, id })).toMatchObject({ id, name: 'party2' });
		expect(bot.world.query.emoji({ guildId: guild.id, name: 'party2' })).toBeDefined();
		expect(bot.world.all.emoji({ guildId: guild.id }).map(emoji => emoji.id)).toContain(id);
		await bot.close();
	});

	test('delete removes a seeded emoji', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'emoji-del-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'emoji-del-actor' }) });
		const channel = world.registerChannel(guild.id);
		world.registerEmoji(guild.id, { id: 'del-emoji', name: 'doomed' });

		@Declare({ name: 'drop-emoji', description: 'deletes an emoji' })
		class DropEmoji extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.emojis.delete(ctx.guildId ?? '', 'del-emoji');
				await ctx.write({ content: 'gone' });
			}
		}

		const bot = await createMockBot({ commands: [DropEmoji], world });
		expect(bot.world.query.emoji({ guildId: guild.id, id: 'del-emoji' })).toBeDefined();
		await bot.slash({ name: 'drop-emoji', guildId: guild.id, channel, user: actor.user });
		expect(bot.world.query.emoji({ guildId: guild.id, id: 'del-emoji' })).toBeUndefined();
		await bot.close();
	});
});

describe('invites', () => {
	test('createInvite records real state that get and the guild view read back', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'invite-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'invite-actor' }) });
		const channel = world.registerChannel(guild.id, { id: 'invite-chan' });

		@Declare({ name: 'make-invite', description: 'creates and reads an invite' })
		class MakeInvite extends Command {
			async run(ctx: CommandContext) {
				const created = await ctx.client.invites.channels.create({ channelId: channel.id, max_uses: 5 });
				const fetched = await ctx.client.invites.get(created.code);
				await ctx.write({ content: `${created.code}:${fetched.code}` });
			}
		}

		const bot = await createMockBot({ commands: [MakeInvite], world });
		const res = await bot.slash({ name: 'make-invite', guildId: guild.id, channel, user: actor.user });
		const [code] = (res.content ?? '').split(':');
		expect(res.content).toBe(`${code}:${code}`);
		expect(bot.world.all.invite().map(invite => invite.code)).toContain(code);
		expect(bot.world.query.invite({ code: code })).toMatchObject({ channel_id: 'invite-chan', guild_id: guild.id });
		expect(bot.world.query.guild({ id: guild.id })?.invites.map(invite => invite.code)).toContain(code);
		await bot.close();
	});

	test('deleteInvite revokes a seeded invite', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'invite-del-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'invite-del-actor' }) });
		const channel = world.registerChannel(guild.id, { id: 'invite-del-chan' });
		world.registerInvite(channel.id, { code: 'revoke-me' });

		@Declare({ name: 'revoke', description: 'deletes an invite' })
		class Revoke extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.invites.delete('revoke-me');
				await ctx.write({ content: 'revoked' });
			}
		}

		const bot = await createMockBot({ commands: [Revoke], world });
		expect(bot.world.query.invite({ code: 'revoke-me' })).toBeDefined();
		await bot.slash({ name: 'revoke', guildId: guild.id, channel, user: actor.user });
		expect(bot.world.query.invite({ code: 'revoke-me' })).toBeUndefined();
		await bot.close();
	});
});

describe('bulk ban', () => {
	test('bulkCreate bans every listed user', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'bulk-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'bulk-actor' }) });
		const t1 = world.registerMember(guild.id, { user: apiUser({ id: 'bulk-1' }) });
		const t2 = world.registerMember(guild.id, { user: apiUser({ id: 'bulk-2' }) });
		const channel = world.registerChannel(guild.id);

		@Declare({ name: 'bulk-ban', description: 'bulk-bans members' })
		class BulkBan extends Command {
			async run(ctx: CommandContext) {
				const res = await ctx.client.bans.bulkCreate(ctx.guildId ?? '', { user_ids: [t1.user.id, t2.user.id] });
				await ctx.write({ content: res.banned_users.join(',') });
			}
		}

		const bot = await createMockBot({ commands: [BulkBan], world });
		const res = await bot.slash({ name: 'bulk-ban', guildId: guild.id, channel, user: actor.user });
		expect(res.content).toBe(`${t1.user.id},${t2.user.id}`);
		expect(bot.world.query.ban({ guildId: guild.id, userId: t1.user.id }) !== undefined).toBe(true);
		expect(bot.world.query.ban({ guildId: guild.id, userId: t2.user.id }) !== undefined).toBe(true);
		expect(bot.world.query.member({ guildId: guild.id, userId: t1.user.id })).toBeUndefined();
		await bot.close();
	});
});
