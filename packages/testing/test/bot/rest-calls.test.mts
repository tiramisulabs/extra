import { Command, type CommandContext, Declare } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { apiUser, createMockBot, Routes } from '../../src';

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

	test('always returns ordered arrays for zero, one, and many route matches', async () => {
		const bot = await createMockBot({ commands: [WriteOnceCommand, WriteTwiceCommand] });

		await bot.slash({ name: 'write-once' });
		expect(bot.restCalls(Routes.createMessage)).toHaveLength(1);
		expect(bot.restCalls(Routes.ban)).toEqual([]);

		await bot.slash({ name: 'write-twice' });
		const messages = bot.restCalls(Routes.createMessage);
		expect(messages).toHaveLength(2);
		expect(messages.map(call => call.body?.content)).toEqual(['first', 'second']);
		await bot.close();
	});

	test('returns all calls from the latest step when no route is supplied', async () => {
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

	test('reads only the latest bot step and returns independent snapshots', async () => {
		const bot = await createMockBot({ commands: [WriteOnceCommand, WriteTwiceCommand] });

		await bot.slash({ name: 'write-twice' });
		const previous = bot.restCalls(Routes.createMessage);
		const sameStep = bot.restCalls(Routes.createMessage);
		expect(sameStep).not.toBe(previous);
		expect(sameStep[0]).not.toBe(previous[0]);

		await bot.slash({ name: 'write-once' });
		expect(bot.restCalls(Routes.createMessage).map(call => call.body?.content)).toEqual(['only']);
		expect(previous.map(call => call.body?.content)).toEqual(['first', 'second']);
		await bot.close();
	});

	test('keeps actor histories isolated while bot follows the latest actor step', async () => {
		const bot = await createMockBot({ commands: [ActorWriteCommand] });
		const alice = bot.actor({ user: apiUser({ id: 'alice' }) });
		const bob = bot.actor({ user: apiUser({ id: 'bob' }) });

		await alice.slash({ name: 'actor-write' });
		await bob.slash({ name: 'actor-write' });

		expect(alice.restCalls(Routes.createMessage).map(call => call.params.channelId)).toEqual(['actor-alice']);
		expect(bob.restCalls(Routes.createMessage).map(call => call.params.channelId)).toEqual(['actor-bob']);
		expect(bot.restCalls(Routes.createMessage).map(call => call.params.channelId)).toEqual(['actor-bob']);
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
		expect(alice.restCalls(Routes.createMessage).map(call => call.params.channelId)).toEqual(['actor-alice']);
		expect(afterSettle.map(call => call.params.channelId)).toEqual(['late-alice']);
		await bot.close();
	});

	test('excludes an older dispatch that writes only after a newer actor step starts', async () => {
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
		expect(alice.restCalls(Routes.createMessage).map(call => call.params.channelId)).toEqual(['actor-alice']);
		expect(current.map(call => call.params.channelId)).toEqual(['actor-alice']);
		await bot.close();
	});
});
