import { Command, type CommandContext, Declare, type ParseLocales } from 'seyfert';
import { ChannelType } from 'seyfert/lib/types';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { apiUser } from '../../src/bot/payloads';
import { mockWorld } from '../../src/bot/world';

const englishLang = { greeting: 'Hello!' };

declare module 'seyfert' {
	interface DefaultLocale extends ParseLocales<typeof englishLang> {}
}

describe('world state views', () => {
	test('materializes created channels, messages, embeds, and buttons', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'state-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'state-actor' }) });
		const dispatchChannel = world.registerChannel(guild.id, { id: 'dispatch-channel' });

		@Declare({ name: 'build-campaign', description: 'Builds a campaign channel' })
		class BuildCampaign extends Command {
			async run(ctx: CommandContext) {
				const channel = await ctx.client.guilds.channels.create(ctx.guildId ?? '', {
					name: 'acme-s1',
					type: ChannelType.GuildText,
				});
				await ctx.client.messages.write(channel.id, {
					content: 'Welcome Acme S1',
					embeds: [{ title: 'Acme S1', fields: [{ name: 'Budget', value: '$5,000' }] }],
					components: [
						{
							type: 1,
							components: [{ type: 2, style: 1, custom_id: 'approve', label: 'Approve' }],
						},
					],
				});
				await ctx.write({ content: 'built' });
			}
		}

		const bot = await createMockBot({ commands: [BuildCampaign], world });
		await bot.slash({ name: 'build-campaign', guildId: guild.id, channel: dispatchChannel, user: actor.user });
		const channel = bot.guild(guild.id)?.channel('acme-s1');
		expect(channel?.lastMessage?.content).toContain('Welcome Acme S1');
		expect(channel?.lastMessage?.buttons).toMatchObject([{ customId: 'approve', label: 'Approve' }]);
		expect(channel?.lastMessage?.embeds[0]).toMatchObject({
			title: 'Acme S1',
			fields: [{ name: 'Budget', value: '$5,000' }],
		});
		await bot.close();
	});

	test('materializes replies, edits, followups, DMs, and original-response fetch identity', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'reply-state-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'reply-state-actor' }) });
		const channel = world.registerChannel(guild.id, { id: 'reply-state-channel' });
		let fetchedOriginalId: string | undefined;

		@Declare({ name: 'reply-state', description: 'Writes reply state' })
		class ReplyState extends Command {
			async run(ctx: CommandContext) {
				await ctx.write({ content: 'initial' });
				const original = await ctx.fetchResponse();
				fetchedOriginalId = original.id;
				await ctx.editOrReply({ content: 'edited' });
				await ctx.followup({ content: 'followup' });
				await ctx.author.write({ content: 'dm hi' });
			}
		}

		const bot = await createMockBot({ commands: [ReplyState], world });
		await bot.slash({ name: 'reply-state', guildId: guild.id, channel, user: actor.user });
		const messages = bot.guild(guild.id)?.channel(channel.id)?.messages;
		expect(messages?.map(message => message.content)).toEqual(['edited', 'followup']);
		expect(messages?.[0]?.id).toBe(fetchedOriginalId);
		expect(bot.dm(actor.user.id)?.lastMessage?.content).toBe('dm hi');
		await bot.close();
	});

	test('serves seeded message history newest-first and keeps view contract rules', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'history-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'history-actor' }) });
		const first = world.registerChannel(guild.id, { id: 'dup-1', name: 'dupe' });
		const second = world.registerChannel(guild.id, { id: 'dup-2', name: 'dupe' });
		world.registerMessage(first.id, { id: 'old-message', content: 'old' });
		world.registerMessage(first.id, { id: 'new-message', content: 'new' });

		@Declare({ name: 'fetch-history', description: 'Fetches message history' })
		class FetchHistory extends Command {
			async run(ctx: CommandContext) {
				const messages = await ctx.client.channels.fetchMessages(first.id);
				await ctx.client.messages.delete('missing-message', first.id);
				await ctx.client.members.kick(ctx.guildId ?? '', actor.user.id);
				await ctx.write({ content: messages.map(message => message.id).join(',') });
			}
		}

		const bot = await createMockBot({ commands: [FetchHistory], world });
		const result = await bot.slash({ name: 'fetch-history', guildId: guild.id, channel: second, user: actor.user });
		expect(result.content).toBe('new-message,old-message');
		expect(bot.guild(guild.id)?.channel('dupe')?.id).toBe(first.id);
		expect(bot.guild(guild.id)?.bans).toEqual([]);
		expect(bot.guild(guild.id)).not.toBe(bot.guild(guild.id));
		await bot.close();
	});

	test('materializes followup edit and delete webhook routes', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'followup-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'followup-actor' }) });
		const channel = world.registerChannel(guild.id, { id: 'followup-channel' });
		let followupId: string | undefined;

		@Declare({ name: 'followup-lifecycle', description: 'Mutates a followup' })
		class FollowupLifecycle extends Command {
			async run(ctx: CommandContext) {
				await ctx.write({ content: 'original' });
				const followup = await ctx.followup({ content: 'followup' });
				followupId = followup.id;
				await ctx.interaction.editMessage(followup.id, { content: 'followup edited' });
				await ctx.interaction.deleteMessage(followup.id);
				await ctx.editOrReply({ content: 'original edited' });
			}
		}

		const bot = await createMockBot({ commands: [FollowupLifecycle], world });
		await bot.slash({ name: 'followup-lifecycle', guildId: guild.id, channel, user: actor.user });

		expect(followupId).toBeDefined();
		expect(
			bot
				.guild(guild.id)
				?.channel(channel.id)
				?.messages.map(message => message.content),
		).toEqual(['original edited']);
		await bot.close();
	});
});
