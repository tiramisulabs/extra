import {
	ActionRow,
	Button,
	Command,
	type CommandContext,
	ComponentCommand,
	type ComponentContext,
	Declare,
	Label,
	Modal,
	TextInput,
} from 'seyfert';
import { ButtonStyle, TextInputStyle } from 'seyfert/lib/types';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { apiUser } from '../../src/bot/payloads';
import { mockWorld } from '../../src/bot/world';

// seyfert's collector idle/timeout and modal waitFor timers use the bare GLOBAL setTimeout, with no injection
// seam, so the mock cannot own them. We fake only setTimeout/clearTimeout (leaving setImmediate real) so the
// mock's own drain — which yields through the real setImmediate captured at module load — keeps flushing while
// the runner's fake clock advances seyfert's timers.
const FAKE_TIMER_OPTIONS = { toFake: ['setTimeout', 'clearTimeout'] } satisfies Parameters<typeof vi.useFakeTimers>[0];

describe('virtual clock', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	describe('event-driven untilModal', () => {
		test('resolves the instant a modal is registered, then submitModal completes', async () => {
			const submitted: string[] = [];

			class FeedbackButton extends ComponentCommand {
				componentType = 'Button' as const;
				filter(ctx: ComponentContext<'Button'>) {
					return ctx.customId === 'open-feedback';
				}
				async run(ctx: ComponentContext<'Button'>) {
					const modal = new Modal()
						.setCustomId('feedback-modal')
						.setTitle('Feedback')
						.setComponents([
							new Label()
								.setLabel('Rating')
								.setComponent(new TextInput({ custom_id: 'rating', style: TextInputStyle.Short })),
						]);
					const submit = await ctx.interaction.modal(modal, { waitFor: 30_000 });
					if (submit) {
						submitted.push(submit.user.id);
						await submit.write({ content: 'thanks' });
					}
				}
			}

			const bot = await createMockBot({ components: [FeedbackButton] });
			const user = apiUser({ id: '777' });
			await bot.rest.request('POST', '/channels/feedback-source/messages', {
				body: {
					components: [
						{
							type: 1,
							components: [{ type: 2, style: 1, custom_id: 'open-feedback', label: 'Feedback' }],
						},
					],
				},
			});
			const source = bot.actions.at(-1);
			if (!source) throw new Error('expected feedback source action');

			await bot.clickButton('open-feedback', { user, source });
			const modal = await bot.submitModal('feedback-modal', { rating: '5' }, { user });

			expect(submitted).toEqual(['777']);
			expect(modal.reply?.body).toMatchObject({ data: { content: 'thanks' } });
			await bot.close();
		});

		test('raw dispatch.submitModal(...) runs the whole opener→submit→settle flow in one call', async () => {
			const submitted: string[] = [];

			class FeedbackButton extends ComponentCommand {
				componentType = 'Button' as const;
				filter(ctx: ComponentContext<'Button'>) {
					return ctx.customId === 'open-feedback';
				}
				async run(ctx: ComponentContext<'Button'>) {
					const modal = new Modal()
						.setCustomId('feedback-modal')
						.setTitle('Feedback')
						.setComponents([
							new Label()
								.setLabel('Rating')
								.setComponent(new TextInput({ custom_id: 'rating', style: TextInputStyle.Short })),
						]);
					const submit = await ctx.interaction.modal(modal, { waitFor: 30_000 });
					if (submit) {
						submitted.push(submit.user.id);
						await submit.write({ content: 'thanks' });
					}
				}
			}

			const bot = await createMockBot({ components: [FeedbackButton] });
			const user = apiUser({ id: '888' });

			const modal = await bot.dispatch
				.clickButton('open-feedback', { user, allowSyntheticSource: true })
				.submitModal('feedback-modal', { rating: '5' });

			expect(submitted).toEqual(['888']);
			expect(modal.reply?.body).toMatchObject({ data: { content: 'thanks' } });
			await bot.close();
		});

		test('raw dispatch.submitModal returns replies written after async opener continuation work', async () => {
			class AsyncAfterWaitButton extends ComponentCommand {
				componentType = 'Button' as const;
				filter(ctx: ComponentContext<'Button'>) {
					return ctx.customId === 'open-async-feedback';
				}
				async run(ctx: ComponentContext<'Button'>) {
					const submit = await ctx.interaction.modal(
						new Modal()
							.setCustomId('async-feedback-modal')
							.setTitle('Feedback')
							.setComponents([
								new Label()
									.setLabel('Rating')
									.setComponent(new TextInput({ custom_id: 'rating', style: TextInputStyle.Short })),
							]),
						{ waitFor: 30_000 },
					);
					if (!submit) return;
					await new Promise<void>(resolve => setImmediate(resolve));
					await submit.write({ content: 'thanks after async work' });
				}
			}

			const bot = await createMockBot({ components: [AsyncAfterWaitButton] });
			const user = apiUser({ id: 'async-modal-user' });

			const modal = await bot.dispatch
				.clickButton('open-async-feedback', { user, allowSyntheticSource: true })
				.submitModal('async-feedback-modal', { rating: '5' });

			expect(modal.content).toBe('thanks after async work');
			await bot.close();
		});

		test('back-to-back same-user modal flows do not consume a stale modal entry', async () => {
			class MultiModalButton extends ComponentCommand {
				componentType = 'Button' as const;
				filter(ctx: ComponentContext<'Button'>) {
					return ctx.customId.startsWith('open:');
				}
				async run(ctx: ComponentContext<'Button'>) {
					const name = ctx.customId.split(':')[1];
					const submit = await ctx.interaction.modal(
						new Modal()
							.setCustomId(`modal:${name}`)
							.setTitle(name)
							.setComponents([
								new Label()
									.setLabel('Value')
									.setComponent(new TextInput({ custom_id: 'value', style: TextInputStyle.Short })),
							]),
						{ waitFor: 30_000 },
					);
					if (submit) await submit.write({ content: `submitted:${name}` });
				}
			}

			const bot = await createMockBot({ components: [MultiModalButton] });
			const user = apiUser({ id: 'same-user-modal' });
			await bot.rest.request('POST', '/channels/modal-source/messages', {
				body: {
					content: 'modal buttons',
					components: [
						{
							type: 1,
							components: [
								{ type: 2, style: 1, custom_id: 'open:first', label: 'First' },
								{ type: 2, style: 1, custom_id: 'open:second', label: 'Second' },
							],
						},
					],
				},
			});
			const source = bot.actions.at(-1);
			if (!source) throw new Error('expected modal source action');

			await bot.clickButton('open:first', { user, source });
			await expect(bot.submitModal('modal:first', { value: '1' }, { user })).resolves.toMatchObject({
				content: 'submitted:first',
			});
			await bot.clickButton('open:second', { user, source });
			await expect(bot.submitModal('modal:second', { value: '2' }, { user })).resolves.toMatchObject({
				content: 'submitted:second',
			});
			await bot.close();
		});

		test('timeoutModal() drives the timeout branch in one call (no fake timers, no untilModal)', async () => {
			const outcomes: ('submitted' | 'timed-out')[] = [];

			class FeedbackButton extends ComponentCommand {
				componentType = 'Button' as const;
				filter(ctx: ComponentContext<'Button'>) {
					return ctx.customId === 'open-feedback';
				}
				async run(ctx: ComponentContext<'Button'>) {
					const submit = await ctx.interaction.modal(
						new Modal()
							.setCustomId('feedback-modal')
							.setTitle('Feedback')
							.setComponents([
								new Label()
									.setLabel('Rating')
									.setComponent(new TextInput({ custom_id: 'rating', style: TextInputStyle.Short })),
							]),
						{ waitFor: 30_000 },
					);
					outcomes.push(submit ? 'submitted' : 'timed-out');
				}
			}

			const bot = await createMockBot({ components: [FeedbackButton] });
			const user = apiUser({ id: 'timeout-user' });

			await bot.dispatch.clickButton('open-feedback', { user, allowSyntheticSource: true }).timeoutModal();

			expect(outcomes).toEqual(['timed-out']);
			await bot.close();
		});

		test('raw submitModal before the opener ran names the opener, not the user', async () => {
			class FeedbackButton extends ComponentCommand {
				componentType = 'Button' as const;
				filter(ctx: ComponentContext<'Button'>) {
					return ctx.customId === 'open-feedback';
				}
				async run(ctx: ComponentContext<'Button'>) {
					await ctx.interaction.modal(
						new Modal().setCustomId('feedback-modal').setTitle('Feedback').setComponents([]),
						{ waitFor: 30_000 },
					);
				}
			}

			const bot = await createMockBot({ components: [FeedbackButton] });
			const user = apiUser({ id: '999' });
			bot.dispatch.clickButton('open-feedback', { user, allowSyntheticSource: true }); // never stepped/awaited

			expect(() => bot.dispatch.submitModal('feedback-modal', { rating: '5' }, { user })).toThrow(/opener has not run/);
			await bot.close();
		});

		test('a stateful modal opener yields instead of stalling on the waitFor timer', async () => {
			class StallButton extends ComponentCommand {
				componentType = 'Button' as const;
				filter(ctx: ComponentContext<'Button'>) {
					return ctx.customId === 'open-stall';
				}
				async run(ctx: ComponentContext<'Button'>) {
					await ctx.interaction.modal(new Modal().setCustomId('stall-modal').setTitle('Stall').setComponents([]), {
						waitFor: 30_000,
					});
				}
			}

			const bot = await createMockBot({ components: [StallButton] });
			const user = apiUser({ id: 'stall-user' });
			await bot.rest.request('POST', '/channels/stall-source/messages', {
				body: {
					components: [
						{
							type: 1,
							components: [{ type: 2, style: 1, custom_id: 'open-stall', label: 'Open' }],
						},
					],
				},
			});
			const source = bot.actions.at(-1);
			if (!source) throw new Error('expected stall source action');

			await expect(bot.clickButton('open-stall', { user, source })).resolves.toBeDefined();
			await bot.close();
		});

		test('awaiting a raw modal opener directly fails fast with the driving API', async () => {
			class RawStallButton extends ComponentCommand {
				componentType = 'Button' as const;
				filter(ctx: ComponentContext<'Button'>) {
					return ctx.customId === 'open-raw-stall';
				}
				async run(ctx: ComponentContext<'Button'>) {
					await ctx.interaction.modal(
						new Modal().setCustomId('raw-stall-modal').setTitle('Raw stall').setComponents([]),
						{ waitFor: 30_000 },
					);
				}
			}

			const bot = await createMockBot({ components: [RawStallButton] });
			await expect(bot.dispatch.clickButton('open-raw-stall', { allowSyntheticSource: true })).rejects.toThrow(
				/opened.+from a raw dispatch.+raw\.submitModal/s,
			);
			await bot.close();
		});

		test('a natural stateful modal timeout clears ownership before the next modal', async () => {
			vi.useFakeTimers(FAKE_TIMER_OPTIONS);
			const outcomes: string[] = [];

			class TimedModalButton extends ComponentCommand {
				componentType = 'Button' as const;
				filter(ctx: ComponentContext<'Button'>) {
					return ctx.customId.startsWith('open-timed:');
				}
				async run(ctx: ComponentContext<'Button'>) {
					const name = ctx.customId.split(':')[1];
					const submit = await ctx.interaction.modal(
						new Modal().setCustomId(`timed:${name}`).setTitle(name).setComponents([]),
						{ waitFor: 1_000 },
					);
					outcomes.push(`${name}:${submit ? 'submitted' : 'timed-out'}`);
				}
			}

			const bot = await createMockBot({
				components: [TimedModalButton],
				timers: {
					advance: ms => {
						vi.advanceTimersByTime(ms);
					},
				},
			});
			const user = apiUser({ id: 'natural-timeout-user' });
			await bot.rest.request('POST', '/channels/timed-source/messages', {
				body: {
					components: [
						{
							type: 1,
							components: [
								{ type: 2, style: 1, custom_id: 'open-timed:first', label: 'First' },
								{ type: 2, style: 1, custom_id: 'open-timed:second', label: 'Second' },
							],
						},
					],
				},
			});
			const source = bot.actions.at(-1);
			if (!source) throw new Error('expected timed source action');

			await bot.clickButton('open-timed:first', { user, source });
			await bot.advanceTime(1_000);
			expect(outcomes).toEqual(['first:timed-out']);

			await bot.clickButton('open-timed:second', { user, source });
			await bot.submitModal('timed:second', {}, { user });
			expect(outcomes).toEqual(['first:timed-out', 'second:submitted']);
			await bot.close();
		});

		test('rejects fast when the command never opens a modal (no wall-clock timeout)', async () => {
			@Declare({ name: 'noop', description: 'Replies without opening a modal' })
			class NoopCommand extends Command {
				async run(ctx: CommandContext) {
					await ctx.write({ content: 'no modal here' });
				}
			}

			const bot = await createMockBot({ commands: [NoopCommand] });
			const dispatch = bot.dispatch.slash({ name: 'noop' });

			await expect(dispatch.untilModal()).rejects.toThrow(/dispatch completed without opening a modal for user/);
			await bot.close();
		});
	});

	test('close surfaces a handler error that happened after the last input checkpoint', async () => {
		vi.useFakeTimers(FAKE_TIMER_OPTIONS);

		@Declare({ name: 'late-checkpoint-error', description: 'Fails after input expires' })
		class LateCheckpointError extends Command {
			async run(ctx: CommandContext) {
				const row = new ActionRow<Button>().setComponents([
					new Button().setCustomId('late-input').setLabel('Wait').setStyle(ButtonStyle.Primary),
				]);
				const message = await ctx.write({ content: 'Waiting', components: [row] }, true);
				await message.createComponentCollector().waitFor('late-input', 1_000);
				throw new Error('late checkpoint failure');
			}
		}

		const bot = await createMockBot({
			commands: [LateCheckpointError],
			timers: {
				advance: ms => {
					vi.advanceTimersByTime(ms);
				},
			},
		});
		await bot.slash({ name: 'late-checkpoint-error' });
		await bot.advanceTime(1_000);
		await expect(bot.close()).rejects.toThrow('late checkpoint failure');
	});

	test('a settled waitFor timeout removes its stale checkpoint before the next wait', async () => {
		vi.useFakeTimers(FAKE_TIMER_OPTIONS);

		@Declare({ name: 'repeated-wait', description: 'Reuses a custom id after a timed out wait' })
		class RepeatedWait extends Command {
			async run(ctx: CommandContext) {
				const row = new ActionRow<Button>().setComponents([
					new Button().setCustomId('same-wait').setLabel('Continue').setStyle(ButtonStyle.Primary),
				]);
				const first = await ctx.write({ content: 'first', components: [row] }, true);
				await first.createComponentCollector().waitFor(['same-wait', 'cancel'], 5);
				const second = await ctx.interaction.followup({ content: 'second', components: [row] });
				const click = await second.createComponentCollector().waitFor(['same-wait', 'cancel'], 1_000);
				if (click) await click.write({ content: 'finished', components: [] });
			}
		}

		const bot = await createMockBot({
			commands: [RepeatedWait],
			timers: { advance: ms => void vi.advanceTimersByTime(ms) },
		});
		await bot.slash({ name: 'repeated-wait' });
		await bot.advanceTime(5);
		await bot.waitForAction(candidate => candidate.body?.content === 'second');

		const result = await bot.clickButton('same-wait');
		expect(result.content).toBe('finished');
		await bot.close();
	});

	test('close cancels a modal timer and surfaces the timeout continuation error', async () => {
		vi.useFakeTimers(FAKE_TIMER_OPTIONS);
		const events: string[] = [];

		@Declare({ name: 'close-modal-wait', description: 'Parks on a modal until close' })
		class CloseModalWait extends Command {
			async run(ctx: CommandContext) {
				const submit = await ctx.interaction.modal(
					new Modal().setCustomId('close-modal').setTitle('Close').setComponents([]),
					{ waitFor: 30_000 },
				);
				events.push(submit ? 'submitted' : 'timed-out');
				throw new Error('modal close continuation failed');
			}
		}

		const bot = await createMockBot({ commands: [CloseModalWait] });
		await bot.slash({ name: 'close-modal-wait' });

		await expect(bot.close()).rejects.toThrow('modal close continuation failed');
		expect(events).toEqual(['timed-out']);
		expect(vi.getTimerCount()).toBe(0);
	});

	test('close cancels a collector wait timer and surfaces the timeout continuation error', async () => {
		vi.useFakeTimers(FAKE_TIMER_OPTIONS);
		const events: string[] = [];

		@Declare({ name: 'close-component-wait', description: 'Parks on a component until close' })
		class CloseComponentWait extends Command {
			async run(ctx: CommandContext) {
				const row = new ActionRow<Button>().setComponents([
					new Button().setCustomId('close-wait').setLabel('Wait').setStyle(ButtonStyle.Primary),
				]);
				const message = await ctx.write({ content: 'waiting', components: [row] }, true);
				const click = await message.createComponentCollector().waitFor('close-wait', 30_000);
				events.push(click ? 'clicked' : 'timed-out');
				throw new Error('collector close continuation failed');
			}
		}

		const bot = await createMockBot({ commands: [CloseComponentWait] });
		await bot.slash({ name: 'close-component-wait' });

		await expect(bot.close()).rejects.toThrow('collector close continuation failed');
		expect(events).toEqual(['timed-out']);
		expect(vi.getTimerCount()).toBe(0);
	});

	test('close clears collector-level idle and timeout handles without running onStop', async () => {
		vi.useFakeTimers(FAKE_TIMER_OPTIONS);
		const stops: (string | undefined)[] = [];

		@Declare({ name: 'close-collector-handles', description: 'Leaves collector-level timers behind' })
		class CloseCollectorHandles extends Command {
			async run(ctx: CommandContext) {
				const message = await ctx.write({ content: 'collector handles' }, true);
				message.createComponentCollector({
					idle: 30_000,
					timeout: 60_000,
					onStop: reason => {
						stops.push(`first:${reason}`);
					},
				});
				message.createComponentCollector({
					timeout: 45_000,
					onStop: reason => {
						stops.push(`replacement:${reason}`);
					},
				});
			}
		}

		const bot = await createMockBot({ commands: [CloseCollectorHandles] });
		await bot.slash({ name: 'close-collector-handles' });
		await bot.close();

		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(60_000);
		expect(stops).toEqual([]);
	});

	test('close immediately cancels an input wait chained from another timeout branch', async () => {
		vi.useFakeTimers(FAKE_TIMER_OPTIONS);
		const events: string[] = [];

		@Declare({ name: 'close-chained-input', description: 'Chains a collector after modal timeout' })
		class CloseChainedInput extends Command {
			async run(ctx: CommandContext) {
				const submit = await ctx.interaction.modal(
					new Modal().setCustomId('close-chain-modal').setTitle('Close').setComponents([]),
					{ waitFor: 30_000 },
				);
				events.push(submit ? 'modal-submit' : 'modal-timeout');
				const row = new ActionRow<Button>().setComponents([
					new Button().setCustomId('close-chain-button').setLabel('Wait').setStyle(ButtonStyle.Primary),
				]);
				const message = await ctx.interaction.followup({ content: 'next wait', components: [row] });
				const click = await message.createComponentCollector().waitFor('close-chain-button', 30_000);
				events.push(click ? 'component-click' : 'component-timeout');
			}
		}

		const bot = await createMockBot({ commands: [CloseChainedInput] });
		await bot.slash({ name: 'close-chained-input' });
		await bot.close();

		expect(events).toEqual(['modal-timeout', 'component-timeout']);
		expect(vi.getTimerCount()).toBe(0);
	});

	test('close fails fast when a timeout continuation becomes non-cancellable application work', async () => {
		vi.useFakeTimers(FAKE_TIMER_OPTIONS);
		const events: string[] = [];
		let release!: () => void;
		const held = new Promise<void>(resolve => {
			release = resolve;
		});

		@Declare({ name: 'close-held-continuation', description: 'Blocks after its modal timeout branch' })
		class CloseHeldContinuation extends Command {
			async run(ctx: CommandContext) {
				const submit = await ctx.interaction.modal(
					new Modal().setCustomId('close-held-modal').setTitle('Close').setComponents([]),
					{ waitFor: 30_000 },
				);
				events.push(submit ? 'submitted' : 'timed-out');
				await held;
				events.push('released');
			}
		}

		const bot = await createMockBot({ commands: [CloseHeldContinuation] });
		await bot.slash({ name: 'close-held-continuation' });

		await expect(bot.close()).rejects.toThrow(/non-input dispatches are still running/);
		expect(events).toEqual(['timed-out']);
		expect(vi.getTimerCount()).toBe(0);

		release();
		await bot.settle();
		expect(events).toEqual(['timed-out', 'released']);
		await bot.close();
	});

	test('advanceTime drives a 60s idle collector onStop instantly', async () => {
		vi.useFakeTimers(FAKE_TIMER_OPTIONS);
		const stops: (string | undefined)[] = [];

		@Declare({ name: 'idlecollector', description: 'Opens a collector that idles out' })
		class IdleCommand extends Command {
			async run(ctx: CommandContext) {
				const row = new ActionRow<Button>().setComponents([
					new Button().setCustomId('idle-btn').setLabel('Click').setStyle(ButtonStyle.Primary),
				]);
				const message = await ctx.write({ content: 'collecting', components: [row] }, true);
				const collector = message.createComponentCollector({
					idle: 60_000,
					onStop: async reason => {
						stops.push(reason);
					},
				});
				collector.run('idle-btn', async () => {});
			}
		}

		const bot = await createMockBot({
			commands: [IdleCommand],
			timers: {
				advance: ms => {
					vi.advanceTimersByTime(ms);
				},
			},
		});

		await bot.slash({ name: 'idlecollector' });
		expect(stops).toEqual([]);
		await bot.advanceTime(60_000);
		expect(stops).toEqual(['idle']);

		await bot.close();
	});

	// A collector-level { timeout } fires onStop('timeout') but does NOT resolve a pending bare `waitFor(id)`
	// (seyfert only resolves waitFor on a matching component or its own per-call timeout). So the abort-by-timeout
	// branch lives in onStop, not after the await — and the flow must NOT be awaited to completion (it parks
	// forever on the unresolved waitFor). Drive it: park with untilComponent, advanceTime to fire onStop, assert.
	test('advanceTime fires a collector-level timeout via onStop (bare waitFor never resolves)', async () => {
		vi.useFakeTimers(FAKE_TIMER_OPTIONS);
		const events: string[] = [];

		@Declare({ name: 'confirmflow', description: 'Opens a confirm collector with a timeout' })
		class ConfirmFlow extends Command {
			async run(ctx: CommandContext) {
				const row = new ActionRow<Button>().setComponents([
					new Button().setCustomId('confirm').setLabel('Confirm').setStyle(ButtonStyle.Primary),
				]);
				const message = await ctx.write({ content: 'confirm?', components: [row] }, true);
				const collector = message.createComponentCollector({
					timeout: 20_000,
					onStop: async reason => {
						events.push(`stop:${reason}`);
					},
				});
				const interaction = await collector.waitFor('confirm');
				// Unreachable on a collector-level timeout — kept to prove the post-await branch never runs.
				events.push(interaction ? 'confirmed' : 'after-await');
			}
		}

		const bot = await createMockBot({
			commands: [ConfirmFlow],
			timers: { advance: ms => void vi.advanceTimersByTime(ms) },
		});

		const flow = bot.dispatch.slash({ name: 'confirmflow' });
		await flow.untilComponent('confirm');
		expect(events).toEqual([]);

		await bot.advanceTime(20_000);
		// onStop fired; the awaited waitFor stayed unresolved, so nothing after the await ran.
		expect(events).toEqual(['stop:timeout']);

		await bot.close();
	});

	test('advanceTime fires a modal waitFor timeout (null branch)', async () => {
		vi.useFakeTimers(FAKE_TIMER_OPTIONS);
		const outcomes: ('submitted' | 'timed-out')[] = [];

		class WaitForButton extends ComponentCommand {
			componentType = 'Button' as const;
			filter(ctx: ComponentContext<'Button'>) {
				return ctx.customId === 'open-waitfor';
			}
			async run(ctx: ComponentContext<'Button'>) {
				const modal = new Modal()
					.setCustomId('waitfor-modal')
					.setTitle('WaitFor')
					.setComponents([
						new Label()
							.setLabel('Rating')
							.setComponent(new TextInput({ custom_id: 'rating', style: TextInputStyle.Short })),
					]);
				const submit = await ctx.interaction.modal(modal, { waitFor: 30_000 });
				outcomes.push(submit ? 'submitted' : 'timed-out');
			}
		}

		const bot = await createMockBot({
			components: [WaitForButton],
			timers: {
				advance: ms => {
					vi.advanceTimersByTime(ms);
				},
			},
		});
		const user = apiUser({ id: '888' });

		const dispatch = bot.dispatch.clickButton('open-waitfor', { user, allowSyntheticSource: true });
		await dispatch.untilModal();
		expect(outcomes).toEqual([]);
		await bot.advanceTime(30_000);
		await dispatch;
		expect(outcomes).toEqual(['timed-out']);

		await bot.close();
	});

	test('advanceTime throws clearly when no fake timers are configured', async () => {
		const bot = await createMockBot({});
		await expect(bot.advanceTime(1000)).rejects.toThrow(/no fake timers configured/);
		await bot.close();
	});

	test('advanceTime throws clearly when fake timers also faked setImmediate', async () => {
		const bot = await createMockBot({
			timers: {
				advance: ms => {
					vi.advanceTimersByTime(ms);
				},
			},
		});
		// Default toFake replaces global setImmediate, which would deadlock the mock's drain — guard must throw.
		vi.useFakeTimers();
		await expect(bot.advanceTime(1000)).rejects.toThrow(/fake timers/);
		vi.useRealTimers();
		await bot.close();
	});

	test('flushPending throws clearly when fake timers also faked setImmediate', async () => {
		const bot = await createMockBot({});
		vi.useFakeTimers();
		await expect(bot.flushPending()).rejects.toThrow(/fake timers/);
		vi.useRealTimers();
		await bot.close();
	});

	test('waitForAction still rejects on real time under faked setTimeout (control timeout is wall-clock)', async () => {
		const bot = await createMockBot({});
		// With global setTimeout faked, a naive control timer would freeze and waitForAction would hang forever.
		vi.useFakeTimers(FAKE_TIMER_OPTIONS);
		await expect(bot.rest.waitForAction({ method: 'GET', route: '/never-happens' }, 50)).rejects.toThrow(/timed out/);
		vi.useRealTimers();
		await bot.close();
	});

	test('advanceTime moves the harness permission clock for member timeout expiry', async () => {
		vi.useFakeTimers(FAKE_TIMER_OPTIONS);
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'timeout-perm-guild' });
		const muted = world.registerMember(guild.id, {
			user: apiUser({ id: 'timeout-perm-user' }),
			roles: [world.registerRole(guild.id, { id: 'speaker', permissions: ['SendMessages'] }).id],
			communicationDisabledUntil: new Date(Date.now() + 60_000).toISOString(),
		});
		const channel = world.registerChannel(guild.id);

		@Declare({ name: 'can-speak', description: 'Reads member permissions' })
		class CanSpeak extends Command {
			async run(ctx: CommandContext) {
				const canSend = ctx.member?.permissions.has(['SendMessages']) ?? false;
				await ctx.write({ content: canSend ? 'can-send' : 'timed-out' });
			}
		}

		const bot = await createMockBot({
			commands: [CanSpeak],
			world,
			timers: { advance: ms => void vi.advanceTimersByTime(ms) },
		});
		await expect(bot.slash({ name: 'can-speak', guildId: guild.id, channel, user: muted.user })).resolves.toMatchObject(
			{
				content: 'timed-out',
			},
		);

		await bot.advanceTime(60_001);
		await expect(bot.slash({ name: 'can-speak', guildId: guild.id, channel, user: muted.user })).resolves.toMatchObject(
			{
				content: 'can-send',
			},
		);
		await bot.close();
	});
});
