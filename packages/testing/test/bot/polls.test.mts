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
		const view = bot.world.query.message({ channelId: channel.id, id: res.content ?? '' });
		expect(view?.poll?.question).toBe('Best color?');
		expect(view?.poll?.answers).toHaveLength(2);
		expect(view?.poll?.answers[0]).toMatchObject({ answerId: 1, text: 'Red' });
		expect(view?.poll?.isFinalized).toBe(false);
		await bot.close();
	});

	test('poll duration is reflected as a future expiry', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'duration-guild' });
		const channel = world.registerChannel(guild.id, { id: 'duration-chan' });
		const bot = await createMockBot({ world });

		const created = (await bot.rest.request('POST', `/channels/${channel.id}/messages`, {
			body: {
				poll: {
					question: { text: 'Best color?' },
					answers: [{ poll_media: { text: 'Red' } }, { poll_media: { text: 'Blue' } }],
					duration: 2,
				},
			},
		})) as { id: string };

		const raw = bot.world.query.rawMessage({ channelId: channel.id, id: created.id });
		expect(raw?.poll?.expiry).toBeDefined();
		expect(Date.parse(raw?.poll?.expiry ?? '') - Date.parse(raw?.timestamp ?? '')).toBe(2 * 60 * 60 * 1000);
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
		expect(
			bot.world.all.pollVote({ channelId: channel.id, messageId: 'poll-msg', answerId: 1 }).map(vote => vote.userId),
		).toEqual(['voter-a']);
		const res = await bot.slash({ name: 'voters', guildId: guild.id, channel, user: actor.user });
		expect(res.content).toBe('voter-a');
		await bot.close();
	});

	test('single-select poll revote moves the voter and honors custom botId for me_voted', async () => {
		const botId = 'custom-poll-bot';
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'revote-guild' });
		const channel = world.registerChannel(guild.id, { id: 'revote-chan' });
		world.registerMessage(channel.id, {
			id: 'revote-poll-msg',
			poll: apiPoll({ question: 'Q', answers: ['A', 'B'], allowMultiselect: false }),
		});

		const bot = await createMockBot({ botId, world });
		bot.seedPollVote(channel.id, 'revote-poll-msg', 1, botId);
		bot.seedPollVote(channel.id, 'revote-poll-msg', 2, botId);

		expect(
			bot.world.all
				.pollVote({ channelId: channel.id, messageId: 'revote-poll-msg', answerId: 1 })
				.map(vote => vote.userId),
		).toEqual([]);
		expect(
			bot.world.all
				.pollVote({ channelId: channel.id, messageId: 'revote-poll-msg', answerId: 2 })
				.map(vote => vote.userId),
		).toEqual([botId]);
		expect(
			bot.world.query.rawMessage({ channelId: channel.id, id: 'revote-poll-msg' })?.poll?.results.answer_counts,
		).toEqual([
			{ id: 1, count: 0, me_voted: false },
			{ id: 2, count: 1, me_voted: true },
		]);
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
		const view = bot.world.query.message({ channelId: channel.id, id: 'end-poll-msg' });
		expect(view?.poll?.isFinalized).toBe(true);
		await bot.close();
	});

	test('poll routes reject non-poll messages and unknown answers', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'poll-guard-guild' });
		const channel = world.registerChannel(guild.id, { id: 'poll-guard-chan' });
		world.registerMessage(channel.id, { id: 'plain-msg', content: 'not a poll' });
		world.registerMessage(channel.id, { id: 'guard-poll-msg', poll: apiPoll({ question: 'Q', answers: ['A'] }) });

		const bot = await createMockBot({ world });
		await expect(bot.rest.request('POST', `/channels/${channel.id}/polls/plain-msg/expire`)).rejects.toThrow(
			/message has no poll/,
		);
		await expect(bot.rest.request('GET', `/channels/${channel.id}/polls/plain-msg/answers/1`)).rejects.toThrow(
			/message has no poll/,
		);
		await expect(bot.rest.request('GET', `/channels/${channel.id}/polls/guard-poll-msg/answers/2`)).rejects.toThrow(
			/unknown poll answer/,
		);
		await bot.close();
	});
});
