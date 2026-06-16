import { Command, type CommandContext, Declare } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { seedGuildFixture } from './_setup';

// F18: Discord rejects an UpdateMessage (type 7) / DeferredUpdate (type 6) callback on an application command
// interaction, and a Modal (type 9) callback on a modal submit. seyfert's typed ctx prevents these, so the
// runtime guard fires for raw callbacks — issue one through the REST proxy to exercise it.
@Declare({ name: 'badcb', description: 'posts a type-7 update callback from a slash command' })
class BadCallback extends Command {
	async run(ctx: CommandContext) {
		await ctx.client.proxy
			.interactions(ctx.interaction.id)(ctx.interaction.token)
			.callback.post({ body: { type: 7 } });
	}
}

describe('interaction callback type validation (F18)', () => {
	test('a type-7 update callback on a slash command is rejected', async () => {
		const { world, guild, actor, channel } = seedGuildFixture('cb');
		const bot = await createMockBot({ commands: [BadCallback], world });
		await expect(bot.slash({ name: 'badcb', guildId: guild.id, channel, user: actor.user })).rejects.toThrow(
			/message update callbacks are only valid for component or modal/,
		);
		await bot.close();
	});
});
