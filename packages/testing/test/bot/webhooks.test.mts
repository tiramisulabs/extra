import { Command, type CommandContext, createEvent, Declare } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { apiMember, apiUser } from '../../src/bot/payloads';
import { mockWorld } from '../../src/bot/world';

describe('non-interaction channel webhooks (sendLog)', () => {
	test('a command logging via a channel webhook lands in the channel view, not in the reply', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'wh-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'wh-actor' }) });
		const dispatch = world.registerChannel(guild.id, { id: 'wh-dispatch' });
		world.registerChannel(guild.id, { id: 'mod-log', name: 'mod-log' });

		@Declare({ name: 'report', description: 'Logs via webhook' })
		class Report extends Command {
			async run(ctx: CommandContext) {
				const [existing] = await ctx.client.webhooks.listFromChannel('mod-log');
				const webhook = existing ?? (await ctx.client.webhooks.create('mod-log', { name: 'logs' }));
				if (webhook.token) {
					await ctx.client.webhooks.writeMessage(webhook.id, webhook.token, {
						body: { embeds: [{ title: 'Report', description: 'spammer reported' }] },
					});
				}
				await ctx.write({ content: 'done' });
			}
		}

		const bot = await createMockBot({ commands: [Report], world });
		const res = await bot.slash({ name: 'report', guildId: guild.id, channel: dispatch, user: actor.user });

		expect(res.content).toBe('done');
		const log = bot.cachedGuild(guild.id)?.channel('mod-log')?.lastMessage;
		expect(log?.embeds[0]).toMatchObject({ title: 'Report', description: 'spammer reported' });
		await bot.close();
	});

	test('an event logging via webhook is harvested into the emitEvent result and the channel view', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'wh-evt-guild' });
		world.registerChannel(guild.id, { id: 'join-log', name: 'join-log' });

		const onJoin = createEvent({
			data: { name: 'guildMemberAdd' },
			async run(member, client) {
				const webhook = await client.webhooks.create('join-log', { name: 'joins' });
				if (webhook.token) {
					await client.webhooks.writeMessage(webhook.id, webhook.token, {
						body: { embeds: [{ title: 'Joined', description: member.user.username }] },
					});
				}
			},
		});

		const bot = await createMockBot({ events: [onJoin], world });
		const res = await bot.emitEvent('GUILD_MEMBER_ADD', {
			guild_id: guild.id,
			...apiMember({ user: apiUser({ username: 'newbie' }) }),
		});

		expect(res.embeds[0]).toMatchObject({ title: 'Joined', description: 'newbie' });
		expect(bot.cachedGuild(guild.id)?.channel('join-log')?.lastMessage?.embeds[0]).toMatchObject({ title: 'Joined' });
		await bot.close();
	});
});
