import { Command, type CommandContext, Declare, MessageFlags } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { apiUser } from '../../src/bot/payloads';
import { mockWorld } from '../../src/bot/world';

describe('components v2 surfacing', () => {
	test('a v2 reply exposes its text displays, component types and buttons flat', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'cv2-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'cv2-actor' }) });
		const channel = world.registerChannel(guild.id, { id: 'cv2-chan' });

		@Declare({ name: 'panel', description: 'sends a components-v2 panel' })
		class Panel extends Command {
			async run(ctx: CommandContext) {
				await ctx.write({
					flags: MessageFlags.IsComponentsV2,
					components: [
						{ type: 17, components: [{ type: 10, content: 'Welcome!' }] },
						{ type: 1, components: [{ type: 2, style: 1, label: 'Click', custom_id: 'btn' }] },
					],
				});
			}
		}

		const bot = await createMockBot({ commands: [Panel], world });
		await bot.slash({ name: 'panel', guildId: guild.id, channel, user: actor.user });
		const view = bot.cachedGuild(guild.id)?.channel('cv2-chan')?.lastMessage;
		expect(view?.isComponentsV2).toBe(true);
		expect(view?.textDisplays).toContain('Welcome!');
		expect(view?.componentTypes).toEqual(expect.arrayContaining([17, 10, 1, 2]));
		expect(view?.button('Click')).toBeDefined();
		await bot.close();
	});

	test('a classic message reports isComponentsV2 false and no text displays', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'classic-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'classic-actor' }) });
		const channel = world.registerChannel(guild.id, { id: 'classic-chan' });

		@Declare({ name: 'say', description: 'plain reply' })
		class Say extends Command {
			async run(ctx: CommandContext) {
				await ctx.write({ content: 'hi' });
			}
		}

		const bot = await createMockBot({ commands: [Say], world });
		await bot.slash({ name: 'say', guildId: guild.id, channel, user: actor.user });
		const view = bot.cachedGuild(guild.id)?.channel('classic-chan')?.lastMessage;
		expect(view?.isComponentsV2).toBe(false);
		expect(view?.textDisplays).toEqual([]);
		await bot.close();
	});
});
