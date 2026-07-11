import { ActionRow, Button, Command, type CommandContext, Declare } from 'seyfert';
import { ButtonStyle, MessageFlags } from 'seyfert/lib/types';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';

// An IMMEDIATE (non-deferred) ctx.editOrReply(body, true) resolves to a real message — matching
// seyfert's Promise<WebhookMessageStructure> type — so a collector can attach to it directly.
describe('immediate reply withResponse', () => {
	test('editOrReply(body, true) returns a real message', async () => {
		let id: string | undefined;
		let content: string | undefined;

		@Declare({ name: 'now', description: 'Immediate reply' })
		class NowCommand extends Command {
			async run(ctx: CommandContext) {
				const message = await ctx.editOrReply({ content: 'hi' }, true);
				id = message.id;
				content = message.content;
			}
		}

		const bot = await createMockBot({ commands: [NowCommand] });
		const res = await bot.slash({ name: 'now' });
		expect(typeof id).toBe('string');
		expect(content).toBe('hi');
		expect(res.messages[0]?.content).toBe('hi');
		await bot.close();
	});

	test('collector on an immediate reply resolves clickButton without an explicit source', async () => {
		const clicked: string[] = [];

		@Declare({ name: 'confirm', description: 'Immediate confirm' })
		class ConfirmCommand extends Command {
			async run(ctx: CommandContext) {
				const row = new ActionRow<Button>().setComponents([
					new Button().setCustomId('do-confirm').setLabel('Confirm').setStyle(ButtonStyle.Success),
				]);
				const message = await ctx.editOrReply({ content: 'Confirm?', components: [row] }, true);
				message.createComponentCollector().run('do-confirm', async interaction => {
					clicked.push(interaction.customId);
					await interaction.write({ content: 'confirmed' });
				});
			}
		}

		const bot = await createMockBot({ commands: [ConfirmCommand] });
		await bot.slash({ name: 'confirm' });
		const res = await bot.clickButton('do-confirm');
		expect(clicked).toEqual(['do-confirm']);
		expect(res.content).toBe('confirmed');
		await bot.close();
	});

	test('returned message carries embeds, and the reply is ephemeral', async () => {
		let embedCount = 0;

		@Declare({ name: 'rich', description: 'Ephemeral + embed' })
		class RichCommand extends Command {
			async run(ctx: CommandContext) {
				const message = await ctx.editOrReply(
					{ content: 'x', embeds: [{ title: 'T' }], flags: MessageFlags.Ephemeral },
					true,
				);
				embedCount = message.embeds.length;
			}
		}

		const bot = await createMockBot({ commands: [RichCommand] });
		const res = await bot.slash({ name: 'rich' });
		expect(embedCount).toBe(1);
		expect(res.ephemeral).toBe(true);
		await bot.close();
	});
});
