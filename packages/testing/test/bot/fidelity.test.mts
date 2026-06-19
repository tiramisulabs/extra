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

		await bot.emit(
			'MESSAGE_CREATE',
			{
				id: 'mention-msg',
				channel_id: channel.id,
				author: apiUser({ id: 'author' }),
				content: '<@123> and <@&456> and @everyone',
			},
			{ allowNoHandler: true },
		);

		const raw = bot.world.rawMessage(channel.id, 'mention-msg');
		expect(raw).toBeDefined();
		const mentions = raw?.mentions as { id: string; username: string }[];
		expect(mentions.map(user => user.id)).toContain('123');
		expect(mentions.find(user => user.id === '123')?.username).toBe(mentioned.username);
		expect(raw?.mention_roles).toContain('456');
		expect(raw?.mention_everyone).toBe(true);

		// allowed_mentions.parse suppresses categories absent from the allowlist.
		await bot.emit(
			'MESSAGE_CREATE',
			{
				id: 'limited-msg',
				channel_id: channel.id,
				author: apiUser({ id: 'author' }),
				content: '<@123> and <@&456> and @everyone',
				allowed_mentions: { parse: ['users'] },
			},
			{ allowNoHandler: true },
		);
		const limited = bot.world.rawMessage(channel.id, 'limited-msg');
		expect((limited?.mentions as { id: string }[]).map(user => user.id)).toEqual(['123']);
		expect(limited?.mention_roles).toEqual([]);
		expect(limited?.mention_everyone).toBe(false);
		await bot.close();
	});

	test('editing a stored message updates edited_timestamp and recalculates mentions', async () => {
		const botId = 'edit-fidelity-bot';
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'edit-mention-guild' });
		const channel = world.registerChannel(guild.id, { id: 'edit-mention-chan' });
		const mentioned = world.registerUser({ id: '789', username: 'new-mentioned' });
		world.registerMessage(channel.id, {
			id: 'edit-mention-msg',
			author: apiUser({ id: botId, bot: true }),
			content: '<@123> and <@&456>',
		});

		const bot = await createMockBot({ botId, world });
		expect(bot.world.rawMessage(channel.id, 'edit-mention-msg')?.edited_timestamp).toBeNull();

		await bot.rest.request('PATCH', `/channels/${channel.id}/messages/edit-mention-msg`, {
			body: {
				content: '<@789> and @everyone',
				allowed_mentions: { parse: ['users', 'everyone'] },
			},
		});

		const raw = bot.world.rawMessage(channel.id, 'edit-mention-msg');
		const mentions = raw?.mentions as { id: string; username: string }[] | undefined;
		expect(raw?.edited_timestamp).toEqual(expect.any(String));
		expect(Date.parse(raw?.edited_timestamp ?? '')).toBeGreaterThan(Date.parse(raw?.timestamp ?? ''));
		expect(raw?.content).toBe('<@789> and @everyone');
		expect(mentions?.map(user => user.id)).toEqual(['789']);
		expect(mentions?.[0]?.username).toBe(mentioned.username);
		expect(raw?.mention_roles).toEqual([]);
		expect(raw?.mention_everyone).toBe(true);
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
		const source = (sent.messages[0] as { id?: string } | undefined)?.id;
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

		const updateResult = await bot.clickButton('ack', { allowSyntheticSource: true });
		expect(updateResult.deferred).toBe(true);
		expect(updateResult.deferredUpdate).toBe(true);
		expect(updateResult.deferredReply).toBe(false);
		await bot.close();
	});
});
