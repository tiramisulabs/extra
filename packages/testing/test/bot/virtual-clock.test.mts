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
		test('resolves the instant a modal is registered, then fillModal completes', async () => {
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

			const dispatch = bot.clickButton('open-feedback', { user });
			await dispatch.untilModal();
			const modal = await bot.fillModal('feedback-modal', { rating: '5' }, { user });
			await dispatch;

			expect(submitted).toEqual(['777']);
			expect(modal.reply?.body).toMatchObject({ data: { content: 'thanks' } });
			await bot.close();
		});

		test('dispatch.fillModal(...) runs the whole opener→submit→settle flow in one call', async () => {
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

			const modal = await bot.clickButton('open-feedback', { user }).fillModal('feedback-modal', { rating: '5' });

			expect(submitted).toEqual(['888']);
			expect(modal.reply?.body).toMatchObject({ data: { content: 'thanks' } });
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

			await bot.clickButton('open-feedback', { user }).timeoutModal();

			expect(outcomes).toEqual(['timed-out']);
			await bot.close();
		});

		test('fillModal before the opener ran names the opener, not the user', async () => {
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
			bot.clickButton('open-feedback', { user }); // created but never stepped/awaited

			expect(() => bot.fillModal('feedback-modal', { rating: '5' }, { user })).toThrow(/opener has not run/);
			await bot.close();
		});

		test('awaiting a modal-opener directly fails loud instead of stalling on the waitFor timer', async () => {
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

			// Directly awaiting the opener (no untilModal/fillModal) would, in real seyfert, block 30s on the
			// real-clock waitFor and silently take the timeout branch. The mock fails loud immediately instead.
			await expect(bot.clickButton('open-stall', { user })).rejects.toThrow(/awaited directly/);
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
			const dispatch = bot.slash({ name: 'noop' });

			await expect(dispatch.untilModal()).rejects.toThrow(/dispatch completed without opening a modal for user/);
			await bot.close();
		});
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

		const dispatch = bot.clickButton('open-waitfor', { user });
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
});
