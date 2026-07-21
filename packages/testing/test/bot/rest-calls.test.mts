import { ActionRow, Button, Command, type CommandContext, Declare } from 'seyfert';
import { ButtonStyle, InteractionResponseType, InteractionType } from 'seyfert/lib/types';
import { describe, expect, test } from 'vitest';
import { apiUser, createMockBot, mockWorld, Routes, rendered } from '../../src';

describe('restCalls', () => {
	@Declare({ name: 'write-once', description: 'Writes one REST message' })
	class WriteOnceCommand extends Command {
		async run(ctx: CommandContext) {
			await ctx.client.messages.write('rest-calls-channel', { content: 'only' });
		}
	}

	@Declare({ name: 'write-twice', description: 'Writes two REST messages' })
	class WriteTwiceCommand extends Command {
		async run(ctx: CommandContext) {
			await ctx.client.messages.write('rest-calls-channel', { content: 'first' });
			await ctx.client.messages.write('rest-calls-channel', { content: 'second' });
		}
	}

	@Declare({ name: 'actor-write', description: 'Writes one actor-specific REST message' })
	class ActorWriteCommand extends Command {
		async run(ctx: CommandContext) {
			await ctx.client.messages.write(`actor-${ctx.author.id}`, { content: ctx.author.id });
		}
	}

	@Declare({ name: 'actor-panel', description: 'Writes before and after user input' })
	class ActorPanelCommand extends Command {
		async run(ctx: CommandContext) {
			const row = new ActionRow<Button>().setComponents([
				new Button().setCustomId('rest-calls-continue').setLabel('Continue').setStyle(ButtonStyle.Primary),
			]);
			const message = await ctx.write({ content: `panel:${ctx.author.id}`, components: [row] }, true);
			const click = await message.createComponentCollector().waitFor('rest-calls-continue');
			if (click) await click.write({ content: `done:${click.user.id}`, components: [] });
		}
	}

	@Declare({ name: 'callback-response', description: 'Writes an interaction callback response' })
	class CallbackResponseCommand extends Command {
		async run(ctx: CommandContext) {
			await ctx.write({ content: 'callback response' }, true);
		}
	}

	test('always returns ordered arrays for zero, one, and many route matches', async () => {
		const bot = await createMockBot({ commands: [WriteOnceCommand, WriteTwiceCommand] });

		await bot.slash({ name: 'write-once' });
		expect(bot.restCalls(Routes.createMessage)).toHaveLength(1);
		expect(bot.restCalls(Routes.ban)).toEqual([]);

		await bot.slash({ name: 'write-twice' });
		const messages = bot.restCalls(Routes.createMessage);
		expect(messages).toHaveLength(3);
		expect(messages.map(call => call.body?.content)).toEqual(['only', 'first', 'second']);
		await bot.close();
	});

	test('returns the complete bot REST journal when no route is supplied', async () => {
		const bot = await createMockBot({ commands: [WriteTwiceCommand] });

		await bot.slash({ name: 'write-twice' });
		const calls = bot.restCalls();

		expect(calls).toHaveLength(2);
		expect(calls.map(call => `${call.method} ${call.route}`)).toEqual([
			'POST /channels/rest-calls-channel/messages',
			'POST /channels/rest-calls-channel/messages',
		]);
		expect(calls.map(call => call.params)).toEqual([{}, {}]);
		await bot.close();
	});

	test('extracts typed route params', async () => {
		const bot = await createMockBot({ commands: [WriteOnceCommand] });

		await bot.slash({ name: 'write-once' });
		const [message] = bot.restCalls(Routes.createMessage);
		const channelId: string | undefined = message?.params.channelId;

		expect(channelId).toBe('rest-calls-channel');
		await bot.close();
	});

	test('accumulates every bot step and returns independent snapshots', async () => {
		const bot = await createMockBot({ commands: [WriteOnceCommand, WriteTwiceCommand] });

		await bot.slash({ name: 'write-twice' });
		const previous = bot.restCalls(Routes.createMessage);
		const sameStep = bot.restCalls(Routes.createMessage);
		expect(sameStep).not.toBe(previous);
		expect(sameStep[0]).not.toBe(previous[0]);

		await bot.slash({ name: 'write-once' });
		expect(bot.restCalls(Routes.createMessage).map(call => call.body?.content)).toEqual(['first', 'second', 'only']);
		expect(previous.map(call => call.body?.content)).toEqual(['first', 'second']);
		await bot.close();
	});

	test('keeps accumulated actor histories isolated while bot includes every actor in global order', async () => {
		const bot = await createMockBot({ commands: [ActorWriteCommand] });
		const alice = bot.actor({ user: apiUser({ id: 'alice' }) });
		const bob = bot.actor({ user: apiUser({ id: 'bob' }) });

		await alice.slash({ name: 'actor-write' });
		await bob.slash({ name: 'actor-write' });
		await alice.slash({ name: 'actor-write' });

		expect(alice.restCalls(Routes.createMessage).map(call => call.params.channelId)).toEqual([
			'actor-alice',
			'actor-alice',
		]);
		expect(bob.restCalls(Routes.createMessage).map(call => call.params.channelId)).toEqual(['actor-bob']);
		expect(bot.restCalls(Routes.createMessage).map(call => call.params.channelId)).toEqual([
			'actor-alice',
			'actor-bob',
			'actor-alice',
		]);
		await bot.close();
	});

	test('includes stateful actors, raw dispatches, and direct REST in one ordered bot journal', async () => {
		const bot = await createMockBot({ commands: [ActorWriteCommand, WriteOnceCommand] });
		const alice = bot.actor({ user: apiUser({ id: 'alice' }) });
		const bob = bot.actor({ user: apiUser({ id: 'bob' }) });

		await alice.slash({ name: 'actor-write' });
		await bob.slash({ name: 'actor-write' });
		await bot.dispatch.slash({ name: 'write-once' });
		await bot.rest.call(Routes.createMessage, { channelId: 'direct-rest' }, { body: { content: 'direct' } });

		const messages = bot.restCalls(Routes.createMessage);
		expect(messages.map(call => call.body?.content)).toEqual(['alice', 'bob', 'only', 'direct']);
		expect(messages.map(call => call.seq)).toEqual([...messages.map(call => call.seq)].sort((a, b) => a - b));
		expect(alice.restCalls(Routes.createMessage).map(call => call.body?.content)).toEqual(['alice']);
		expect(bob.restCalls(Routes.createMessage).map(call => call.body?.content)).toEqual(['bob']);
		await bot.close();
	});

	test('keeps a resumed opener and its continuation in the owning actor history', async () => {
		const bot = await createMockBot({ commands: [ActorPanelCommand] });
		const alice = bot.actor({ user: apiUser({ id: 'alice' }) });

		await alice.slash({ name: 'actor-panel' });
		rendered(alice).get.message({ content: 'panel:alice' });
		await alice.clickButton('rest-calls-continue');

		const callbacks = alice.restCalls(Routes.interactionCallback);
		expect(callbacks[0]?.response).toMatchObject({
			interaction: { id: expect.any(String), type: 2 },
			resource: { type: 4, message: { content: 'panel:alice' } },
		});
		expect(
			callbacks.map(call => {
				const data = call.body && 'data' in call.body ? call.body.data : undefined;
				return data && 'content' in data ? data.content : undefined;
			}),
		).toEqual(['panel:alice', 'done:alice']);
		rendered(alice).get.message({ content: 'done:alice' });
		await bot.close();
	});

	test('keeps rendered bot and actor readers scoped to latest UI while REST histories accumulate', async () => {
		const bot = await createMockBot({ commands: [ActorWriteCommand] });
		const alice = bot.actor({ user: apiUser({ id: 'alice' }) });
		const bob = bot.actor({ user: apiUser({ id: 'bob' }) });

		await alice.slash({ name: 'actor-write' });
		await bob.slash({ name: 'actor-write' });

		expect(bot.restCalls(Routes.createMessage).map(call => call.body?.content)).toEqual(['alice', 'bob']);
		rendered(bot).get.message({ content: 'bob' });
		rendered(alice).get.message({ content: 'alice' });
		rendered(bob).get.message({ content: 'bob' });
		await bot.close();
	});

	test('adds late causal REST after settle without leaking it into the next actor step', async () => {
		let release!: () => void;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});

		@Declare({ name: 'detached-write', description: 'Starts a detached REST message' })
		class DetachedWriteCommand extends Command {
			async run(ctx: CommandContext) {
				void gate.then(() =>
					ctx.client.messages.write(`late-${ctx.author.id}`, {
						content: 'late',
					}),
				);
			}
		}

		const bot = await createMockBot({ commands: [DetachedWriteCommand, ActorWriteCommand] });
		const alice = bot.actor({ user: apiUser({ id: 'alice' }) });

		await alice.slash({ name: 'detached-write' });
		const beforeRelease = alice.restCalls(Routes.createMessage);
		expect(beforeRelease).toEqual([]);

		release();
		await bot.settle();
		const afterSettle = alice.restCalls(Routes.createMessage);
		expect(afterSettle.map(call => call.params.channelId)).toEqual(['late-alice']);
		expect(beforeRelease).toEqual([]);

		await alice.slash({ name: 'actor-write' });
		expect(alice.restCalls(Routes.createMessage).map(call => call.params.channelId)).toEqual([
			'late-alice',
			'actor-alice',
		]);
		expect(afterSettle.map(call => call.params.channelId)).toEqual(['late-alice']);
		await bot.close();
	});

	test('includes older causal work that lands after a newer actor step starts', async () => {
		let release!: () => void;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});

		@Declare({ name: 'older-detached-write', description: 'Starts an older detached REST message' })
		class OlderDetachedWriteCommand extends Command {
			async run(ctx: CommandContext) {
				void gate.then(() =>
					ctx.client.messages.write(`old-${ctx.author.id}`, {
						content: 'old',
					}),
				);
			}
		}

		const bot = await createMockBot({ commands: [OlderDetachedWriteCommand, ActorWriteCommand] });
		const alice = bot.actor({ user: apiUser({ id: 'alice' }) });

		await alice.slash({ name: 'older-detached-write' });
		await alice.slash({ name: 'actor-write' });
		const current = alice.restCalls(Routes.createMessage);
		expect(current.map(call => call.params.channelId)).toEqual(['actor-alice']);

		release();
		await bot.settle();

		expect(bot.rest.actions.some(action => action.route === '/channels/old-alice/messages')).toBe(true);
		expect(alice.restCalls(Routes.createMessage).map(call => call.params.channelId)).toEqual([
			'actor-alice',
			'old-alice',
		]);
		expect(current.map(call => call.params.channelId)).toEqual(['actor-alice']);
		await bot.close();
	});

	test('exposes pending calls on re-read without mutating earlier snapshots', async () => {
		const bot = await createMockBot();
		let release!: (value: { id: string; type: number }) => void;
		bot.rest.intercept(
			Routes.fetchChannel,
			() =>
				new Promise(resolve => {
					release = resolve;
				}),
		);

		const request = bot.rest.call(Routes.fetchChannel, { channelId: 'pending-channel' });
		const pending = bot.restCalls(Routes.fetchChannel);
		expect(pending).toHaveLength(1);
		expect(pending[0]).toMatchObject({ settled: false, response: undefined });

		release({ id: 'pending-channel', type: 0 });
		await request;
		const settled = bot.restCalls(Routes.fetchChannel);
		expect(settled[0]).toMatchObject({ settled: true, response: { id: 'pending-channel', type: 0 } });
		expect(pending[0]).toMatchObject({ settled: false, response: undefined });
		expect(settled).not.toBe(pending);
		expect(settled[0]).not.toBe(pending[0]);
		await bot.close();
	});

	test('reset clears bot and actor histories', async () => {
		const bot = await createMockBot({ commands: [ActorWriteCommand] });
		const alice = bot.actor({ user: apiUser({ id: 'alice' }) });

		await alice.slash({ name: 'actor-write' });
		expect(bot.restCalls()).not.toEqual([]);
		expect(alice.restCalls()).not.toEqual([]);

		await bot.reset();
		expect(bot.restCalls()).toEqual([]);
		expect(alice.restCalls()).toEqual([]);
		await bot.close();
	});

	test('close retains readable bot and actor history snapshots', async () => {
		const bot = await createMockBot({ commands: [ActorWriteCommand] });
		const alice = bot.actor({ user: apiUser({ id: 'alice' }) });

		await alice.slash({ name: 'actor-write' });
		await bot.close();

		expect(bot.restCalls(Routes.createMessage).map(call => call.body?.content)).toEqual(['alice']);
		expect(alice.restCalls(Routes.createMessage).map(call => call.body?.content)).toEqual(['alice']);
	});

	test('records successful no-content responses as undefined without losing their side effects', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'void-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'void-actor' }) });
		const target = world.registerMember(guild.id, { user: apiUser({ id: 'void-target' }) });
		const channel = world.registerChannel(guild.id, { id: 'void-channel' });
		const deleted = world.registerMessage(channel.id, { id: 'void-delete' });
		const pinned = world.registerMessage(channel.id, { id: 'void-pin' });
		world.registerEmoji(guild.id, { id: 'void-emoji', name: 'temporary' });
		const responses: unknown[] = [];

		@Declare({ name: 'void-mutations', description: 'Runs successful no-content REST mutations' })
		class VoidMutationsCommand extends Command {
			async run(ctx: CommandContext) {
				responses.push(await ctx.client.members.ban(guild.id, target.user.id));
				responses.push(await ctx.client.messages.delete(deleted.id, channel.id));
				responses.push(await ctx.client.channels.setPin(pinned.id, channel.id));
				responses.push(await ctx.client.emojis.delete(guild.id, 'void-emoji'));
			}
		}

		const bot = await createMockBot({ commands: [VoidMutationsCommand], world });
		await bot.slash({ name: 'void-mutations', guildId: guild.id, channel, user: actor.user });

		expect(responses).toEqual([undefined, undefined, undefined, undefined]);
		expect(bot.restCalls(Routes.ban)[0]).toMatchObject({ settled: true, response: undefined });
		expect(bot.restCalls(Routes.deleteMessage)[0]).toMatchObject({ settled: true, response: undefined });
		expect(bot.restCalls(Routes.pinMessage)[0]).toMatchObject({ settled: true, response: undefined });
		expect(bot.restCalls(Routes.deleteEmoji)[0]).toMatchObject({ settled: true, response: undefined });
		expect(bot.world.query.ban({ guildId: guild.id, userId: target.user.id })).toBeDefined();
		expect(bot.world.query.message({ channelId: channel.id, id: deleted.id })).toBeUndefined();
		expect(bot.world.query.pin({ channelId: channel.id, messageId: pinned.id })).toBeDefined();
		expect(bot.world.query.emoji({ guildId: guild.id, id: 'void-emoji' })).toBeUndefined();

		const callbackParams = { id: 'void-interaction', token: 'void-token' };
		const callbackResponse = await bot.rest.call(Routes.interactionCallback, callbackParams, {
			body: { type: 8, data: { choices: [] } },
			query: { with_response: false },
		});
		expect(callbackResponse).toBeUndefined();
		expect(
			bot.restCalls(Routes.interactionCallback).find(call => call.params.token === callbackParams.token),
		).toMatchObject({ settled: true, response: undefined });
		await expect(
			bot.rest.call(Routes.interactionCallback, callbackParams, {
				body: { type: 8, data: { choices: [] } },
				query: { with_response: false },
			}),
		).rejects.toThrow(/already been acknowledged/i);
		await bot.close();
	});

	test('records complete with-response callback results for message and non-message callbacks', async () => {
		const bot = await createMockBot({ commands: [CallbackResponseCommand] });
		await bot.slash({ name: 'callback-response' });

		const messageCallback = bot.restCalls(Routes.interactionCallback)[0];
		expect(messageCallback?.response).toMatchObject({
			interaction: {
				id: messageCallback?.params.id,
				type: InteractionType.ApplicationCommand,
			},
			resource: {
				type: InteractionResponseType.ChannelMessageWithSource,
				message: { content: 'callback response' },
			},
		});

		await bot.rest.call(
			Routes.interactionCallback,
			{ id: 'autocomplete-interaction', token: 'autocomplete-token' },
			{
				body: { type: InteractionResponseType.ApplicationCommandAutocompleteResult, data: { choices: [] } },
				query: { with_response: true },
			},
		);
		const autocompleteCallback = bot
			.restCalls(Routes.interactionCallback)
			.find(call => call.params.id === 'autocomplete-interaction');
		expect(autocompleteCallback?.response).toEqual({
			interaction: {
				id: 'autocomplete-interaction',
				type: InteractionType.ApplicationCommandAutocomplete,
			},
		});
		await bot.close();
	});
});
