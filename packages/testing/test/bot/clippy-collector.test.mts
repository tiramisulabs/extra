import { ActionRow, Button, Command, type CommandContext, Declare } from 'seyfert';
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
});
