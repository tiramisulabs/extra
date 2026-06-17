import { Command, type CommandContext, Declare } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { TEST_BOT_ID } from '../../src/bot/constants';
import { apiUser } from '../../src/bot/payloads';
import { mockWorld } from '../../src/bot/world';

describe('automod rules', () => {
	test('a seeded rule reads back via the guild view with typed metadata and actions', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'am-guild' });
		world.registerAutoModRule(guild.id, {
			id: 'rule-1',
			name: 'block-spam',
			triggerType: 1,
			triggerMetadata: { keyword_filter: ['spam'] },
			actions: [{ type: 1 }],
		});
		const bot = await createMockBot({ world });
		const rule = bot.worldGuild(guild.id)?.autoModRule('rule-1');
		expect(rule).toMatchObject({ name: 'block-spam', trigger_type: 1 });
		expect(rule?.trigger_metadata.keyword_filter).toEqual(['spam']);
		expect(rule?.actions[0]?.type).toBe(1);
		expect(bot.worldGuild(guild.id)?.autoModRules).toHaveLength(1);
		await bot.close();
	});

	test('create, edit and delete drive the world state', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'am-crud-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'am-actor' }) });
		const channel = world.registerChannel(guild.id);

		@Declare({ name: 'am', description: 'creates/edits/deletes an automod rule' })
		class Am extends Command {
			async run(ctx: CommandContext) {
				const created = await ctx.client.guilds.moderation.create(ctx.guildId ?? '', {
					name: 'no-links',
					event_type: 1,
					trigger_type: 3,
					actions: [{ type: 1 }],
				});
				await ctx.client.guilds.moderation.edit(ctx.guildId ?? '', created.id, { enabled: false });
				await ctx.write({ content: created.id });
			}
		}

		const bot = await createMockBot({ commands: [Am], world });
		const res = await bot.slash({ name: 'am', guildId: guild.id, channel, user: actor.user });
		const id = res.content ?? '';
		expect(bot.world.autoModRule(guild.id, id)).toMatchObject({ name: 'no-links', enabled: false });

		@Declare({ name: 'am-del', description: 'deletes the rule' })
		class AmDel extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.guilds.moderation.delete(ctx.guildId ?? '', id);
				await ctx.write({ content: 'gone' });
			}
		}
		const bot2 = await createMockBot({ commands: [AmDel], world });
		await bot2.slash({ name: 'am-del', guildId: guild.id, channel, user: actor.user });
		expect(bot2.world.autoModRule(guild.id, id)).toBeUndefined();
		await bot.close();
		await bot2.close();
	});
});

describe('thread membership', () => {
	test('join resolves @me to the bot and listMembers returns the joined set', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'tm-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'tm-actor' }) });
		const parent = world.registerChannel(guild.id, { id: 'tm-parent' });
		const thread = world.registerThread(parent.id, { id: 'tm-thread' });

		@Declare({ name: 'join-thread', description: 'joins and adds a member' })
		class JoinThread extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.threads.join(thread.id);
				await ctx.client.threads.addMember(thread.id, 'user-7');
				const members = await ctx.client.threads.listMembers(thread.id);
				await ctx.write({ content: members.map(member => member.user_id).join(',') });
			}
		}

		const bot = await createMockBot({ commands: [JoinThread], world });
		await bot.slash({ name: 'join-thread', guildId: guild.id, channel: parent, user: actor.user });
		expect(bot.world.threadMembers(thread.id).sort()).toEqual([TEST_BOT_ID, 'user-7'].sort());
		await bot.close();
	});

	test('leave removes the bot from the thread', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'tl-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'tl-actor' }) });
		const parent = world.registerChannel(guild.id, { id: 'tl-parent' });
		const thread = world.registerThread(parent.id, { id: 'tl-thread' });

		@Declare({ name: 'leave-thread', description: 'joins then leaves' })
		class LeaveThread extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.threads.join(thread.id);
				await ctx.client.threads.leave(thread.id);
				await ctx.write({ content: 'left' });
			}
		}

		const bot = await createMockBot({ commands: [LeaveThread], world });
		await bot.slash({ name: 'leave-thread', guildId: guild.id, channel: parent, user: actor.user });
		expect(bot.world.threadMembers(thread.id)).not.toContain(TEST_BOT_ID);
		await bot.close();
	});
});

describe('active threads', () => {
	test('listGuildActive returns only non-archived threads', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'at-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'at-actor' }) });
		const parent = world.registerChannel(guild.id, { id: 'at-parent' });
		world.registerThread(parent.id, { id: 'at-active', archived: false });
		world.registerThread(parent.id, { id: 'at-archived', archived: true });

		@Declare({ name: 'active', description: 'lists active threads' })
		class Active extends Command {
			async run(ctx: CommandContext) {
				const threads = await ctx.client.threads.listGuildActive(ctx.guildId ?? '', true);
				await ctx.write({ content: threads.map(thread => thread.id).join(',') });
			}
		}

		const bot = await createMockBot({ commands: [Active], world });
		const res = await bot.slash({ name: 'active', guildId: guild.id, channel: parent, user: actor.user });
		expect(res.content).toBe('at-active');
		expect(bot.world.activeThreads(guild.id)).toHaveLength(1);
		await bot.close();
	});
});
