import { Command, type CommandContext, Declare } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { seedGuildFixture } from './_setup';

describe('attachment:// reference reconciliation (F23)', () => {
	test('an embed referencing attachment:// with no uploaded file is rejected', async () => {
		const { world, guild, actor, channel } = seedGuildFixture('att');

		@Declare({ name: 'broken-image', description: 'references a file it never uploads' })
		class BrokenImage extends Command {
			async run(ctx: CommandContext) {
				await ctx.write({ embeds: [{ title: 'Logo', image: { url: 'attachment://logo.png' } }] });
			}
		}

		const bot = await createMockBot({ commands: [BrokenImage], world });
		await expect(bot.slash({ name: 'broken-image', guildId: guild.id, channel, user: actor.user })).rejects.toThrow(
			/attachment:\/\/logo\.png/,
		);
		await bot.close();
	});

	test('the same embed succeeds when the file is uploaded alongside it', async () => {
		const { world, guild, actor, channel } = seedGuildFixture('att-ok');

		@Declare({ name: 'good-image', description: 'uploads the referenced file' })
		class GoodImage extends Command {
			async run(ctx: CommandContext) {
				await ctx.write({
					embeds: [{ title: 'Logo', image: { url: 'attachment://logo.png' } }],
					files: [{ filename: 'logo.png', data: Buffer.from('png') }],
				});
			}
		}

		const bot = await createMockBot({ commands: [GoodImage], world });
		const result = await bot.slash({ name: 'good-image', guildId: guild.id, channel, user: actor.user });
		expect(result.embedView?.title).toBe('Logo');
		await bot.close();
	});

	test('literal attachment-looking strings outside media urls do not require uploaded files', async () => {
		const { world, guild, actor, channel } = seedGuildFixture('att-literal');

		@Declare({ name: 'literal-attachment-text', description: 'sends literal attachment-looking copy' })
		class LiteralAttachmentText extends Command {
			async run(ctx: CommandContext) {
				await ctx.write({
					content: 'Mention attachment://logo.png in copy',
					components: [
						{
							type: 1,
							components: [{ type: 2, style: 1, custom_id: 'literal', label: 'attachment://logo.png' }],
						},
					],
				});
			}
		}

		const bot = await createMockBot({ commands: [LiteralAttachmentText], world });
		await expect(
			bot.slash({ name: 'literal-attachment-text', guildId: guild.id, channel, user: actor.user }),
		).resolves.toMatchObject({ content: 'Mention attachment://logo.png in copy' });
		await bot.close();
	});
});
