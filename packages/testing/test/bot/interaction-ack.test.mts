import { Command, type CommandContext, ComponentCommand, type ComponentContext, Declare } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { apiUser } from '../../src/bot/payloads';
import { DiscordErrors } from '../../src/bot/rest';
import { mockWorld } from '../../src/bot/world';
import { seedGuildFixture } from './_setup';

describe('interaction acknowledgement (fail loud before ack)', () => {
	test('followup() before any reply/defer is rejected', async () => {
		const { world, guild, actor, channel } = seedGuildFixture('fu');
		@Declare({ name: 'fu', description: 'followup with no prior reply' })
		class FollowupFirst extends Command {
			async run(ctx: CommandContext) {
				await ctx.followup({ content: 'oops' });
			}
		}
		const bot = await createMockBot({ commands: [FollowupFirst], world });
		await expect(bot.slash({ name: 'fu', guildId: guild.id, channel, user: actor.user })).rejects.toThrow(
			/unknown webhook|404|already/i,
		);
		await bot.close();
	});

	test('a second callback on an already-acknowledged token is 40060 (not a duplicate message)', async () => {
		const { world, guild, actor, channel } = seedGuildFixture('dbl');
		@Declare({ name: 'dbl', description: 'acks twice via the raw callback route' })
		class DoubleAck extends Command {
			async run(ctx: CommandContext) {
				const id = ctx.interaction.id;
				const token = ctx.interaction.token;
				await ctx.client.proxy
					.interactions(id)(token)
					.callback.post({ body: { type: 4, data: { content: 'one' } } });
				await ctx.client.proxy
					.interactions(id)(token)
					.callback.post({ body: { type: 4, data: { content: 'two' } } });
			}
		}
		const bot = await createMockBot({ commands: [DoubleAck], world });
		await expect(bot.slash({ name: 'dbl', guildId: guild.id, channel, user: actor.user })).rejects.toMatchObject({
			status: 400,
			code: 40060,
		});
		// only the first reply materialized — no phantom second message
		expect(bot.worldChannel(channel.id)?.messages.map(m => m.content)).toEqual(['one']);
		await bot.close();
	});

	test('editResponse() before any reply/defer is rejected', async () => {
		const { world, guild, actor, channel } = seedGuildFixture('ed');
		@Declare({ name: 'ed', description: 'edit @original with no prior reply' })
		class EditFirst extends Command {
			async run(ctx: CommandContext) {
				await ctx.editResponse({ content: 'oops' });
			}
		}
		const bot = await createMockBot({ commands: [EditFirst], world });
		await expect(bot.slash({ name: 'ed', guildId: guild.id, channel, user: actor.user })).rejects.toThrow(
			/unknown message|404|already/i,
		);
		await bot.close();
	});

	test('unknown interaction webhook followup messages cannot be edited or deleted', async () => {
		const bot = await createMockBot();

		await expect(
			bot.rest.request('PATCH', '/webhooks/app/ghost-token/messages/followup-id', { body: { content: 'x' } }),
		).rejects.toMatchObject({ code: DiscordErrors.UnknownWebhook.code });
		await expect(bot.rest.request('DELETE', '/webhooks/app/ghost-token/messages/followup-id')).rejects.toMatchObject({
			code: DiscordErrors.UnknownWebhook.code,
		});
		await bot.close();
	});

	test('deferUpdate then editResponse edits the source message in place (no new message)', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'du-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'du-actor' }) });
		const channel = world.registerChannel(guild.id, { id: 'du-chan' });
		world.registerMessage(channel.id, {
			id: 'src-msg',
			content: 'page 1',
			components: [{ type: 1, components: [{ type: 2, style: 1, label: 'Next', custom_id: 'next' }] }],
		});

		class NextButton extends ComponentCommand {
			componentType = 'Button' as const;
			filter(ctx: ComponentContext<'Button'>) {
				return ctx.customId === 'next';
			}
			async run(ctx: ComponentContext<'Button'>) {
				await ctx.deferUpdate();
				await ctx.editResponse({ content: 'page 2' });
			}
		}

		const bot = await createMockBot({ components: [NextButton], world });
		const before = bot.worldGuild(guild.id)?.channel('du-chan')?.messages.length ?? 0;
		await bot.clickButton('next', { source: 'src-msg', user: actor.user });
		const after = bot.worldGuild(guild.id)?.channel('du-chan')?.messages ?? [];
		expect(after).toHaveLength(before); // edited in place, no new message minted
		expect(bot.worldMessage(channel.id, 'src-msg')?.content).toBe('page 2');
		await bot.close();
	});

	test('update() then editResponse edits the source message in place (no phantom message)', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'up-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'up-actor' }) });
		const channel = world.registerChannel(guild.id, { id: 'up-chan' });
		world.registerMessage(channel.id, {
			id: 'up-src',
			content: 'page 1',
			components: [{ type: 1, components: [{ type: 2, style: 1, label: 'Next', custom_id: 'go' }] }],
		});

		class GoButton extends ComponentCommand {
			componentType = 'Button' as const;
			filter(ctx: ComponentContext<'Button'>) {
				return ctx.customId === 'go';
			}
			async run(ctx: ComponentContext<'Button'>) {
				await ctx.update({ content: 'page 2' });
				await ctx.editResponse({ content: 'page 3' });
			}
		}

		const bot = await createMockBot({ components: [GoButton], world });
		const before = bot.worldChannel('up-chan')?.messages.length ?? 0;
		await bot.clickButton('go', { source: 'up-src', user: actor.user });
		const after = bot.worldChannel('up-chan')?.messages ?? [];
		expect(after).toHaveLength(before); // no phantom message minted by the trailing editResponse
		expect(bot.worldMessage(channel.id, 'up-src')?.content).toBe('page 3');
		await bot.close();
	});
});
