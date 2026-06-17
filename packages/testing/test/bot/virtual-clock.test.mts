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

			const dispatch = bot.clickButton('open-feedback', { user, allowSyntheticSource: true });
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

			const modal = await bot
				.clickButton('open-feedback', { user, allowSyntheticSource: true })
				.fillModal('feedback-modal', { rating: '5' });

			expect(submitted).toEqual(['888']);
			expect(modal.reply?.body).toMatchObject({ data: { content: 'thanks' } });
			await bot.close();
		});

		test('dispatch.fillModal returns replies written after async opener continuation work', async () => {
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

			const modal = await bot
				.clickButton('open-async-feedback', { user, allowSyntheticSource: true })
				.fillModal('async-feedback-modal', { rating: '5' });

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

			await expect(
				bot.clickButton('open:first', { user, source }).fillModal('modal:first', { value: '1' }),
			).resolves.toMatchObject({ content: 'submitted:first' });
			await expect(
				bot.clickButton('open:second', { user, source }).fillModal('modal:second', { value: '2' }),
			).resolves.toMatchObject({ content: 'submitted:second' });
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

			await bot.clickButton('open-feedback', { user, allowSyntheticSource: true }).timeoutModal();

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
			bot.clickButton('open-feedback', { user, allowSyntheticSource: true }); // created but never stepped/awaited

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
			await expect(bot.clickButton('open-stall', { user, allowSyntheticSource: true })).rejects.toThrow(
				/awaited directly/,
			);
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

		const dispatch = bot.clickButton('open-waitfor', { user, allowSyntheticSource: true });
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
