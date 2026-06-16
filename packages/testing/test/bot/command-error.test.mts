import { Command, type CommandContext, createEvent, Declare } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { apiMember, apiUser } from '../../src/bot/payloads';
import { mockWorld } from '../../src/bot/world';
import { seedGuildFixture } from './_setup';

@Declare({ name: 'twice', description: 'writes twice (a bug — should be editOrReply/followup)' })
class WritesTwice extends Command {
	async run(ctx: CommandContext) {
		await ctx.write({ content: 'first' });
		await ctx.write({ content: 'second' });
	}
}

describe('unhandled command errors', () => {
	test('a naive double ctx.write fails the dispatch loud by default', async () => {
		const { world, guild, actor, channel } = seedGuildFixture('err');
		const bot = await createMockBot({ commands: [WritesTwice], world });
		await expect(bot.slash({ name: 'twice', guildId: guild.id, channel, user: actor.user })).rejects.toThrow(
			/already replied/i,
		);
		await bot.close();
	});

	test('onCommandError: "capture" surfaces it on result.error instead of throwing', async () => {
		const { world, guild, actor, channel } = seedGuildFixture('errc');
		const bot = await createMockBot({ commands: [WritesTwice], world, onCommandError: 'capture' });
		const res = await bot.slash({ name: 'twice', guildId: guild.id, channel, user: actor.user });
		expect(res.error).toBeInstanceOf(Error);
		expect((res.error as Error).message).toMatch(/already replied/i);
		expect(res.content).toBe('first');
		await bot.close();
	});

	test('a throwing event handler fails the dispatch loud by default', async () => {
		const onJoin = createEvent({
			data: { name: 'guildMemberAdd' },
			run() {
				throw new Error('event boom');
			},
		});
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'ev-guild' });
		const bot = await createMockBot({ events: [onJoin], world });
		await expect(
			bot.emitEvent('GUILD_MEMBER_ADD', { guild_id: guild.id, ...apiMember({ user: apiUser() }) }),
		).rejects.toThrow(/event boom/);
		await bot.close();
	});
});
