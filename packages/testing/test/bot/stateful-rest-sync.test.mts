import {
	ActionRow,
	Button,
	Command,
	type CommandContext,
	ContextMenuCommand,
	createEvent,
	createStringOption,
	Declare,
	EntryPointCommand,
	Label,
	type MenuCommandContext,
	type MessageCommandInteraction,
	Modal,
	Options,
	StringSelectMenu,
	type StringSelectMenuInteraction,
	StringSelectOption,
	TextInput,
	type UserCommandInteraction,
} from 'seyfert';
import {
	ApplicationCommandType,
	ButtonStyle,
	EntryPointCommandHandlerType,
	InteractionResponseType,
	TextInputStyle,
} from 'seyfert/lib/types';
import { describe, expect, test, vi } from 'vitest';
import { apiChannel, apiMember, apiMessage, apiUser, createMockBot, memberAddEvent, Routes, rendered } from '../../src';

function nextImmediate(): Promise<void> {
	return new Promise(resolve => setImmediate(resolve));
}

async function afterImmediates(count: number): Promise<void> {
	for (let index = 0; index < count; index++) await nextImmediate();
}

describe('stateful action REST synchronization', () => {
	@Declare({ name: 'detached-complete', description: 'Starts detached writes before completing' })
	class DetachedCompleteCommand extends Command {
		async run(ctx: CommandContext) {
			await ctx.write({ content: 'command complete' });
			void Promise.resolve().then(() => ctx.client.messages.write('microtask-channel', { content: 'microtask write' }));
			void nextImmediate().then(() => ctx.client.messages.write('immediate-channel', { content: 'immediate write' }));
		}
	}

	test('awaiting a completed high-level action drains causal microtask and setImmediate REST without settle()', async () => {
		const bot = await createMockBot({ commands: [DetachedCompleteCommand] });

		const result = await bot.slash({ name: 'detached-complete' });

		const writes = bot
			.restCalls(Routes.createMessage)
			.filter(call => call.params.channelId === 'microtask-channel' || call.params.channelId === 'immediate-channel');
		expect(writes.map(call => call.body?.content)).toEqual(['microtask write', 'immediate write']);
		expect(writes.every(call => call.settled && call.error === undefined && call.response?.id)).toBe(true);
		const immediate = writes.find(call => call.params.channelId === 'immediate-channel');
		expect(immediate?.response?.id).toBeDefined();
		expect(
			bot.world.query.message({ channelId: 'immediate-channel', id: immediate?.response?.id ?? '' })?.content,
		).toBe('immediate write');
		rendered(bot).get.message({ content: 'immediate write' });
		// Post-handler discovery strengthens the live bot state. It does not mutate the result snapshot built earlier.
		expect(result.actions.some(action => action.route === '/channels/immediate-channel/messages')).toBe(false);
		expect(result.messages.some(message => message.content === 'immediate write')).toBe(false);
		const history = bot.restCalls();
		expect(history).not.toBeInstanceOf(Promise);
		expect(history.map(call => call.seq)).toEqual(
			[...history.map(call => call.seq)].sort((left, right) => left - right),
		);
		await bot.close();
	});

	test('otherwise-settled modal and component checkpoints do not discover unstarted macrotask REST', async () => {
		@Declare({ name: 'modal-no-discovery', description: 'Parks without discovering later work' })
		class ModalNoDiscoveryCommand extends Command {
			async run(ctx: CommandContext) {
				void nextImmediate().then(() =>
					ctx.client.messages.write('modal-no-discovery-channel', { content: 'modal deferred write' }),
				);
				await ctx.interaction.modal(
					new Modal()
						.setCustomId('no-discovery-modal')
						.setTitle('No discovery')
						.setComponents([
							new Label()
								.setLabel('Value')
								.setComponent(new TextInput({ custom_id: 'value', style: TextInputStyle.Short })),
						]),
					{ waitFor: 30_000 },
				);
			}
		}

		@Declare({ name: 'component-no-discovery', description: 'Parks without discovering later work' })
		class ComponentNoDiscoveryCommand extends Command {
			async run(ctx: CommandContext) {
				const row = new ActionRow<Button>().setComponents([
					new Button().setCustomId('no-discovery-button').setLabel('Continue').setStyle(ButtonStyle.Primary),
				]);
				const message = await ctx.write({ content: 'component checkpoint', components: [row] }, true);
				void nextImmediate().then(() =>
					ctx.client.messages.write('component-no-discovery-channel', { content: 'component deferred write' }),
				);
				await message.createComponentCollector().waitFor('no-discovery-button');
			}
		}

		const modalBot = await createMockBot({ commands: [ModalNoDiscoveryCommand] });
		await modalBot.slash({ name: 'modal-no-discovery' });
		rendered(modalBot).get.modal('no-discovery-modal');
		expect(
			modalBot.restCalls(Routes.createMessage).find(call => call.params.channelId === 'modal-no-discovery-channel'),
		).toBeUndefined();
		await modalBot.settle();
		expect(
			modalBot.restCalls(Routes.createMessage).find(call => call.params.channelId === 'modal-no-discovery-channel'),
		).toMatchObject({ settled: true, body: { content: 'modal deferred write' } });
		await modalBot.close();

		const componentBot = await createMockBot({ commands: [ComponentNoDiscoveryCommand] });
		await componentBot.slash({ name: 'component-no-discovery' });
		rendered(componentBot).get.button('no-discovery-button');
		expect(
			componentBot
				.restCalls(Routes.createMessage)
				.find(call => call.params.channelId === 'component-no-discovery-channel'),
		).toBeUndefined();
		await componentBot.settle();
		expect(
			componentBot
				.restCalls(Routes.createMessage)
				.find(call => call.params.channelId === 'component-no-discovery-channel'),
		).toMatchObject({ settled: true, body: { content: 'component deferred write' } });
		await componentBot.close();
	});

	test('a checkpoint drains a direct microtask-child REST chain', async () => {
		let markParentStarted!: () => void;
		const parentStarted = new Promise<void>(resolve => {
			markParentStarted = resolve;
		});
		let releaseParent!: () => void;
		const parentGate = new Promise<void>(resolve => {
			releaseParent = resolve;
		});
		let markChildStarted!: () => void;
		const childStarted = new Promise<void>(resolve => {
			markChildStarted = resolve;
		});
		let releaseChild!: () => void;
		const childGate = new Promise<void>(resolve => {
			releaseChild = resolve;
		});

		@Declare({ name: 'checkpoint-rest-chain', description: 'Starts a REST child when its parent settles' })
		class CheckpointRestChainCommand extends Command {
			async run(ctx: CommandContext) {
				void ctx.client.channels
					.fetch('checkpoint-parent-channel')
					.then(() => ctx.client.channels.fetch('checkpoint-child-channel'));
				await ctx.interaction.modal(
					new Modal().setCustomId('checkpoint-chain-modal').setTitle('Chain').setComponents([]),
					{ waitFor: 30_000 },
				);
			}
		}

		const bot = await createMockBot({ commands: [CheckpointRestChainCommand] });
		bot.rest.intercept(Routes.fetchChannel, async (_action, params) => {
			if (params.channelId === 'checkpoint-parent-channel') {
				markParentStarted();
				await parentGate;
			} else {
				markChildStarted();
				await childGate;
			}
			return apiChannel({ id: params.channelId });
		});

		const modalRecorded = bot.rest.waitUntilAction(
			recorded =>
				recorded.method === 'POST' &&
				(recorded.body as { type?: number } | undefined)?.type === InteractionResponseType.Modal,
		);
		const action = bot.slash({ name: 'checkpoint-rest-chain' });
		let actionSettled = false;
		void action.then(
			() => {
				actionSettled = true;
			},
			() => {
				actionSettled = true;
			},
		);
		let parentReleased = false;
		let childReleased = false;

		try {
			await Promise.all([parentStarted, modalRecorded]);
			expect(actionSettled).toBe(false);
			expect(bot.restCalls(Routes.fetchChannel).map(call => call.params.channelId)).toEqual([
				'checkpoint-parent-channel',
			]);

			parentReleased = true;
			releaseParent();
			await childStarted;
			expect(actionSettled).toBe(false);

			childReleased = true;
			releaseChild();
			await action;

			expect(bot.restCalls(Routes.fetchChannel).map(call => call.params.channelId)).toEqual([
				'checkpoint-parent-channel',
				'checkpoint-child-channel',
			]);
			expect(bot.restCalls(Routes.fetchChannel).every(call => call.settled && call.error === undefined)).toBe(true);
			rendered(bot).get.modal('checkpoint-chain-modal');
		} finally {
			if (!parentReleased) releaseParent();
			if (!childReleased) releaseChild();
			await action.catch(() => undefined);
			await bot.close();
		}
	});

	test('a modal checkpoint parks the opener only after its already-started REST settles', async () => {
		@Declare({ name: 'modal-checkpoint-rest', description: 'Starts REST before waiting for a modal' })
		class ModalCheckpointRestCommand extends Command {
			async run(ctx: CommandContext) {
				void ctx.client.channels.fetch('modal-checkpoint-channel');
				await ctx.interaction.modal(
					new Modal()
						.setCustomId('rest-sync-modal')
						.setTitle('REST sync')
						.setComponents([
							new Label()
								.setLabel('Value')
								.setComponent(new TextInput({ custom_id: 'value', style: TextInputStyle.Short })),
						]),
					{ waitFor: 30_000 },
				);
			}
		}

		const bot = await createMockBot({ commands: [ModalCheckpointRestCommand] });
		bot.rest.intercept(Routes.fetchChannel, async (_action, params) => {
			await afterImmediates(4);
			return apiChannel({ id: params.channelId });
		});

		await bot.slash({ name: 'modal-checkpoint-rest' });

		rendered(bot).get.modal('rest-sync-modal');
		const [fetch] = bot.restCalls(Routes.fetchChannel);
		expect(fetch).toMatchObject({ params: { channelId: 'modal-checkpoint-channel' }, settled: true });
		expect(fetch?.error).toBeUndefined();
		await bot.close();
	});

	test('a component checkpoint parks the opener only after its already-started REST settles', async () => {
		@Declare({ name: 'component-checkpoint-rest', description: 'Starts REST before waiting for a button' })
		class ComponentCheckpointRestCommand extends Command {
			async run(ctx: CommandContext) {
				const row = new ActionRow<Button>().setComponents([
					new Button().setCustomId('rest-sync-continue').setLabel('Continue').setStyle(ButtonStyle.Primary),
				]);
				const message = await ctx.write({ content: 'ready', components: [row] }, true);
				void ctx.client.channels.fetch('component-checkpoint-channel');
				await message.createComponentCollector().waitFor('rest-sync-continue');
			}
		}

		const bot = await createMockBot({ commands: [ComponentCheckpointRestCommand] });
		bot.rest.intercept(Routes.fetchChannel, async (_action, params) => {
			await afterImmediates(4);
			return apiChannel({ id: params.channelId });
		});

		await bot.slash({ name: 'component-checkpoint-rest' });

		rendered(bot).get.button('rest-sync-continue');
		const [fetch] = bot.restCalls(Routes.fetchChannel);
		expect(fetch).toMatchObject({ params: { channelId: 'component-checkpoint-channel' }, settled: true });
		expect(fetch?.error).toBeUndefined();
		await bot.close();
	});

	test('resumed actions drain causal REST without discovering macrotasks past a final checkpoint', async () => {
		@Declare({ name: 'resumed-opener-rest', description: 'Writes after each resumed input' })
		class ResumedOpenerRestCommand extends Command {
			async run(ctx: CommandContext) {
				const submit = await ctx.interaction.modal(
					new Modal()
						.setCustomId('resumed-rest-modal')
						.setTitle('Resume')
						.setComponents([
							new Label()
								.setLabel('Value')
								.setComponent(new TextInput({ custom_id: 'value', style: TextInputStyle.Short })),
						]),
					{ waitFor: 30_000 },
				);
				if (!submit) return;

				const row = new ActionRow<Button>().setComponents([
					new Button().setCustomId('resumed-rest-save').setLabel('Save').setStyle(ButtonStyle.Primary),
				]);
				const summary = await submit.editOrReply({ content: 'review', components: [row] }, true);
				void nextImmediate().then(() =>
					ctx.client.messages.write('submit-resumed-channel', { content: 'submit resumed write' }),
				);
				const click = await summary.createComponentCollector().waitFor('resumed-rest-save');
				if (!click) return;

				await click.write({ content: 'saved', components: [] });
				void nextImmediate().then(() =>
					ctx.client.messages.write('click-resumed-channel', { content: 'click resumed write' }),
				);
			}
		}

		const bot = await createMockBot({ commands: [ResumedOpenerRestCommand] });
		await bot.slash({ name: 'resumed-opener-rest' });

		await bot.submitModal('resumed-rest-modal', { value: 'x' });
		expect(
			bot.restCalls(Routes.createMessage).find(call => call.params.channelId === 'submit-resumed-channel'),
		).toBeUndefined();
		rendered(bot).get.button('resumed-rest-save');

		await bot.settle();
		const submitWrite = bot
			.restCalls(Routes.createMessage)
			.find(call => call.params.channelId === 'submit-resumed-channel');
		expect(submitWrite).toMatchObject({ settled: true, body: { content: 'submit resumed write' } });
		expect(submitWrite?.error).toBeUndefined();

		await bot.clickButton('resumed-rest-save');
		const clickWrite = bot
			.restCalls(Routes.createMessage)
			.find(call => call.params.channelId === 'click-resumed-channel');
		expect(clickWrite).toMatchObject({ settled: true, body: { content: 'click resumed write' } });
		expect(clickWrite?.error).toBeUndefined();
		rendered(bot).get.message({ content: 'saved' });
		await bot.close();
	});

	test('a resumed opener checkpoint drains REST already started by its modal continuation', async () => {
		@Declare({ name: 'resumed-started-rest', description: 'Starts REST before its next input checkpoint' })
		class ResumedStartedRestCommand extends Command {
			async run(ctx: CommandContext) {
				const submit = await ctx.interaction.modal(
					new Modal()
						.setCustomId('resumed-started-modal')
						.setTitle('Resume')
						.setComponents([
							new Label()
								.setLabel('Value')
								.setComponent(new TextInput({ custom_id: 'value', style: TextInputStyle.Short })),
						]),
					{ waitFor: 30_000 },
				);
				if (!submit) return;

				void ctx.client.channels.fetch('resumed-started-channel');
				const row = new ActionRow<Button>().setComponents([
					new Button().setCustomId('resumed-started-save').setLabel('Save').setStyle(ButtonStyle.Primary),
				]);
				const summary = await submit.editOrReply({ content: 'review', components: [row] }, true);
				await summary.createComponentCollector().waitFor('resumed-started-save');
			}
		}

		const bot = await createMockBot({ commands: [ResumedStartedRestCommand] });
		bot.rest.intercept(Routes.fetchChannel, async (_action, params) => {
			await afterImmediates(4);
			return apiChannel({ id: params.channelId });
		});
		await bot.slash({ name: 'resumed-started-rest' });

		await bot.submitModal('resumed-started-modal', { value: 'x' });

		const [started] = bot.restCalls(Routes.fetchChannel);
		expect(started).toMatchObject({ params: { channelId: 'resumed-started-channel' }, settled: true });
		expect(started?.error).toBeUndefined();
		rendered(bot).get.button('resumed-started-save');
		await bot.close();
	});

	test('concurrent actors drain only their own causal REST histories', async () => {
		@Declare({ name: 'actor-detached-rest', description: 'Writes once for the invoking actor' })
		class ActorDetachedRestCommand extends Command {
			async run(ctx: CommandContext) {
				await ctx.write({ content: `started:${ctx.author.id}` });
				void nextImmediate().then(() =>
					ctx.client.messages.write(`actor-sync-${ctx.author.id}`, { content: `written:${ctx.author.id}` }),
				);
			}
		}

		const bot = await createMockBot({ commands: [ActorDetachedRestCommand] });
		const alice = bot.actor({ user: apiUser({ id: 'sync-alice' }) });
		const bob = bot.actor({ user: apiUser({ id: 'sync-bob' }) });

		await Promise.all([alice.slash({ name: 'actor-detached-rest' }), bob.slash({ name: 'actor-detached-rest' })]);

		expect(alice.restCalls(Routes.createMessage).map(call => call.params.channelId)).toEqual(['actor-sync-sync-alice']);
		expect(bob.restCalls(Routes.createMessage).map(call => call.params.channelId)).toEqual(['actor-sync-sync-bob']);
		const globalChannels = bot.restCalls(Routes.createMessage).map(call => call.params.channelId);
		expect(globalChannels).toHaveLength(2);
		expect(globalChannels).toEqual(expect.arrayContaining(['actor-sync-sync-alice', 'actor-sync-sync-bob']));
		rendered(alice).get.message({ content: 'written:sync-alice' });
		rendered(bob).get.message({ content: 'written:sync-bob' });
		await bot.close();
	});

	test('Actor.selectMenu uses the same causal synchronization seam', async () => {
		@Declare({ name: 'actor-select-rest', description: 'Waits for an actor selection' })
		class ActorSelectRestCommand extends Command {
			async run(ctx: CommandContext) {
				const row = new ActionRow<StringSelectMenu>().setComponents([
					new StringSelectMenu()
						.setCustomId('actor-region')
						.setOptions([new StringSelectOption().setLabel('Europe').setValue('eu')]),
				]);
				const message = await ctx.write({ content: 'choose region', components: [row] }, true);
				const select = await message.createComponentCollector().waitFor<StringSelectMenuInteraction>('actor-region');
				if (!select) return;
				await select.write({ content: `selected:${select.values[0]}`, components: [] });
				void nextImmediate().then(() =>
					ctx.client.messages.write(`actor-select-${ctx.author.id}`, { content: select.values[0] }),
				);
			}
		}

		const bot = await createMockBot({ commands: [ActorSelectRestCommand] });
		const actor = bot.actor({ user: apiUser({ id: 'select-actor' }) });
		await actor.slash({ name: 'actor-select-rest' });

		await actor.selectMenu('actor-region', ['eu']);

		expect(actor.restCalls(Routes.createMessage)).toMatchObject([
			{ params: { channelId: 'actor-select-select-actor' }, settled: true, body: { content: 'eu' } },
		]);
		await bot.close();
	});

	test('a direct global pending request is visible in full history but does not block an unrelated stateful action', async () => {
		let release!: (value: ReturnType<typeof apiChannel>) => void;
		const bot = await createMockBot({ commands: [DetachedCompleteCommand] });
		bot.rest.intercept(
			Routes.fetchChannel,
			() =>
				new Promise(resolve => {
					release = resolve;
				}),
		);
		const direct = bot.rest.call(Routes.fetchChannel, { channelId: 'global-held-channel' });

		try {
			await bot.slash({ name: 'detached-complete' });

			const [held] = bot.restCalls(Routes.fetchChannel);
			expect(held).toMatchObject({ params: { channelId: 'global-held-channel' }, settled: false });
			expect(bot.restCalls(Routes.createMessage).map(call => call.params.channelId)).toEqual([
				'microtask-channel',
				'immediate-channel',
			]);
			expect(bot.restCalls()).not.toBeInstanceOf(Promise);
		} finally {
			release(apiChannel({ id: 'global-held-channel' }));
			await direct;
			await bot.close();
		}
	});

	test('older promise-delayed work is excluded from a newer step drain', async () => {
		let releaseOlder!: () => void;
		const olderGate = new Promise<void>(resolve => {
			releaseOlder = resolve;
		});
		let releaseRequest!: (value: ReturnType<typeof apiChannel>) => void;
		let olderRequest: Promise<unknown> | undefined;

		@Declare({ name: 'arm-older-rest', description: 'Arms work for a later external signal' })
		class ArmOlderRestCommand extends Command {
			async run(ctx: CommandContext) {
				await ctx.write({ content: 'older armed' });
				void olderGate.then(() => {
					olderRequest = ctx.client.channels.fetch('older-held-channel').catch(() => undefined);
					return olderRequest;
				});
			}
		}

		@Declare({ name: 'newer-rest', description: 'Starts current causal work' })
		class NewerRestCommand extends Command {
			async run(ctx: CommandContext) {
				await ctx.write({ content: 'newer started' });
				void nextImmediate().then(() =>
					ctx.client.messages.write('newer-causal-channel', { content: 'newer causal write' }),
				);
			}
		}

		const bot = await createMockBot({ commands: [ArmOlderRestCommand, NewerRestCommand] });
		const actor = bot.actor({ user: apiUser({ id: 'older-owner' }) });
		bot.rest.intercept(
			Routes.fetchChannel,
			() =>
				new Promise(resolve => {
					releaseRequest = resolve;
				}),
		);

		await actor.slash({ name: 'arm-older-rest' });
		expect(actor.restCalls(Routes.fetchChannel)).toEqual([]);
		releaseOlder();

		try {
			await actor.slash({ name: 'newer-rest' });

			expect(actor.restCalls(Routes.fetchChannel)).toMatchObject([
				{ params: { channelId: 'older-held-channel' }, settled: false },
			]);
			expect(actor.restCalls(Routes.createMessage)).toMatchObject([
				{ params: { channelId: 'newer-causal-channel' }, settled: true },
			]);
		} finally {
			releaseRequest(apiChannel({ id: 'older-held-channel' }));
			await olderRequest;
			await bot.close();
		}
	});

	test('work behind an arbitrary quiet non-REST gap remains excluded until the caller explicitly settles', async () => {
		let release!: () => void;
		const externalGap = new Promise<void>(resolve => {
			release = resolve;
		});

		@Declare({ name: 'quiet-gap-rest', description: 'Waits on an unobservable external promise' })
		class QuietGapRestCommand extends Command {
			async run(ctx: CommandContext) {
				await ctx.write({ content: 'quiet gap armed' });
				void externalGap.then(() => ctx.client.messages.write('quiet-gap-channel', { content: 'after quiet gap' }));
			}
		}

		const bot = await createMockBot({ commands: [QuietGapRestCommand] });
		await bot.slash({ name: 'quiet-gap-rest' });
		expect(bot.restCalls(Routes.createMessage)).toEqual([]);

		release();
		await bot.settle();
		expect(bot.restCalls(Routes.createMessage)).toMatchObject([
			{ params: { channelId: 'quiet-gap-channel' }, settled: true, body: { content: 'after quiet gap' } },
		]);
		await bot.close();
	});

	test('a caught detached REST failure is settled and visible immediately after the action', async () => {
		@Declare({ name: 'detached-rest-failure', description: 'Catches a detached REST failure' })
		class DetachedRestFailureCommand extends Command {
			async run(ctx: CommandContext) {
				await ctx.write({ content: 'failure scheduled' });
				void nextImmediate()
					.then(() => ctx.client.channels.fetch('failed-causal-channel'))
					.catch(() => undefined);
			}
		}

		const bot = await createMockBot({ commands: [DetachedRestFailureCommand] });
		bot.rest.intercept(Routes.fetchChannel, () => {
			throw new Error('causal REST failed');
		});

		await bot.slash({ name: 'detached-rest-failure' });

		const [failed] = bot.restCalls(Routes.fetchChannel);
		expect(failed).toMatchObject({
			params: { channelId: 'failed-causal-channel' },
			settled: true,
			response: undefined,
		});
		expect(failed.error).toBeInstanceOf(Error);
		expect((failed.error as Error).message).toBe('causal REST failed');
		await bot.close();
	});

	test('a high-level action drains a multi-round causal REST chain without settle()', async () => {
		const channelPrefix = 'stateful-round-';

		@Declare({ name: 'stateful-rest-rounds', description: 'Starts a sequential detached REST chain' })
		class StatefulRestRoundsCommand extends Command {
			async run(ctx: CommandContext) {
				await ctx.write({ content: 'rounds started' });
				void (async () => {
					for (let index = 0; index < 3; index++) {
						await ctx.client.channels.fetch(`${channelPrefix}${index}`);
					}
				})();
			}
		}

		const bot = await createMockBot({ commands: [StatefulRestRoundsCommand] });
		bot.rest.intercept(Routes.fetchChannel, async (_action, params) => {
			await nextImmediate();
			return apiChannel({ id: params.channelId });
		});

		await bot.slash({ name: 'stateful-rest-rounds' });

		const rounds = bot.restCalls(Routes.fetchChannel).filter(call => call.params.channelId.startsWith(channelPrefix));
		expect(rounds.map(call => call.params.channelId)).toEqual([
			`${channelPrefix}0`,
			`${channelPrefix}1`,
			`${channelPrefix}2`,
		]);
		expect(rounds.every(call => call.settled && call.error === undefined)).toBe(true);
		await bot.close();
	});

	test('a handler error wins over a never-settling causal REST drain', async () => {
		let release!: (value: ReturnType<typeof apiChannel>) => void;
		let retained: Promise<unknown> | undefined;

		@Declare({ name: 'handler-error-first', description: 'Throws after starting retained REST' })
		class HandlerErrorFirstCommand extends Command {
			async run(ctx: CommandContext) {
				retained = ctx.client.channels.fetch('handler-error-held').catch(() => undefined);
				throw new Error('handler error takes precedence');
			}
		}

		const bot = await createMockBot({ commands: [HandlerErrorFirstCommand] });
		bot.rest.intercept(
			Routes.fetchChannel,
			() =>
				new Promise(resolve => {
					release = resolve;
				}),
		);

		try {
			await expect(bot.slash({ name: 'handler-error-first' })).rejects.toThrow('handler error takes precedence');
		} finally {
			release(apiChannel({ id: 'handler-error-held' }));
			await retained;
			await bot.close();
		}
	});

	test('stateful drain diagnostics redact interaction tokens', async () => {
		const secretToken = 'STATEFUL-SUPER-SECRET-TOKEN';
		const secretRoute = `/interactions/stateful-diagnostic/${secretToken}/callback` as const;
		let release!: (value: undefined) => void;
		let retained: Promise<unknown> | undefined;

		@Declare({ name: 'stateful-token-diagnostic', description: 'Starts retained credential-bearing REST' })
		class StatefulTokenDiagnosticCommand extends Command {
			async run(ctx: CommandContext) {
				retained = ctx.client.rest.request('POST', secretRoute).catch(() => undefined);
				await ctx.write({ content: 'token request retained' });
			}
		}

		const bot = await createMockBot({ commands: [StatefulTokenDiagnosticCommand] });
		bot.rest.intercept(
			'POST',
			secretRoute,
			() =>
				new Promise(resolve => {
					release = resolve;
				}),
		);

		try {
			const error = await bot.slash({ name: 'stateful-token-diagnostic' }).then(
				() => undefined,
				cause => cause,
			);
			expect(error).toBeInstanceOf(Error);
			const diagnostic = (error as Error).message;
			expect(diagnostic).not.toContain(secretToken);
			expect(diagnostic).toContain('/interactions/stateful-diagnostic/:token/callback');
		} finally {
			release(undefined);
			await retained;
			await bot.close();
		}
	}, 10_000);

	test.each([
		'reset',
		'close',
	] as const)('%s rejects while an automatic stateful drain is in progress', async lifecycle => {
		let markStarted!: () => void;
		const started = new Promise<void>(resolve => {
			markStarted = resolve;
		});
		let markHandlerReturned!: () => void;
		const handlerReturned = new Promise<void>(resolve => {
			markHandlerReturned = resolve;
		});
		let release!: (value: ReturnType<typeof apiChannel>) => void;
		let retained: Promise<unknown> | undefined;

		@Declare({ name: `lifecycle-${lifecycle}-drain`, description: 'Starts retained REST for lifecycle interruption' })
		class LifecycleDrainCommand extends Command {
			async run(ctx: CommandContext) {
				retained = ctx.client.channels.fetch(`lifecycle-${lifecycle}-held`).catch(() => undefined);
				await ctx.write({ content: 'lifecycle request retained' });
				markHandlerReturned();
			}
		}

		@Declare({ name: `lifecycle-${lifecycle}-probe`, description: 'Proves a rejected lifecycle stayed usable' })
		class LifecycleProbeCommand extends Command {
			async run() {}
		}

		const bot = await createMockBot({ commands: [LifecycleDrainCommand, LifecycleProbeCommand] });
		bot.rest.intercept(
			Routes.fetchChannel,
			() =>
				new Promise(resolve => {
					release = resolve;
					markStarted();
				}),
		);
		const action = bot.slash({ name: `lifecycle-${lifecycle}-drain` });
		await started;
		await handlerReturned;
		await nextImmediate();
		let released = false;
		let lifecycleSucceeded = false;
		const journalBeforeLifecycle = bot.restCalls();

		try {
			const error = await bot[lifecycle]().then(
				() => undefined,
				cause => cause,
			);
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toMatch(/stateful step is settling causal REST/i);
			expect(bot.restCalls(Routes.fetchChannel)).toMatchObject([
				{ params: { channelId: `lifecycle-${lifecycle}-held` }, settled: false },
			]);
			if (lifecycle === 'close') {
				expect(bot.restCalls()).toEqual(journalBeforeLifecycle);
				const probe = await bot.slash({ name: 'lifecycle-close-probe' });
				expect(probe.actions).toHaveLength(0);
				expect(bot.restCalls()).toEqual(journalBeforeLifecycle);
			}

			released = true;
			release(apiChannel({ id: `lifecycle-${lifecycle}-held` }));
			await retained;
			await action;
			await bot[lifecycle]();
			lifecycleSucceeded = true;
			if (lifecycle === 'reset') expect(bot.restCalls()).toHaveLength(0);
		} finally {
			if (!released) release(apiChannel({ id: `lifecycle-${lifecycle}-held` }));
			await retained;
			await action.catch(() => undefined);
			if (lifecycle === 'reset' || !lifecycleSucceeded) await bot.close();
		}
	}, 10_000);

	test.each([
		'reset',
		'close',
	] as const)("%s preflight preserves another actor's parked modal when a high-level step is active", async lifecycle => {
		let markHandlerReady!: () => void;
		const handlerReady = new Promise<void>(resolve => {
			markHandlerReady = resolve;
		});
		let allowHandlerReturn!: () => void;
		const handlerGate = new Promise<void>(resolve => {
			allowHandlerReturn = resolve;
		});
		let releaseRest!: (value: ReturnType<typeof apiChannel>) => void;
		let retained: Promise<unknown> | undefined;

		@Declare({ name: `lifecycle-${lifecycle}-parked-modal`, description: 'Parks an independent actor modal' })
		class ParkedModalCommand extends Command {
			async run(ctx: CommandContext) {
				const submit = await ctx.interaction.modal(
					new Modal()
						.setCustomId(`lifecycle-${lifecycle}-surviving-modal`)
						.setTitle('Surviving modal')
						.setComponents([
							new Label()
								.setLabel('Value')
								.setComponent(new TextInput({ custom_id: 'value', style: TextInputStyle.Short })),
						]),
					{ waitFor: 30_000 },
				);
				if (submit) await submit.write({ content: `${lifecycle} modal survived` });
			}
		}

		@Declare({ name: `lifecycle-${lifecycle}-active-step`, description: 'Keeps a high-level step active' })
		class ActiveStepCommand extends Command {
			async run(ctx: CommandContext) {
				retained = ctx.client.channels.fetch(`lifecycle-${lifecycle}-transition-rest`).catch(() => undefined);
				await ctx.write({ content: 'active step entered' });
				markHandlerReady();
				await handlerGate;
			}
		}

		const bot = await createMockBot({ commands: [ParkedModalCommand, ActiveStepCommand] });
		bot.rest.intercept(
			Routes.fetchChannel,
			() =>
				new Promise(resolve => {
					releaseRest = resolve;
				}),
		);
		const bob = bot.actor({ user: apiUser({ id: `lifecycle-${lifecycle}-bob` }) });
		const alice = bot.actor({ user: apiUser({ id: `lifecycle-${lifecycle}-alice` }) });
		await bob.slash({ name: `lifecycle-${lifecycle}-parked-modal` });
		rendered(bob).get.modal(`lifecycle-${lifecycle}-surviving-modal`);

		const aliceAction = alice.slash({ name: `lifecycle-${lifecycle}-active-step` });
		await handlerReady;
		let released = false;
		let lifecycleSucceeded = false;

		try {
			const error = await bot[lifecycle]().then(
				() => undefined,
				cause => cause,
			);

			await bob.submitModal(`lifecycle-${lifecycle}-surviving-modal`, { value: 'still here' });
			rendered(bob).get.message({ content: `${lifecycle} modal survived` });
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toMatch(/stateful step.*in progress/i);

			released = true;
			allowHandlerReturn();
			releaseRest(apiChannel({ id: `lifecycle-${lifecycle}-transition-rest` }));
			await retained;
			await aliceAction;
			await bot[lifecycle]();
			lifecycleSucceeded = true;
		} finally {
			if (!released) {
				allowHandlerReturn();
				releaseRest(apiChannel({ id: `lifecycle-${lifecycle}-transition-rest` }));
			}
			await retained;
			await aliceAction.catch(() => undefined);
			if (lifecycle === 'reset' || !lifecycleSucceeded) await bot.close();
		}
	}, 10_000);

	test('reset rejects a stateful action started after input shutdown begins, then accepts one after reset', async () => {
		let markShutdownStarted!: () => void;
		const shutdownStarted = new Promise<void>(resolve => {
			markShutdownStarted = resolve;
		});
		let releaseShutdownContinuation!: () => void;
		const shutdownContinuationGate = new Promise<void>(resolve => {
			releaseShutdownContinuation = resolve;
		});
		let markRestStarted!: () => void;
		const restStarted = new Promise<void>(resolve => {
			markRestStarted = resolve;
		});
		let releaseRest!: () => void;
		const restGate = new Promise<void>(resolve => {
			releaseRest = resolve;
		});

		@Declare({ name: 'reset-transition-parked', description: 'Keeps reset in input shutdown' })
		class ResetTransitionParkedCommand extends Command {
			async run(ctx: CommandContext) {
				const submit = await ctx.interaction.modal(
					new Modal().setCustomId('reset-transition-modal').setTitle('Reset transition').setComponents([]),
					{ waitFor: 30_000 },
				);
				if (submit !== null) return;
				markShutdownStarted();
				await shutdownContinuationGate;
			}
		}

		@Declare({ name: 'reset-transition-racer', description: 'Would enter a drain during reset' })
		class ResetTransitionRacerCommand extends Command {
			async run(ctx: CommandContext) {
				void ctx.client.channels.fetch('reset-transition-held-channel');
				await ctx.write({ content: 'racer entered' });
			}
		}

		@Declare({ name: 'reset-transition-after', description: 'Runs after reset completes' })
		class ResetTransitionAfterCommand extends Command {
			async run(ctx: CommandContext) {
				await ctx.write({ content: 'post-reset action accepted' });
			}
		}

		const bot = await createMockBot({
			commands: [ResetTransitionParkedCommand, ResetTransitionRacerCommand, ResetTransitionAfterCommand],
		});
		bot.rest.intercept(Routes.fetchChannel, async (_action, params) => {
			markRestStarted();
			await restGate;
			return apiChannel({ id: params.channelId });
		});
		const bob = bot.actor({ user: apiUser({ id: 'reset-transition-bob' }) });
		const alice = bot.actor({ user: apiUser({ id: 'reset-transition-alice' }) });
		await bob.slash({ name: 'reset-transition-parked' });
		rendered(bob).get.modal('reset-transition-modal');

		const reset = bot.reset();
		await shutdownStarted;
		const duringReset = Promise.resolve().then(() => alice.slash({ name: 'reset-transition-racer' }));
		let released = false;
		let resetCompleted = false;

		try {
			const outcome = await Promise.race([
				duringReset.then(
					() => ({ kind: 'resolved' as const }),
					error => ({ kind: 'rejected' as const, error }),
				),
				restStarted.then(() => ({ kind: 'rest-started' as const })),
			]);
			expect(outcome.kind).toBe('rejected');
			if (outcome.kind !== 'rejected') throw new Error(`Expected reset rejection, received ${outcome.kind}.`);
			expect(outcome.error).toBeInstanceOf(Error);
			expect((outcome.error as Error).message).toMatch(/reset.*in progress/i);

			released = true;
			releaseShutdownContinuation();
			releaseRest();
			await duringReset.catch(() => undefined);
			await reset;
			resetCompleted = true;

			const after = await alice.slash({ name: 'reset-transition-after' });
			expect(after.content).toBe('post-reset action accepted');
		} finally {
			if (!released) {
				releaseShutdownContinuation();
				releaseRest();
			}
			await duringReset.catch(() => undefined);
			await reset.catch(() => undefined);
			if (!resetCompleted) await bot.reset().catch(() => undefined);
			await bot.close();
		}
	}, 10_000);

	test('default fake timers leave faked setImmediate work for explicit timer advancement', async () => {
		const bot = await createMockBot({ commands: [DetachedCompleteCommand] });
		vi.useFakeTimers();
		try {
			await bot.slash({ name: 'detached-complete' });
			expect(bot.restCalls(Routes.createMessage).map(call => call.params.channelId)).toEqual(['microtask-channel']);

			await vi.runOnlyPendingTimersAsync();
			expect(bot.restCalls(Routes.createMessage).map(call => call.params.channelId)).toEqual([
				'microtask-channel',
				'immediate-channel',
			]);
		} finally {
			vi.useRealTimers();
			await bot.close();
		}
	});

	test('selective fake timers keep automatic causal discovery operational', async () => {
		const bot = await createMockBot({ commands: [DetachedCompleteCommand] });
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		try {
			await bot.slash({ name: 'detached-complete' });
			expect(bot.restCalls(Routes.createMessage).map(call => call.params.channelId)).toEqual([
				'microtask-channel',
				'immediate-channel',
			]);
		} finally {
			vi.useRealTimers();
			await bot.close();
		}
	});

	test('raw Dispatch completion keeps its existing timing contract', async () => {
		const bot = await createMockBot({ commands: [DetachedCompleteCommand] });

		await bot.dispatch.slash({ name: 'detached-complete' });
		expect(bot.restCalls(Routes.createMessage).map(call => call.params.channelId)).toEqual(['microtask-channel']);

		await bot.settle();
		expect(bot.restCalls(Routes.createMessage).map(call => call.params.channelId)).toEqual([
			'microtask-channel',
			'immediate-channel',
		]);
		await bot.close();
	});

	test('autocomplete remains a raw temporal surface and does not auto-discover detached REST', async () => {
		const options = {
			query: createStringOption({
				description: 'Query',
				autocomplete: async interaction => {
					const value = interaction.getInput();
					await interaction.respond([{ name: value, value }]);
					void nextImmediate().then(() =>
						interaction.client.messages.write('autocomplete-excluded-channel', {
							content: 'autocomplete detached write',
						}),
					);
				},
			}),
		};

		@Declare({ name: 'autocomplete-excluded', description: 'Keeps raw autocomplete timing' })
		@Options(options)
		class AutocompleteExcludedCommand extends Command {}

		const bot = await createMockBot({ commands: [AutocompleteExcludedCommand] });
		await bot.autocomplete({ name: 'autocomplete-excluded', focused: 'query', value: 'raw' });

		expect(
			bot.restCalls(Routes.createMessage).find(call => call.params.channelId === 'autocomplete-excluded-channel'),
		).toBeUndefined();
		await bot.settle();
		expect(
			bot.restCalls(Routes.createMessage).find(call => call.params.channelId === 'autocomplete-excluded-channel'),
		).toMatchObject({ settled: true, body: { content: 'autocomplete detached write' } });
		await bot.close();
	});

	test('say remains a raw temporal surface and does not auto-discover detached REST', async () => {
		@Declare({ name: 'say-excluded', description: 'Keeps raw prefix timing' })
		class SayExcludedCommand extends Command {
			async run(ctx: CommandContext) {
				await ctx.write({ content: 'prefix replied' });
				void nextImmediate().then(() =>
					ctx.client.messages.write('say-excluded-channel', { content: 'say detached write' }),
				);
			}
		}

		const bot = await createMockBot({ commands: [SayExcludedCommand], prefixes: ['!'] });
		await bot.say('!say-excluded');

		expect(
			bot.restCalls(Routes.createMessage).find(call => call.params.channelId === 'say-excluded-channel'),
		).toBeUndefined();
		await bot.settle();
		expect(
			bot.restCalls(Routes.createMessage).find(call => call.params.channelId === 'say-excluded-channel'),
		).toMatchObject({ settled: true, body: { content: 'say detached write' } });
		await bot.close();
	});

	test('emit remains a raw temporal surface and does not auto-discover detached REST', async () => {
		const onJoin = createEvent({
			data: { name: 'guildMemberAdd' },
			async run(_member, client) {
				void nextImmediate().then(() =>
					client.messages.write('emit-excluded-channel', { content: 'emit detached write' }),
				);
			},
		});
		const bot = await createMockBot({ events: [onJoin] });

		await bot.emit(
			'GUILD_MEMBER_ADD',
			memberAddEvent(apiMember({ user: apiUser({ id: 'emit-excluded-user' }) }), {
				guildId: 'emit-excluded-guild',
			}),
		);

		expect(
			bot.restCalls(Routes.createMessage).find(call => call.params.channelId === 'emit-excluded-channel'),
		).toBeUndefined();
		await bot.settle();
		expect(
			bot.restCalls(Routes.createMessage).find(call => call.params.channelId === 'emit-excluded-channel'),
		).toMatchObject({ settled: true, body: { content: 'emit detached write' } });
		await bot.close();
	});

	test('remaining high-level verbs share the stateful synchronization seam', async () => {
		class DetachedUserMenu extends ContextMenuCommand {
			type = ApplicationCommandType.User as const;
			name = 'Detached User Menu';
			async run(ctx: MenuCommandContext<UserCommandInteraction>) {
				await ctx.write({ content: `user:${ctx.target.id}` });
				void nextImmediate().then(() =>
					ctx.client.messages.write(`user-menu-${ctx.target.id}`, { content: 'user menu REST' }),
				);
			}
		}

		class DetachedMessageMenu extends ContextMenuCommand {
			type = ApplicationCommandType.Message as const;
			name = 'Detached Message Menu';
			async run(ctx: MenuCommandContext<MessageCommandInteraction>) {
				await ctx.write({ content: `message:${ctx.target.id}` });
				void nextImmediate().then(() =>
					ctx.client.messages.write(`message-menu-${ctx.target.id}`, { content: 'message menu REST' }),
				);
			}
		}

		class DetachedEntryPoint extends EntryPointCommand {
			name = 'detached-entry-point';
			description = 'Starts detached entry point REST';
			handler = EntryPointCommandHandlerType.AppHandler;
			async run(ctx: Parameters<NonNullable<EntryPointCommand['run']>>[0]) {
				await ctx.write({ content: 'entry point' });
				void nextImmediate().then(() =>
					ctx.client.messages.write('entry-point-channel', { content: 'entry point REST' }),
				);
			}
		}

		const bot = await createMockBot({
			commands: [DetachedUserMenu, DetachedMessageMenu, DetachedEntryPoint],
		});
		await bot.userMenu({ name: 'Detached User Menu', target: apiUser({ id: 'direct-user' }) });
		await bot.menu(DetachedUserMenu, { target: apiUser({ id: 'class-user' }) });
		await bot.messageMenu({ name: 'Detached Message Menu', target: apiMessage({ id: 'direct-message' }) });
		await bot.menu(DetachedMessageMenu, { target: apiMessage({ id: 'class-message' }) });
		await bot.entryPoint({ name: 'detached-entry-point' });

		expect(bot.restCalls(Routes.createMessage).map(call => call.params.channelId)).toEqual([
			'user-menu-direct-user',
			'user-menu-class-user',
			'message-menu-direct-message',
			'message-menu-class-message',
			'entry-point-channel',
		]);
		await bot.close();
	});

	test('stateful drain diagnostics cap pending entries, report omissions, and redact every token', async () => {
		const diagnosticEntryLimit = 20;
		const pendingCount = 25;
		const secretPrefix = 'STATEFUL-BULK-SECRET-';
		let releaseAll!: () => void;
		const held = new Promise<void>(resolve => {
			releaseAll = resolve;
		});
		let retained: Promise<unknown>[] = [];

		@Declare({ name: 'many-pending-rest', description: 'Starts many retained credential-bearing requests' })
		class ManyPendingRestCommand extends Command {
			async run(ctx: CommandContext) {
				retained = Array.from({ length: pendingCount }, (_, index) =>
					ctx.client.rest
						.request('POST', `/interactions/bulk-${index}/${secretPrefix}${index}/callback`)
						.catch(() => undefined),
				);
				await ctx.write({ content: 'many requests retained' });
			}
		}

		const bot = await createMockBot({ commands: [ManyPendingRestCommand] });
		bot.rest.intercept('POST', /^\/interactions\/bulk-\d+\/[^/]+\/callback$/, async () => {
			await held;
			return undefined;
		});

		try {
			const error = await bot.slash({ name: 'many-pending-rest' }).then(
				() => undefined,
				cause => cause,
			);

			expect(error).toBeInstanceOf(Error);
			const diagnostic = (error as Error).message;
			const renderedEntries =
				diagnostic.match(/^- dispatchId=.* POST \/interactions\/bulk-\d+\/:token\/callback$/gm) ?? [];
			expect(renderedEntries).toHaveLength(diagnosticEntryLimit);
			expect(renderedEntries.map(entry => Number(entry.match(/\/bulk-(\d+)\//)?.[1]))).toEqual(
				Array.from({ length: diagnosticEntryLimit }, (_, index) => index),
			);
			expect(diagnostic).toMatch(new RegExp(`${pendingCount - diagnosticEntryLimit} .*omitted`, 'i'));
			expect(diagnostic).not.toContain(secretPrefix);
		} finally {
			releaseAll();
			await Promise.all(retained);
			await bot.close();
		}
	}, 10_000);

	test('a never-settling causal request rejects with bounded stateful-step diagnostics', async () => {
		let release!: (value: ReturnType<typeof apiChannel>) => void;
		let retained: Promise<unknown> | undefined;

		@Declare({ name: 'never-settled-stateful-rest', description: 'Starts REST that never settles' })
		class NeverSettledStatefulRestCommand extends Command {
			async run(ctx: CommandContext) {
				retained = ctx.client.channels.fetch('never-settled-causal-channel').catch(() => undefined);
				await ctx.write({ content: 'request retained' });
			}
		}

		const bot = await createMockBot({ commands: [NeverSettledStatefulRestCommand] });
		bot.rest.intercept(
			Routes.fetchChannel,
			() =>
				new Promise(resolve => {
					release = resolve;
				}),
		);

		try {
			const error = await bot.slash({ name: 'never-settled-stateful-rest' }).then(
				() => undefined,
				cause => cause,
			);

			expect(error).toBeInstanceOf(Error);
			const diagnostic = (error as Error).message;
			expect(diagnostic).toMatch(/stateful step|causal REST/i);
			expect(diagnostic).toMatch(/1000 iterations/);
			expect(diagnostic).toMatch(/1 pending REST request/);
			expect(diagnostic).toContain('GET /channels/never-settled-causal-channel');
		} finally {
			release(apiChannel({ id: 'never-settled-causal-channel' }));
			await retained;
			await bot.close();
		}
	}, 10_000);
});
