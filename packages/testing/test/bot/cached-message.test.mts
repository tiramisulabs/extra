import { Command, type CommandContext, Declare } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { apiUser } from '../../src/bot/payloads';
import { mockWorld } from '../../src/bot/world';

describe('cachedMessage', () => {
	test('resolves a stored message view by channel and id', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'cm-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'cm-actor' }) });
		const channel = world.registerChannel(guild.id, { id: 'cm-chan' });

		@Declare({ name: 'post', description: 'writes a message' })
		class Post extends Command {
			async run(ctx: CommandContext) {
				const sent = await ctx.client.messages.write(channel.id, { content: 'hello' });
				await ctx.write({ content: sent.id });
			}
		}

		const bot = await createMockBot({ commands: [Post], world });
		const res = await bot.slash({ name: 'post', guildId: guild.id, channel, user: actor.user });
		const view = bot.cachedMessage(channel.id, res.content ?? '');
		expect(view?.content).toBe('hello');
		expect(bot.cachedMessage(channel.id, 'missing')).toBeUndefined();
		await bot.close();
	});
});
