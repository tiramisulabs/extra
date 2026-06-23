import { ActionRow, Button, Command, type CommandContext, Declare, ModalCommand, type ModalContext } from 'seyfert';
import { ButtonStyle } from 'seyfert/lib/types';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';

// Clippy's dominant flow: defer -> editOrReply(fetchReply) -> collector on that message,
// with a DYNAMIC customId matched by regex. (~69% of Clippy components use parameterized customIds.)
describe('Clippy collector patterns', () => {
	test('collector on a deferred reply matches a dynamic customId (regex, non-blocking run)', async () => {
		const launched: string[] = [];
		const id = 'camp_abc';

		@Declare({ name: 'launch', description: 'Launch flow' })
		class LaunchCommand extends Command {
			async run(ctx: CommandContext) {
				await ctx.deferReply();
				const row = new ActionRow<Button>().setComponents([
					new Button().setCustomId(`launch:${id}`).setLabel('Launch').setStyle(ButtonStyle.Primary),
				]);
				const message = await ctx.editOrReply({ content: 'Confirm?', components: [row] }, true);
				const collector = message.createComponentCollector();
				collector.run(/^launch:/, async interaction => {
					launched.push(interaction.customId);
					await interaction.write({ content: 'launched' });
				});
			}
		}

		const bot = await createMockBot({ commands: [LaunchCommand] });
		await bot.slash({ name: 'launch' });
		const res = await bot.clickButton(`launch:${id}`);
		expect(launched).toEqual([`launch:${id}`]);
		expect(res.reply?.body).toMatchObject({ data: { content: 'launched' } });
		await bot.close();
	});

	// A collector created on a MODAL-SUBMIT reply (a different interaction token than the opener) must be
	// clickable: the modal reply's @original is materialized under its token, so clickButton resolves the
	// source with no explicit `source`. Locks the "collector behind a Continue button after a modal" flow.
	// NOTE: the reply MUST use fetchReply (`editOrReply(body, true)`) — without it Seyfert returns void and
	// `.createComponentCollector()` throws (production-faithful), which is the usual cause of the wall.
	test('collector on a modal-submit reply is clickable without an explicit source', async () => {
		const done: string[] = [];

		class ConfirmModal extends ModalCommand {
			filter(ctx: ModalContext) {
				return ctx.customId === 'confirm-modal';
			}
			async run(ctx: ModalContext) {
				const row = new ActionRow<Button>().setComponents([
					new Button().setCustomId('continue').setLabel('Continue').setStyle(ButtonStyle.Primary),
				]);
				const message = await ctx.editOrReply({ content: 'Summary', components: [row] }, true);
				message.createComponentCollector().run('continue', async i => {
					done.push('clicked');
					await i.write({ content: 'created channels' });
				});
			}
		}

		const bot = await createMockBot({ components: [ConfirmModal] });
		await bot.fillModal('confirm-modal', { name: 'x' });
		const res = await bot.clickButton('continue');
		expect(done).toEqual(['clicked']);
		expect(res.reply?.body).toMatchObject({ data: { content: 'created channels' } });
		await bot.close();
	});
});
