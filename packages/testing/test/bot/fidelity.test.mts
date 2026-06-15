import {
	ActionRow,
	Button,
	Command,
	type CommandContext,
	ComponentCommand,
	type ComponentContext,
	Declare,
} from 'seyfert';
import { ButtonStyle } from 'seyfert/lib/types';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { apiUser } from '../../src/bot/payloads';
import { mockWorld } from '../../src/bot/world';

describe('fidelity fixes', () => {
	test('S13: stored messages derive mentions, mention_roles, and mention_everyone from content', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'mention-guild' });
		const channel = world.registerChannel(guild.id, { id: 'mention-chan' });
		const mentioned = world.registerUser({ id: '123', username: 'mentioned' });
		const bot = await createMockBot({ world });

		await bot.emitEvent('MESSAGE_CREATE', {
			id: 'mention-msg',
			channel_id: channel.id,
			author: apiUser({ id: 'author' }),
			content: '<@123> and <@&456> and @everyone',
		});

		const raw = bot.state.rawMessage(channel.id, 'mention-msg');
		expect(raw).toBeDefined();
		const mentions = raw?.mentions as { id: string; username: string }[];
		expect(mentions.map(user => user.id)).toContain('123');
		expect(mentions.find(user => user.id === '123')?.username).toBe(mentioned.username);
		expect(raw?.mention_roles).toContain('456');
		expect(raw?.mention_everyone).toBe(true);

		// allowed_mentions.parse suppresses categories absent from the allowlist.
		await bot.emitEvent('MESSAGE_CREATE', {
			id: 'limited-msg',
			channel_id: channel.id,
			author: apiUser({ id: 'author' }),
			content: '<@123> and <@&456> and @everyone',
			allowed_mentions: { parse: ['users'] },
		});
		const limited = bot.state.rawMessage(channel.id, 'limited-msg');
		expect((limited?.mentions as { id: string }[]).map(user => user.id)).toEqual(['123']);
		expect(limited?.mention_roles).toEqual([]);
		expect(limited?.mention_everyone).toBe(false);
		await bot.close();
	});

	test('S14a: component source message is hydrated from state, not an empty synthetic', async () => {
		const seenComponents: unknown[][] = [];

		@Declare({ name: 'panel', description: 'Posts a panel with a button' })
		class PanelCommand extends Command {
			async run(ctx: CommandContext) {
				const row = new ActionRow().setComponents([
					new Button().setCustomId('panel/edit').setLabel('Edit').setStyle(ButtonStyle.Primary),
				]);
				await ctx.write({ content: 'Panel body', components: [row] });
			}
		}

		class PanelEditButton extends ComponentCommand {
			componentType = 'Button' as const;
			filter(ctx: ComponentContext<'Button'>) {
				return ctx.customId === 'panel/edit';
			}
			async run(ctx: ComponentContext<'Button'>) {
				seenComponents.push(ctx.interaction.message.components as unknown[]);
				await ctx.write({ content: 'edited' });
			}
		}

		const bot = await createMockBot({ commands: [PanelCommand], components: [PanelEditButton] });
		const sent = await bot.slash({ name: 'panel' });
		const source = sent.actions.find(action => action.route.includes('/callback'));
		await bot.clickButton('panel/edit', { source });

		expect(seenComponents).toHaveLength(1);
		expect(seenComponents[0]).not.toEqual([]);
		expect(seenComponents[0].length).toBeGreaterThan(0);
		await bot.close();
	});

	test('S14b: deferredReply and deferredUpdate distinguish type 5 from type 6', async () => {
		@Declare({ name: 'defer-reply', description: 'Defers a reply' })
		class DeferReplyCommand extends Command {
			async run(ctx: CommandContext) {
				await ctx.deferReply();
			}
		}

		class DeferUpdateButton extends ComponentCommand {
			componentType = 'Button' as const;
			filter(ctx: ComponentContext<'Button'>) {
				return ctx.customId === 'ack';
			}
			async run(ctx: ComponentContext<'Button'>) {
				await ctx.deferUpdate();
			}
		}

		const bot = await createMockBot({ commands: [DeferReplyCommand], components: [DeferUpdateButton] });

		const replyResult = await bot.slash({ name: 'defer-reply' });
		expect(replyResult.deferred).toBe(true);
		expect(replyResult.deferredReply).toBe(true);
		expect(replyResult.deferredUpdate).toBe(false);

		const updateResult = await bot.clickButton('ack');
		expect(updateResult.deferred).toBe(true);
		expect(updateResult.deferredUpdate).toBe(true);
		expect(updateResult.deferredReply).toBe(false);
		await bot.close();
	});
});
