import { Command, type CommandContext, Declare, PollBuilder } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { apiPoll, apiUser } from '../../src/bot/payloads';
import { mockWorld } from '../../src/bot/world';

describe('polls', () => {
	test('a command writing a poll persists it on the message view', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'poll-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'poll-actor' }) });
		const channel = world.registerChannel(guild.id, { id: 'poll-chan' });

		@Declare({ name: 'make-poll', description: 'writes a poll' })
		class MakePoll extends Command {
			async run(ctx: CommandContext) {
				const sent = await ctx.client.messages.write(channel.id, {
					poll: new PollBuilder().setQuestion({ text: 'Best color?' }).setAnswers({ text: 'Red' }, { text: 'Blue' }),
				});
				await ctx.write({ content: sent.id });
			}
		}

		const bot = await createMockBot({ commands: [MakePoll], world });
		const res = await bot.slash({ name: 'make-poll', guildId: guild.id, channel, user: actor.user });
		const view = bot
			.cachedGuild(guild.id)
			?.channel('poll-chan')
			?.messages.find(message => message.id === res.content);
		expect(view?.poll?.question).toBe('Best color?');
		expect(view?.poll?.answers).toHaveLength(2);
		expect(view?.poll?.answers[0]).toMatchObject({ answerId: 1, text: 'Red' });
		expect(view?.poll?.isFinalized).toBe(false);
		await bot.close();
	});

	test('seedPollVote seeds voters that getAnswerVoters reads back', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'vote-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'vote-actor' }) });
		const channel = world.registerChannel(guild.id, { id: 'vote-chan' });
		world.registerMessage(channel.id, { id: 'poll-msg', poll: apiPoll({ question: 'Q', answers: ['A', 'B'] }) });

		@Declare({ name: 'voters', description: 'reads answer voters' })
		class Voters extends Command {
			async run(ctx: CommandContext) {
				const users = await ctx.client.messages.getAnswerVoters(channel.id, 'poll-msg', 1);
				await ctx.write({ content: users.map(user => user.id).join(',') });
			}
		}

		const bot = await createMockBot({ commands: [Voters], world });
		bot.seedPollVote(channel.id, 'poll-msg', 1, 'voter-a');
		expect(bot.state.pollVoters(channel.id, 'poll-msg', 1)).toEqual(['voter-a']);
		const res = await bot.slash({ name: 'voters', guildId: guild.id, channel, user: actor.user });
		expect(res.content).toBe('voter-a');
		await bot.close();
	});

	test('endPoll finalizes the poll', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'end-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'end-actor' }) });
		const channel = world.registerChannel(guild.id, { id: 'end-chan' });
		world.registerMessage(channel.id, { id: 'end-poll-msg', poll: apiPoll({ question: 'Q', answers: ['A', 'B'] }) });

		@Declare({ name: 'finish', description: 'ends a poll' })
		class Finish extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.messages.endPoll(channel.id, 'end-poll-msg');
				await ctx.write({ content: 'ended' });
			}
		}

		const bot = await createMockBot({ commands: [Finish], world });
		await bot.slash({ name: 'finish', guildId: guild.id, channel, user: actor.user });
		const view = bot
			.cachedGuild(guild.id)
			?.channel('end-chan')
			?.messages.find(message => message.id === 'end-poll-msg');
		expect(view?.poll?.isFinalized).toBe(true);
		await bot.close();
	});
});
