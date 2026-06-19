import { Command, type CommandContext, createEvent, Declare } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { TEST_BOT_ID } from '../../src/bot/constants';
import { apiUser } from '../../src/bot/payloads';
import { mockWorld } from '../../src/bot/world';

const EMOJI = '🔥';

describe('message reactions', () => {
	test('adding a reaction lands it on the message view and is readable through state', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'react-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'react-actor' }) });
		const channel = world.registerChannel(guild.id);
		const message = world.registerMessage(channel.id, { id: 'react-message' });

		@Declare({ name: 'react', description: 'Reacts to the seeded message' })
		class React extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.reactions.add(message.id, channel.id, EMOJI);
				await ctx.write({ content: 'reacted' });
			}
		}

		const bot = await createMockBot({ commands: [React], world });
		await expect(bot.slash({ name: 'react', guildId: guild.id, channel, user: actor.user })).resolves.toMatchObject({
			content: 'reacted',
		});

		const reacted = bot
			.worldGuild(guild.id)
			?.channel(channel.id)
			?.messages.find(entry => entry.id === message.id);
		const view = reacted?.reaction(EMOJI);
		expect(view).toMatchObject({ emoji: EMOJI, count: 1, me: true });
		expect(view?.users).toEqual([TEST_BOT_ID]);
		expect(bot.world.reactionUsers(channel.id, message.id, EMOJI)).toEqual([TEST_BOT_ID]);
		await bot.close();
	});

	test('custom botId marks own reactions as me', async () => {
		const botId = 'custom-react-bot';
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'custom-react-guild' });
		world.registerBotMember(guild.id, { botId });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'custom-react-actor' }) });
		const channel = world.registerChannel(guild.id);
		const message = world.registerMessage(channel.id, { id: 'custom-react-message' });

		@Declare({ name: 'custom-react', description: 'Reacts as a custom bot id' })
		class CustomReact extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.reactions.add(message.id, channel.id, EMOJI);
				await ctx.write({ content: 'reacted' });
			}
		}

		const bot = await createMockBot({ botId, commands: [CustomReact], world });
		await bot.slash({ name: 'custom-react', guildId: guild.id, channel, user: actor.user });

		const view = bot.worldMessage(channel.id, message.id)?.reaction(EMOJI);
		expect(view).toMatchObject({ count: 1, me: true });
		expect(view?.users).toEqual([botId]);
		expect(bot.world.rawMessage(channel.id, message.id)?.reactions?.[0]).toMatchObject({ count: 1, me: true });
		await bot.close();
	});

	test('removing a reaction clears it from the message view', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'unreact-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'unreact-actor' }) });
		const channel = world.registerChannel(guild.id);
		const message = world.registerMessage(channel.id, { id: 'unreact-message' });

		@Declare({ name: 'unreact', description: 'Reacts then removes the reaction' })
		class Unreact extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.reactions.add(message.id, channel.id, EMOJI);
				await ctx.client.reactions.delete(message.id, channel.id, EMOJI);
				await ctx.write({ content: 'unreacted' });
			}
		}

		const bot = await createMockBot({ commands: [Unreact], world });
		await expect(bot.slash({ name: 'unreact', guildId: guild.id, channel, user: actor.user })).resolves.toMatchObject({
			content: 'unreacted',
		});

		const reacted = bot
			.worldGuild(guild.id)
			?.channel(channel.id)
			?.messages.find(entry => entry.id === message.id);
		expect(reacted?.reactions).toEqual([]);
		expect(bot.world.reactionUsers(channel.id, message.id, EMOJI)).toEqual([]);
		await bot.close();
	});

	test('removeAll and removeEmoji purge reactions from the message', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'purge-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'purge-actor' }) });
		const channel = world.registerChannel(guild.id);
		const message = world.registerMessage(channel.id, { id: 'purge-message' });

		@Declare({ name: 'purge-reactions', description: 'Reacts then purges' })
		class PurgeReactions extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.reactions.add(message.id, channel.id, EMOJI);
				await ctx.client.reactions.purge(message.id, channel.id);
				await ctx.write({ content: 'purged' });
			}
		}

		const bot = await createMockBot({ commands: [PurgeReactions], world });
		await bot.slash({ name: 'purge-reactions', guildId: guild.id, channel, user: actor.user });
		expect(bot.world.reactionUsers(channel.id, message.id, EMOJI)).toEqual([]);
		await bot.close();
	});

	test('simulateGateway fires messageReactionAdd / messageReactionRemove handlers with reaction metadata', async () => {
		const added: string[] = [];
		const removed: string[] = [];
		const onAdd = createEvent({
			data: { name: 'messageReactionAdd' },
			run(data) {
				added.push(
					`${data.messageId}:${data.emoji.name}:${data.userId}:${data.member?.user.id}:${data.messageAuthorId}`,
				);
			},
		});
		const onRemove = createEvent({
			data: { name: 'messageReactionRemove' },
			run(data) {
				removed.push(`${data.messageId}:${data.emoji.name}:${data.userId}`);
			},
		});

		const world = mockWorld();
		const guild = world.registerGuild({ id: 'gateway-react-guild' });
		world.registerBotMember(guild.id);
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'gateway-react-actor' }) });
		const channel = world.registerChannel(guild.id);
		const message = world.registerMessage(channel.id, {
			id: 'gateway-react-message',
			author: apiUser({ id: 'gateway-message-author' }),
		});

		@Declare({ name: 'react-gateway', description: 'Reacts and unreacts under simulateGateway' })
		class ReactGateway extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.reactions.add(message.id, channel.id, EMOJI);
				await ctx.client.reactions.delete(message.id, channel.id, EMOJI);
				await ctx.write({ content: 'done' });
			}
		}

		const bot = await createMockBot({
			commands: [ReactGateway],
			events: [onAdd, onRemove],
			world,
			simulateGateway: true,
		});
		await bot.slash({ name: 'react-gateway', guildId: guild.id, channel, user: actor.user });
		expect(added).toEqual([`${message.id}:${EMOJI}:${TEST_BOT_ID}:${TEST_BOT_ID}:gateway-message-author`]);
		expect(removed).toEqual([`${message.id}:${EMOJI}:${TEST_BOT_ID}`]);
		await bot.close();
	});
});
