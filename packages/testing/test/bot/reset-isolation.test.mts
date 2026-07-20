import { Command, type CommandContext, ComponentCommand, type ComponentContext, Declare, Modal } from 'seyfert';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { apiUser } from '../../src/bot/payloads';

class OpenModalButton extends ComponentCommand {
	componentType = 'Button' as const;
	filter(ctx: ComponentContext<'Button'>) {
		return ctx.customId === 'open';
	}
	async run(ctx: ComponentContext<'Button'>) {
		await ctx.interaction.modal(new Modal().setCustomId('feedback').setTitle('Feedback').setComponents([]), {
			waitFor: 60_000,
		});
	}
}

describe('reset() isolation (F26)', () => {
	afterEach(() => vi.useRealTimers());

	test('reset() clears the modal registry so a later submitModal cannot run a stale callback', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const bot = await createMockBot({
			components: [OpenModalButton],
			timers: {
				advance: ms => {
					vi.advanceTimersByTime(ms);
				},
			},
		});
		const user = apiUser({ id: 'reset-user' });

		const dispatch = bot.dispatch.clickButton('open', { user, allowSyntheticSource: true });
		await dispatch.untilModal(); // a modal is now registered for reset-user

		await bot.reset();
		expect(vi.getTimerCount()).toBe(0);

		// Registry cleared: no modal waits for the user and no ModalCommand is registered, so filling throws
		// instead of silently running the stale 'feedback' callback for an unrelated custom_id.
		expect(() => bot.dispatch.submitModal('totally-unrelated', {}, { user })).toThrow(/no modal/i);

		// reset resolves the suspended opener through the same null branch and cancels its timer.
		await dispatch;
		await bot.close();
	});

	test('reset rejects while a non-input dispatch is still running', async () => {
		let release!: () => void;
		const held = new Promise<void>(resolve => {
			release = resolve;
		});
		let entered!: () => void;
		const started = new Promise<void>(resolve => {
			entered = resolve;
		});

		@Declare({ name: 'held-reset', description: 'Stays active across a reset attempt' })
		class HeldReset extends Command {
			async run(ctx: CommandContext) {
				entered();
				await held;
				await ctx.write({ content: 'released' });
			}
		}

		const bot = await createMockBot({ commands: [HeldReset] });
		const execution = Promise.resolve(bot.dispatch.slash({ name: 'held-reset' }));
		await started;

		await expect(bot.reset()).rejects.toThrow(/non-input dispatches are still running/);
		await expect(bot.close()).rejects.toThrow(/non-input dispatches are still running/);
		release();
		await execution;

		await bot.reset();
		expect(bot.actions).toHaveLength(0);
		await bot.close();
	});
});
