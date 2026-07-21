import {
	Command,
	type CommandContext,
	Declare,
	FileUpload,
	Label,
	Modal,
	StringSelectMenu,
	StringSelectOption,
	TextInput,
} from 'seyfert';
import { MessageFlags, TextInputStyle } from 'seyfert/lib/types';
import { describe, expect, test } from 'vitest';
import { createMockBot, type RecordedAction, RenderedOutputError, rendered } from '../../src';

function catchRenderedOutputError(run: () => unknown): RenderedOutputError {
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(RenderedOutputError);
		return error as RenderedOutputError;
	}
	throw new Error('Expected RenderedOutputError.');
}

describe('rendered reader', () => {
	test('get/query/all apply cardinality and message scopes resolve duplicate controls', () => {
		const ui = rendered([
			{
				content: 'Profile',
				components: [{ type: 1, components: [{ type: 2, style: 1, custom_id: 'edit', label: 'Edit' }] }],
			},
			{
				content: 'Settings',
				components: [{ type: 1, components: [{ type: 2, style: 1, custom_id: 'edit', label: 'Edit' }] }],
			},
		]);

		expect(ui.query.button('missing')).toBeUndefined();
		expect(ui.query.button('edit')?.label).toBe('Edit');
		expect(ui.all.button('edit')).toHaveLength(2);
		expect(() => ui.get.button('edit')).toThrow(RenderedOutputError);
		expect(() => ui.get.button('edit')).toThrow(/found 2 buttons/);
		expect(() => ui.get.button('edit')).toThrow(/all\.button/);

		const settings = ui.get.message({ content: 'Settings' });
		expect(settings.get.button('edit').label).toBe('Edit');
		expect(() => ui.get.button({ customID: 'edit' } as never)).toThrow(/unknown query key/);
	});

	test('missing message errors do not suggest Components V2 containers when content is absent', () => {
		const ui = rendered({ content: 'Ready' });
		const error = catchRenderedOutputError(() => ui.get.message({ content: /invalid-number/ }));

		expect(error.message).toContain('found 0 messages');
		expect(error.message).not.toContain('For Components V2 panels');
		expect(error.message).not.toContain('get.container({ content: /.../ })');
	});

	test('component misses do not append a generic Components V2 container hint', () => {
		const ui = rendered({
			flags: MessageFlags.IsComponentsV2,
			components: [{ type: 17, components: [{ type: 10, content: 'Settings' }] }],
		});
		const error = catchRenderedOutputError(() => ui.get.embed({ title: /Missing/ }));

		expect(error.message).toContain('found 0 embeds');
		expect(error.message).not.toContain('For Components V2 panels');
		expect(error.message).not.toContain('get.container({ content: /.../ })');
	});

	test('message content stays separate from Components V2 container content', () => {
		const ui = rendered({
			flags: MessageFlags.IsComponentsV2,
			components: [
				{
					type: 17,
					accent_color: 0x00aa88,
					components: [
						{ type: 10, content: 'Settings' },
						{
							type: 9,
							components: [{ type: 10, content: 'Danger zone' }],
							accessory: { type: 2, style: 4, custom_id: 'delete', label: 'Delete' },
						},
						{
							type: 12,
							items: [
								{
									media: { url: 'attachment://preview.png', content_type: 'image/png' },
									description: 'Preview',
								},
							],
						},
						{
							type: 1,
							components: [
								{
									type: 3,
									custom_id: 'reason',
									placeholder: 'Reason',
									options: [{ label: 'Spam', value: 'spam' }],
								},
							],
						},
					],
				},
			],
		});

		const messageError = catchRenderedOutputError(() => ui.get.message({ content: /Settings/ }));
		expect(messageError.message).toContain('Container content matched');
		expect(messageError.message).not.toContain('If the Components V2 panel is the contract');
		expect(messageError.message).not.toContain('get.container');
		const panel = ui.get.container({ content: /Settings/, has: { kind: 'select', query: 'reason' } });
		expect(panel.accentColor).toBe(0x00aa88);
		expect(panel.get.content({ text: 'Settings' }).text).toBe('Settings');
		expect(panel.get.select('reason').options.map(option => option.value)).toEqual(['spam']);
		expect(panel.get.media({ url: /preview\.png$/ }).contentType).toBe('image/png');

		const danger = panel.get.section({ content: /Danger/ });
		expect(danger.get.button('delete').label).toBe('Delete');
		expect(danger.accessory().get.button('delete').label).toBe('Delete');
	});

	test('default view folds original-response edits into current message state', async () => {
		@Declare({ name: 'fold-rendered', description: 'edits the original response' })
		class FoldOutput extends Command {
			async run(ctx: CommandContext) {
				await ctx.deferReply();
				await ctx.editOrReply({ content: 'Loading' });
				await ctx.editOrReply({ content: 'Done' });
			}
		}

		const bot = await createMockBot({ commands: [FoldOutput] });
		const result = await bot.slash({ name: 'fold-rendered' });
		const ui = rendered(result);

		const message = ui.get.message({ content: 'Done' });
		expect(message.history).toHaveLength(2);
		expect(ui.query.message({ content: 'Loading' })).toBeUndefined();
		await bot.close();
	});

	test('raw flags remain available on rendered message views', async () => {
		@Declare({ name: 'raw-flags', description: 'sends v2 flags' })
		class RawFlags extends Command {
			async run(ctx: CommandContext) {
				await ctx.write({
					flags: MessageFlags.IsComponentsV2,
					components: [{ type: 17, components: [{ type: 10, content: 'Flags' }] }],
				});
			}
		}

		const bot = await createMockBot({ commands: [RawFlags] });
		const result = await bot.slash({ name: 'raw-flags' });
		const rawBody = rendered(result).get.message().raw.body as { flags?: number };
		expect(rawBody.flags).toBe(MessageFlags.IsComponentsV2);
		await bot.close();
	});

	test('raw interaction callback bodies normalize as messages or modals', () => {
		const message = rendered({
			type: 4,
			data: {
				content: 'Saved',
				components: [{ type: 1, components: [{ type: 2, style: 1, custom_id: 'save', label: 'Save' }] }],
			},
		}).get.message({ content: 'Saved' });
		expect(message.transport).toBe('reply');
		expect(rendered({ body: { type: 4, data: message.raw.body } }).get.button('save').label).toBe('Save');

		const modal = rendered({
			type: 9,
			data: {
				custom_id: 'raw-modal',
				title: 'Raw Modal',
				components: [
					{
						type: 18,
						label: 'Notes',
						component: { type: 4, custom_id: 'notes', required: true, style: TextInputStyle.Paragraph },
					},
				],
			},
		}).get.modal('raw-modal');
		expect(modal.get.input('notes').label).toBe('Notes');
	});

	test('current-state folding clears content and files when an edit explicitly clears them', () => {
		const actions = [
			{
				seq: 1,
				method: 'POST',
				route: '/interactions/interaction-1/token-1/callback',
				body: { type: 4, data: { content: 'Loading', attachments: [{ id: 'file-1' }] } },
				settled: true,
				response: {},
			},
			{
				seq: 2,
				method: 'PATCH',
				route: '/webhooks/app/token-1/messages/@original',
				body: { content: null, attachments: [] },
				settled: true,
				response: {},
			},
		] satisfies RecordedAction[];

		const message = rendered({ actions }).get.message();
		expect(message.content).toBeUndefined();
		expect(message.files).toEqual([]);
		expect(message.history).toHaveLength(2);
	});

	test('displayed modal components are readable without settling the opener', async () => {
		@Declare({ name: 'unrelated-rendered', description: 'adds an unrelated action' })
		class UnrelatedOutput extends Command {
			async run(ctx: CommandContext) {
				await ctx.write({ content: 'unrelated' });
			}
		}

		@Declare({ name: 'reject-flow', description: 'opens a modal' })
		class RejectFlow extends Command {
			async run(ctx: CommandContext) {
				const modal = new Modal()
					.setCustomId('reject-request')
					.setTitle('Reject request')
					.setComponents([
						new Label()
							.setLabel('Reason')
							.setComponent(
								new StringSelectMenu()
									.setCustomId('reason')
									.setOptions([new StringSelectOption().setLabel('Spam').setValue('spam')]),
							),
						new Label()
							.setLabel('Notes')
							.setDescription('Required context')
							.setComponent(new TextInput({ custom_id: 'notes', required: true, style: TextInputStyle.Paragraph })),
						new Label().setLabel('Evidence').setComponent(new FileUpload({ custom_id: 'evidence', required: false })),
					]);
				await ctx.interaction.modal(modal, { waitFor: 30_000 });
			}
		}

		const bot = await createMockBot({ commands: [UnrelatedOutput, RejectFlow] });
		await bot.slash({ name: 'unrelated-rendered' });
		await bot.slash({ name: 'reject-flow' });

		expect(rendered(bot).query.message({ content: 'unrelated' })).toBeUndefined();

		const ui = rendered(bot);
		const modal = ui.get.modal('reject-request');
		expect(modal.title).toBe('Reject request');
		expect(modal.get.select('reason').label).toBe('Reason');
		expect(modal.get.select('reason').options.map(option => option.value)).toEqual(['spam']);
		expect(modal.get.input('notes').label).toBe('Notes');
		expect(modal.get.input('notes').required).toBe(true);
		expect(modal.get.component('fileUpload', 'evidence').label).toBe('Evidence');
		expect(() => modal.get.input('missing')).toThrow(/Fields in modal "reject-request"/);
		expect(() => modal.get.input('missing')).toThrow(/input#notes label="Notes"/);

		await bot.close();
	});
});
