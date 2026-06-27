import {
	ActionRow,
	Button,
	Command,
	type CommandContext,
	Declare,
	FileUpload,
	Label,
	Modal,
	ModalCommand,
	type ModalContext,
	TextInput,
} from 'seyfert';
import { ButtonStyle, TextInputStyle } from 'seyfert/lib/types';
import { describe, expect, test } from 'vitest';
import { expectComponent, expectEmbed } from '../../src';
import { createMockBot } from '../../src/bot/bot';
import { apiAttachment } from '../../src/bot/payloads';
import { mockWorld } from '../../src/bot/world';

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

	// fillModal fills a FileUpload input with attachments, so the handler's interaction.getFiles(customId) (and any
	// content-type validation) sees them — not just text inputs.
	test('fillModal fills a FileUpload input so getFiles sees the attachments', async () => {
		const seen: string[] = [];

		@Declare({ name: 'upload', description: 'Upload flow with a file input' })
		class UploadCommand extends Command {
			async run(ctx: CommandContext) {
				const modal = new Modal()
					.setCustomId('upload-modal')
					.setTitle('Upload')
					.setComponents([
						new Label()
							.setLabel('Note')
							.setComponent(new TextInput({ custom_id: 'note', style: TextInputStyle.Short })),
						new Label().setLabel('File').setComponent(new FileUpload({ custom_id: 'attachment' })),
					]);
				const submit = await ctx.interaction.modal(modal, { waitFor: 30_000 });
				if (!submit) return;
				const files = submit.getFiles('attachment') ?? [];
				seen.push(files.map(f => f.filename).join(','));
				await submit.write({ content: `note:${submit.getInputValue('note')} files:${files.length}` });
			}
		}

		const bot = await createMockBot({ commands: [UploadCommand] });
		const res = await bot.slash({ name: 'upload' }).fillModal('upload-modal', {
			note: 'hello',
			attachment: [apiAttachment({ filename: 'evidence.pdf', contentType: 'application/pdf' })],
		});

		expect(res.content).toBe('note:hello files:1');
		expect(seen[0]).toContain('evidence.pdf');
		await bot.close();
	});

	// A collector that lives in a DM (the command DMs the author, then collects). Register the author as a world
	// user so the DM channel opens; then untilComponent sees the DM message's button and clickButton drives it.
	test('a collector on a DM is driveable once the recipient is a registered world user', async () => {
		const events: string[] = [];

		@Declare({ name: 'massdm', description: 'DM the author with a confirm button' })
		class MassDmCommand extends Command {
			async run(ctx: CommandContext) {
				const row = new ActionRow<Button>().setComponents([
					new Button().setCustomId('confirm-mass-dm').setLabel('Confirm').setStyle(ButtonStyle.Primary),
				]);
				const dm = await ctx.author.write({ content: 'Confirm the mass DM?', components: [row] });
				dm.createComponentCollector().run('confirm-mass-dm', async i => {
					events.push('confirmed');
					await i.write({ content: 'sent' });
				});
			}
		}

		const world = mockWorld();
		const guild = world.registerGuild({ id: 'g1' });
		const author = world.registerUser({ id: 'author-1' }); // so author.write can open the DM
		const bot = await createMockBot({ commands: [MassDmCommand], world });

		const flow = bot.slash({ name: 'massdm', guildId: guild.id, user: author });
		await flow.untilComponent('confirm-mass-dm'); // the DM button is visible across the dispatch's actions
		await bot.clickButton('confirm-mass-dm');
		await flow;

		expect(events).toEqual(['confirmed']);
		await bot.close();
	});

	test('a DM to an unregistered recipient fails with a directed error', async () => {
		@Declare({ name: 'dm-unknown', description: 'DM an unregistered user' })
		class DmUnknownCommand extends Command {
			async run(ctx: CommandContext) {
				await ctx.author.write({ content: 'hi' });
			}
		}
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'g1' });
		const bot = await createMockBot({ commands: [DmUnknownCommand], world });
		// default dispatch user isn't registered → createDm guides toward world.registerUser
		await expect(bot.slash({ name: 'dm-unknown', guildId: guild.id })).rejects.toThrow(/world\.registerUser/);
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

	// The bot-level accessors scan all recorded actions (unscoped), so a reply emitted inside a collector handler
	// is assertable via bot.lastEmbed()/expectEmbed(bot) — no reaching into raw bot.actions, and no need to pick
	// which dispatch (the flow or the click) captured it (a handler followup can record under neither).
	test('bot-level lastEmbed/expectEmbed see a reply emitted inside a collector handler', async () => {
		@Declare({ name: 'reopen', description: 'Confirm then reopen' })
		class ReopenCommand extends Command {
			async run(ctx: CommandContext) {
				const row = new ActionRow<Button>().setComponents([
					new Button().setCustomId('confirm').setLabel('Confirm').setStyle(ButtonStyle.Primary),
				]);
				const message = await ctx.write({ content: 'Confirm?', components: [row] }, true);
				message.createComponentCollector().run('confirm', async i => {
					await i.write({ embeds: [{ title: 'Reopened', description: 'has been reopened' }] });
				});
			}
		}

		const bot = await createMockBot({ commands: [ReopenCommand] });
		await bot.slash({ name: 'reopen' });
		await bot.clickButton('confirm');

		expect(bot.lastEmbed().title).toBe('Reopened');
		expectEmbed(bot, { contains: /reopened/ });
		await bot.close();
	});

	// Text counterpart of the embed accessor above: a reply written inside a collector handler records under no
	// dispatch, so the scoped `DispatchResult.content` misses it — bot.lastContent() (unscoped) sees it.
	test('bot-level lastContent sees text written inside a collector handler', async () => {
		@Declare({ name: 'ack', description: 'Confirm then acknowledge' })
		class AckCommand extends Command {
			async run(ctx: CommandContext) {
				const row = new ActionRow<Button>().setComponents([
					new Button().setCustomId('ack').setLabel('Ack').setStyle(ButtonStyle.Primary),
				]);
				const message = await ctx.write({ content: 'Confirm?', components: [row] }, true);
				message.createComponentCollector().run('ack', async i => {
					await i.write({ content: 'acknowledged' });
				});
			}
		}

		const bot = await createMockBot({ commands: [AckCommand] });
		await bot.slash({ name: 'ack' });
		await bot.clickButton('ack');

		expect(bot.lastContent()).toBe('acknowledged');
		await bot.close();
	});
});
