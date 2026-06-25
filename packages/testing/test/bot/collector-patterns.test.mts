import {
	ActionRow,
	Button,
	Command,
	type CommandContext,
	Declare,
	Modal,
	ModalCommand,
	type ModalContext,
} from 'seyfert';
import { ButtonStyle } from 'seyfert/lib/types';
import { describe, expect, test } from 'vitest';
import { expectComponent } from '../../src';
import { createMockBot } from '../../src/bot/bot';

// A common real-world flow: defer -> editOrReply(fetchReply) -> collector on that message, with a DYNAMIC
// customId matched by regex (parameterized customIds are very common).
describe('collector patterns', () => {
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

	// A slash command opens a modal with `{ waitFor }`, awaits the submit, and replies on that submit
	// interaction (`editOrReply(body, true)`) IN THE SAME CONTINUATION, then a collector on that reply drives a
	// "Continue" button. This "collector behind a Continue button after a modal" flow works because the submit
	// reply's @original is materialized under its token, so clickButton resolves the source with no explicit
	// `source`. Regression lock.
	test('collector on a reply written in the modal-opener continuation is clickable', async () => {
		const done: string[] = [];

		@Declare({ name: 'setup', description: 'Open a modal then confirm' })
		class SetupCommand extends Command {
			async run(ctx: CommandContext) {
				const submit = await ctx.interaction.modal(
					new Modal().setCustomId('setup-modal').setTitle('Setup').setComponents([]),
					{ waitFor: 30_000 },
				);
				if (!submit) return;
				const row = new ActionRow<Button>().setComponents([
					new Button().setCustomId('setup-continue').setLabel('Continue').setStyle(ButtonStyle.Primary),
				]);
				const message = await submit.editOrReply({ content: 'Summary', components: [row] }, true);
				message.createComponentCollector().run('setup-continue', async i => {
					done.push('clicked');
					await i.write({ content: 'created channels' });
				});
			}
		}

		const bot = await createMockBot({ commands: [SetupCommand] });
		await bot.slash({ name: 'setup' }).fillModal('setup-modal', {});
		const res = await bot.clickButton('setup-continue');
		expect(done).toEqual(['clicked']);
		expect(res.reply?.body).toMatchObject({ data: { content: 'created channels' } });
		await bot.close();
	});

	// A click whose handler opens a SECOND collector parks on it — so awaiting the click directly would hang.
	// The click is a Dispatch, so it's parkable: untilComponent resolves when the nested component renders, while
	// the handler stays parked on the nested waitFor (events stays empty).
	test('a click that opens a nested collector is parkable with untilComponent', async () => {
		const events: string[] = [];

		@Declare({ name: 'wizard', description: 'Two-step nested collector flow' })
		class WizardCommand extends Command {
			async run(ctx: CommandContext) {
				const row = new ActionRow<Button>().setComponents([
					new Button().setCustomId('open').setLabel('Open').setStyle(ButtonStyle.Primary),
				]);
				const message = await ctx.write({ content: 'step 1', components: [row] }, true);
				message.createComponentCollector().run('open', async interaction => {
					const nested = new ActionRow<Button>().setComponents([
						new Button().setCustomId('confirm-nested').setLabel('Confirm').setStyle(ButtonStyle.Primary),
					]);
					const second = await interaction.write({ content: 'step 2', components: [nested] }, true);
					const nestedInteraction = await second.createComponentCollector().waitFor('confirm-nested');
					events.push(`done:${nestedInteraction?.customId ?? 'none'}`);
				});
			}
		}

		const bot = await createMockBot({ commands: [WizardCommand] });
		await bot.slash({ name: 'wizard' });

		// Awaiting the click directly would hang — its handler parks on the nested collector. untilComponent
		// resolves when the nested button renders, proving the click is parkable and the handler is still parked.
		const click = bot.clickButton('open');
		await click.untilComponent('confirm-nested');
		expect(events).toEqual([]);
		expectComponent(click, { customId: 'confirm-nested' });

		await bot.close();
	});
});
