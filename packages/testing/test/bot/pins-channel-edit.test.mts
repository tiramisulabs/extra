import { Command, type CommandContext, Declare } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { apiUser } from '../../src/bot/payloads';
import { mockWorld } from '../../src/bot/world';

describe('pins route regression', () => {
	test('a command pinning a message lands in the channel pins view and flags the message pinned', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'pin-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'pin-actor' }) });
		const channel = world.registerChannel(guild.id, { id: 'pin-chan' });

		@Declare({ name: 'pin', description: 'pins a message' })
		class Pin extends Command {
			async run(ctx: CommandContext) {
				const msg = await ctx.client.messages.write(channel.id, { content: 'pin me' });
				await ctx.client.channels.setPin(msg.id, channel.id);
				const pinned = await ctx.client.channels.pins(channel.id);
				await ctx.write({ content: `${pinned.items.length}:${pinned.items[0]?.message.content}` });
			}
		}

		const bot = await createMockBot({ commands: [Pin], world });
		const res = await bot.slash({ name: 'pin', guildId: guild.id, channel, user: actor.user });
		expect(res.content).toBe('1:pin me');
		const view = bot.worldGuild(guild.id)?.channel('pin-chan');
		expect(view?.pins).toHaveLength(1);
		expect(view?.pins[0]?.content).toBe('pin me');
		expect(bot.world.pins(channel.id)).toHaveLength(1);
		await bot.close();
	});

	test('unpin clears it', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'unpin-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'unpin-actor' }) });
		const channel = world.registerChannel(guild.id, { id: 'unpin-chan' });

		@Declare({ name: 'unpin', description: 'pins then unpins' })
		class Unpin extends Command {
			async run(ctx: CommandContext) {
				const msg = await ctx.client.messages.write(channel.id, { content: 'temp' });
				await ctx.client.channels.setPin(msg.id, channel.id);
				await ctx.client.channels.deletePin(msg.id, channel.id);
				const pinned = await ctx.client.channels.pins(channel.id);
				await ctx.write({ content: String(pinned.items.length) });
			}
		}

		const bot = await createMockBot({ commands: [Unpin], world });
		const res = await bot.slash({ name: 'unpin', guildId: guild.id, channel, user: actor.user });
		expect(res.content).toBe('0');
		expect(bot.world.pins(channel.id)).toHaveLength(0);
		await bot.close();
	});
});

describe('editChannel persists topic/nsfw/slow-mode (regression: dropped fields)', () => {
	test('topic, nsfw and rate_limit_per_user survive into the channel view', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'edit-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'edit-actor' }) });
		const channel = world.registerChannel(guild.id, { id: 'edit-chan' });

		@Declare({ name: 'cfg', description: 'edits the channel' })
		class Cfg extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.channels.edit(channel.id, { topic: 'the rules', nsfw: true, rate_limit_per_user: 10 });
				await ctx.write({ content: 'done' });
			}
		}

		const bot = await createMockBot({ commands: [Cfg], world });
		await bot.slash({ name: 'cfg', guildId: guild.id, channel, user: actor.user });
		const view = bot.worldGuild(guild.id)?.channel('edit-chan');
		expect(view?.topic).toBe('the rules');
		expect(view?.nsfw).toBe(true);
		expect(view?.rateLimitPerUser).toBe(10);
		await bot.close();
	});

	test('thread setArchived/setLocked persist into thread_metadata', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'thr-edit-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'thr-edit-actor' }) });
		const channel = world.registerChannel(guild.id, { id: 'thr-edit-parent' });
		const thread = world.registerThread(channel.id, { id: 'thr-edit-1', archived: false, locked: false });

		@Declare({ name: 'archive', description: 'archives the thread' })
		class Archive extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.channels.edit(thread.id, { archived: true, locked: true });
				await ctx.write({ content: 'archived' });
			}
		}

		const bot = await createMockBot({ commands: [Archive], world });
		await bot.slash({ name: 'archive', guildId: guild.id, channel, user: actor.user });
		const view = bot.worldGuild(guild.id)?.thread('thr-edit-1');
		expect(view?.archived).toBe(true);
		expect(view?.locked).toBe(true);
		await bot.close();
	});
});

describe('archived thread listing', () => {
	test('listArchived returns only archived threads of the requested type', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'arch-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'arch-actor' }) });
		const channel = world.registerChannel(guild.id, { id: 'arch-parent' });
		world.registerThread(channel.id, { id: 'arch-1', name: 'archived-one', archived: true });
		world.registerThread(channel.id, { id: 'active-1', name: 'active-one', archived: false });

		@Declare({ name: 'list-arch', description: 'lists archived threads' })
		class ListArch extends Command {
			async run(ctx: CommandContext) {
				const res = await ctx.client.threads.listArchived(channel.id, 'public');
				await ctx.write({ content: res.threads.map(thread => thread.id).join(',') });
			}
		}

		const bot = await createMockBot({ commands: [ListArch], world });
		const res = await bot.slash({ name: 'list-arch', guildId: guild.id, channel, user: actor.user });
		expect(res.content).toBe('arch-1');
		expect(bot.world.archivedThreads(channel.id, 'public')).toHaveLength(1);
		await bot.close();
	});
});
