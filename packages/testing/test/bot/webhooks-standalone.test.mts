import { Command, type CommandContext, Declare } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { apiUser } from '../../src/bot/payloads';
import { mockWorld } from '../../src/bot/world';

describe('standalone webhooks', () => {
	test('create then fetch by id and token', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'wh-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'wh-actor' }) });
		const channel = world.registerChannel(guild.id, { id: 'wh-chan' });

		@Declare({ name: 'mk-webhook', description: 'creates and fetches a webhook' })
		class MkWebhook extends Command {
			async run(ctx: CommandContext) {
				const created = await ctx.client.webhooks.create(channel.id, { name: 'logs' });
				const fetched = await ctx.client.webhooks.fetch(created.id, created.token);
				await ctx.write({ content: `${created.id}:${fetched.name}` });
			}
		}

		const bot = await createMockBot({ commands: [MkWebhook], world });
		const res = await bot.slash({ name: 'mk-webhook', guildId: guild.id, channel, user: actor.user });
		expect(res.content).toBe('wh-wh-chan:logs');
		await bot.close();
	});

	test('fetch, edit and delete a seeded webhook', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'wh-edit-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'wh-edit-actor' }) });
		const channel = world.registerChannel(guild.id, { id: 'wh-edit-chan' });
		world.registerWebhook(channel.id, { id: 'real-wh', token: 'real-tok', name: 'old' });

		@Declare({ name: 'edit-webhook', description: 'edits then deletes a webhook' })
		class EditWebhook extends Command {
			async run(ctx: CommandContext) {
				const fetched = await ctx.client.webhooks.fetch('real-wh', 'real-tok');
				await ctx.client.webhooks.edit('real-wh', { name: 'new' }, { token: 'real-tok' });
				await ctx.write({ content: fetched.name ?? '' });
			}
		}

		const bot = await createMockBot({ commands: [EditWebhook], world });
		const res = await bot.slash({ name: 'edit-webhook', guildId: guild.id, channel, user: actor.user });
		expect(res.content).toBe('old');
		expect(bot.state.webhookById('real-wh')?.name).toBe('new');

		@Declare({ name: 'del-webhook', description: 'deletes a webhook' })
		class DelWebhook extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.webhooks.delete('real-wh', { token: 'real-tok' });
				await ctx.write({ content: 'gone' });
			}
		}
		const bot2 = await createMockBot({ commands: [DelWebhook], world });
		await bot2.slash({ name: 'del-webhook', guildId: guild.id, channel, user: actor.user });
		expect(bot2.state.webhookById('real-wh')).toBeUndefined();
		await bot.close();
		await bot2.close();
	});

	test('execute by real id and token lands the message in the channel, then edit and delete it', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'wh-exec-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'wh-exec-actor' }) });
		const channel = world.registerChannel(guild.id, { id: 'wh-exec-chan' });
		world.registerWebhook(channel.id, { id: 'exec-wh', token: 'exec-tok' });

		@Declare({ name: 'exec-webhook', description: 'executes a webhook' })
		class ExecWebhook extends Command {
			async run(ctx: CommandContext) {
				const message = await ctx.client.webhooks.writeMessage('exec-wh', 'exec-tok', {
					body: { embeds: [{ title: 'X' }] },
				});
				await ctx.client.webhooks.editMessage('exec-wh', 'exec-tok', {
					messageId: message?.id ?? '',
					body: { content: 'edited' },
				});
				await ctx.write({ content: message?.id ?? 'null' });
			}
		}

		const bot = await createMockBot({ commands: [ExecWebhook], world });
		const res = await bot.slash({ name: 'exec-webhook', guildId: guild.id, channel, user: actor.user });
		expect(res.content).not.toBe('null');
		const landed = bot
			.cachedGuild(guild.id)
			?.channel('wh-exec-chan')
			?.messages.find(message => (message.embeds[0] as { title?: string } | undefined)?.title === 'X');
		expect(landed?.embeds[0]).toMatchObject({ title: 'X' });
		expect(landed?.content).toBe('edited');
		await bot.close();
	});

	test('listFromGuild returns the guild webhooks', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'wh-list-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'wh-list-actor' }) });
		const channel = world.registerChannel(guild.id, { id: 'wh-list-chan' });
		world.registerWebhook(channel.id, { id: 'guild-wh', name: 'audit' });

		@Declare({ name: 'list-webhooks', description: 'lists guild webhooks' })
		class ListWebhooks extends Command {
			async run(ctx: CommandContext) {
				const list = await ctx.client.webhooks.listFromGuild(ctx.guildId ?? '');
				await ctx.write({ content: list.map(webhook => webhook.id).join(',') });
			}
		}

		const bot = await createMockBot({ commands: [ListWebhooks], world });
		const res = await bot.slash({ name: 'list-webhooks', guildId: guild.id, channel, user: actor.user });
		expect(res.content).toBe('guild-wh');
		await bot.close();
	});
});
