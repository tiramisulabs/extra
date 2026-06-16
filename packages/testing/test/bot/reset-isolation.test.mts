import { type ComponentContext, ComponentCommand, Modal } from 'seyfert';
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

	test('reset() clears the modal registry so a later fillModal cannot run a stale callback', async () => {
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

		const dispatch = bot.clickButton('open', { user });
		await dispatch.untilModal(); // a modal is now registered for reset-user

		bot.reset();

		// Registry cleared: no modal waits for the user and no ModalCommand is registered, so filling throws
		// instead of silently running the stale 'feedback' callback for an unrelated custom_id.
		expect(() => bot.fillModal('totally-unrelated', {}, { user })).toThrow(/no modal/i);

		// Settle the suspended opener (its waitFor still ticks on the fake clock) before closing.
		await bot.advanceTime(60_000);
		await dispatch;
		await bot.close();
	});
});
