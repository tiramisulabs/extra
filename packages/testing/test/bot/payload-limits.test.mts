import { ActionRow, Button, Command, type CommandContext, Declare, MessageFlags, PollBuilder } from 'seyfert';
import { ButtonStyle } from 'seyfert/lib/types';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { TEST_BOT_ID } from '../../src/bot/constants';
import { apiUser } from '../../src/bot/payloads';
import { seedGuildFixture } from './_setup';

function botWith(run: (ctx: CommandContext, channelId: string) => Promise<unknown>) {
	return async () => {
		const { world, guild, actor, channel } = seedGuildFixture('lim');
		@Declare({ name: 'lim', description: 'exercises a payload limit' })
		class Lim extends Command {
			async run(ctx: CommandContext) {
				await run(ctx, channel.id);
				await ctx.write({ content: 'ok' });
			}
		}
		const bot = await createMockBot({ commands: [Lim], world });
		const dispatch = bot.slash({ name: 'lim', guildId: guild.id, channel, user: actor.user });
		return { dispatch, close: () => bot.close() };
	};
}

describe('outgoing message payload limits (fail loud)', () => {
	test('content over 2000 chars is rejected', async () => {
		const { dispatch, close } = await botWith((ctx, channelId) =>
			ctx.client.messages.write(channelId, { content: 'x'.repeat(2001) }),
		)();
		await expect(dispatch).rejects.toThrow(/2000 or fewer/);
		await close();
	});

	test('an empty message is rejected', async () => {
		const { dispatch, close } = await botWith((ctx, channelId) => ctx.client.messages.write(channelId, {}))();
		await expect(dispatch).rejects.toThrow(/empty message/i);
		await close();
	});

	test('more than 10 embeds is rejected', async () => {
		const { dispatch, close } = await botWith((ctx, channelId) =>
			ctx.client.messages.write(channelId, { embeds: Array.from({ length: 11 }, () => ({ title: 't' })) }),
		)();
		await expect(dispatch).rejects.toThrow(/10 embeds/);
		await close();
	});

	test('posting to a category channel is rejected', async () => {
		const { world, guild, actor, channel } = seedGuildFixture('cat');
		const category = world.registerChannel(guild.id, { id: 'a-category', type: 4 });
		@Declare({ name: 'cat', description: 'posts to a category' })
		class Cat extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.messages.write(category.id, { content: 'nope' });
				await ctx.write({ content: 'ok' });
			}
		}
		const bot = await createMockBot({ commands: [Cat], world });
		await expect(bot.slash({ name: 'cat', guildId: guild.id, channel, user: actor.user })).rejects.toThrow(
			/channel type/i,
		);
		await bot.close();
	});

	test('duplicate component custom_id is rejected (F5)', async () => {
		const { dispatch, close } = await botWith((ctx, channelId) => {
			const row = new ActionRow<Button>().setComponents([
				new Button().setCustomId('dup').setLabel('A').setStyle(ButtonStyle.Primary),
				new Button().setCustomId('dup').setLabel('B').setStyle(ButtonStyle.Primary),
			]);
			return ctx.client.messages.write(channelId, { content: 'x', components: [row] });
		})();
		await expect(dispatch).rejects.toThrow(/duplicate component custom_id/);
		await close();
	});

	test('IsComponentsV2 alongside content is rejected (F19)', async () => {
		const { dispatch, close } = await botWith((ctx, channelId) => {
			const row = new ActionRow<Button>().setComponents([
				new Button().setCustomId('ok').setLabel('A').setStyle(ButtonStyle.Primary),
			]);
			return ctx.client.messages.write(channelId, {
				content: 'not allowed',
				flags: MessageFlags.IsComponentsV2,
				components: [row],
			});
		})();
		await expect(dispatch).rejects.toThrow(/IsComponentsV2/);
		await close();
	});

	test('more than 3 stickers is rejected (F20)', async () => {
		// discord-api-types already caps sticker_ids at a 3-tuple, so the runtime guard only fires for raw
		// (`as any`) payloads — drive the create route directly to exercise it.
		const { world, channel } = seedGuildFixture('stk');
		const bot = await createMockBot({ world });
		await expect(
			bot.rest.request('POST', `/channels/${channel.id}/messages`, {
				body: { content: 'x', sticker_ids: ['1', '2', '3', '4'] },
			}),
		).rejects.toThrow(/3 stickers/);
		await bot.close();
	});

	test('more than 10 poll answers is rejected (F21)', async () => {
		const { dispatch, close } = await botWith((ctx, channelId) => {
			const poll = new PollBuilder()
				.setQuestion({ text: 'Pick' })
				.setAnswers(...Array.from({ length: 11 }, (_, i) => ({ text: `A${i}` })));
			return ctx.client.messages.write(channelId, { poll });
		})();
		await expect(dispatch).rejects.toThrow(/10 answers/);
		await close();
	});

	test('embed field value over 1024 is rejected', async () => {
		const { dispatch, close } = await botWith((ctx, channelId) =>
			ctx.client.messages.write(channelId, { embeds: [{ fields: [{ name: 'n', value: 'x'.repeat(1025) }] }] }),
		)();
		await expect(dispatch).rejects.toThrow(/field value must be between 1 and 1024/);
		await close();
	});

	test('embed footer text over 2048 is rejected', async () => {
		const { dispatch, close } = await botWith((ctx, channelId) =>
			ctx.client.messages.write(channelId, { embeds: [{ footer: { text: 'x'.repeat(2049) } }] }),
		)();
		await expect(dispatch).rejects.toThrow(/footer text must be 2048/);
		await close();
	});

	test('embed author name over 256 is rejected', async () => {
		const { dispatch, close } = await botWith((ctx, channelId) =>
			ctx.client.messages.write(channelId, { embeds: [{ author: { name: 'x'.repeat(257) } }] }),
		)();
		await expect(dispatch).rejects.toThrow(/author name must be 256/);
		await close();
	});

	test('combined embed length over 6000 is rejected', async () => {
		const { dispatch, close } = await botWith((ctx, channelId) =>
			ctx.client.messages.write(channelId, {
				embeds: [{ description: 'x'.repeat(4096) }, { description: 'y'.repeat(4096) }],
			}),
		)();
		await expect(dispatch).rejects.toThrow(/combined length of all embeds must be 6000/);
		await close();
	});

	test('embed color outside 0..0xFFFFFF is rejected', async () => {
		const { dispatch, close } = await botWith((ctx, channelId) =>
			ctx.client.messages.write(channelId, { embeds: [{ title: 't', color: 0x1000000 }] }),
		)();
		await expect(dispatch).rejects.toThrow(/color must be an integer/);
		await close();
	});

	test('embed url with a forbidden scheme is rejected', async () => {
		const { dispatch, close } = await botWith((ctx, channelId) =>
			ctx.client.messages.write(channelId, { embeds: [{ title: 't', url: 'javascript:alert(1)' }] }),
		)();
		await expect(dispatch).rejects.toThrow(/embed url is not a valid URL/);
		await close();
	});

	test('embed attachment:// image url is accepted when the file is uploaded', async () => {
		const { dispatch, close } = await botWith((ctx, channelId) =>
			ctx.client.messages.write(channelId, {
				embeds: [{ title: 't', image: { url: 'attachment://logo.png' } }],
				files: [{ filename: 'logo.png', data: Buffer.from('png') }],
			}),
		)();
		await expect(dispatch).resolves.toBeDefined();
		await close();
	});

	test('editing a channel name over 100 chars is rejected (F22)', async () => {
		const { world, guild, actor, channel } = seedGuildFixture('cn');
		@Declare({ name: 'cn', description: 'renames a channel too long' })
		class Cn extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.channels.edit(channel.id, { name: 'x'.repeat(101) }, { guildId: ctx.guildId });
				await ctx.write({ content: 'ok' });
			}
		}
		const bot = await createMockBot({ commands: [Cn], world });
		await expect(bot.slash({ name: 'cn', guildId: guild.id, channel, user: actor.user })).rejects.toThrow(
			/channel name must be between 1 and 100/,
		);
		await bot.close();
	});

	// Component structural validation — driven via the raw create route (the typed body would block most shapes).
	const postBody = async (body: Record<string, unknown>) => {
		const { world, channel } = seedGuildFixture('cmp');
		const bot = await createMockBot({ world });
		const send = bot.rest.request('POST', `/channels/${channel.id}/messages`, { body });
		return { send, close: () => bot.close() };
	};
	const button = (extra: Record<string, unknown>) => ({ type: 2, style: 1, ...extra });
	const row = (...children: unknown[]) => ({ type: 1, components: children });

	test('an empty action row is rejected', async () => {
		const { send, close } = await postBody({ components: [row()] });
		await expect(send).rejects.toThrow(/action row must contain a component/);
		await close();
	});

	test('a button label over 80 chars is rejected', async () => {
		const { send, close } = await postBody({ components: [row(button({ custom_id: 'b', label: 'x'.repeat(81) }))] });
		await expect(send).rejects.toThrow(/button label must be 80/);
		await close();
	});

	test('a select option label over 100 chars is rejected', async () => {
		const { send, close } = await postBody({
			components: [row({ type: 3, custom_id: 's', options: [{ label: 'x'.repeat(101), value: 'v' }] })],
		});
		await expect(send).rejects.toThrow(/select option label must be between 1 and 100/);
		await close();
	});

	test('more than 5 action rows is rejected', async () => {
		const { send, close } = await postBody({
			components: Array.from({ length: 6 }, (_, i) => row(button({ custom_id: `b${i}`, label: 'x' }))),
		});
		await expect(send).rejects.toThrow(/at most 5 action rows/);
		await close();
	});

	test('a row mixing a button and a select is rejected', async () => {
		const { send, close } = await postBody({
			components: [
				row(button({ custom_id: 'b', label: 'x' }), { type: 3, custom_id: 's', options: [{ label: 'a', value: 'a' }] }),
			],
		});
		await expect(send).rejects.toThrow(/cannot mix buttons and a select/);
		await close();
	});

	test('an interactive button with no custom_id is rejected', async () => {
		const { send, close } = await postBody({ components: [row(button({ label: 'no id' }))] });
		await expect(send).rejects.toThrow(/requires a non-empty custom_id/);
		await close();
	});

	test('a link button (no custom_id, has url) is accepted', async () => {
		const { send, close } = await postBody({
			components: [row({ type: 2, style: 5, label: 'Open', url: 'https://example.com' })],
		});
		await expect(send).resolves.toBeDefined();
		await close();
	});

	test('a link button without url is rejected', async () => {
		const { send, close } = await postBody({
			components: [row({ type: 2, style: 5, label: 'Open' })],
		});
		await expect(send).rejects.toThrow(/link button requires a url/);
		await close();
	});

	test('a link button with custom_id is rejected', async () => {
		const { send, close } = await postBody({
			components: [row({ type: 2, style: 5, label: 'Open', url: 'https://example.com', custom_id: 'open' })],
		});
		await expect(send).rejects.toThrow(/link button cannot have custom_id/);
		await close();
	});

	test('a non-link button with url is rejected', async () => {
		const { send, close } = await postBody({
			components: [row(button({ custom_id: 'open', label: 'Open', url: 'https://example.com' }))],
		});
		await expect(send).rejects.toThrow(/non-link buttons cannot have url/);
		await close();
	});

	test('whitespace-only content is rejected as empty', async () => {
		const { dispatch, close } = await botWith((ctx, channelId) =>
			ctx.client.messages.write(channelId, { content: '   \n  ' }),
		)();
		await expect(dispatch).rejects.toThrow(/empty message/i);
		await close();
	});

	test('a Components-V2 action row with 6 buttons is still rejected (per-row cap holds in v2)', async () => {
		const { send, close } = await postBody({
			flags: 32768,
			components: [row(...Array.from({ length: 6 }, (_, i) => button({ custom_id: `b${i}`, label: 'x' })))],
		});
		await expect(send).rejects.toThrow(/at most 5 buttons/);
		await close();
	});

	test('a string select whose max_values exceeds its option count is rejected', async () => {
		const { send, close } = await postBody({
			components: [row({ type: 3, custom_id: 's', max_values: 5, options: [{ label: 'a', value: 'a' }] })],
		});
		await expect(send).rejects.toThrow(/max_values cannot exceed the number of options/);
		await close();
	});

	test('a string select whose min_values exceeds its option count is rejected', async () => {
		const { send, close } = await postBody({
			components: [row({ type: 3, custom_id: 's', min_values: 2, options: [{ label: 'a', value: 'a' }] })],
		});
		await expect(send).rejects.toThrow(/min_values cannot exceed the number of options/);
		await close();
	});

	test('an embed footer icon with no footer text is rejected', async () => {
		const { send, close } = await postBody({
			embeds: [{ description: 'hi', footer: { icon_url: 'https://x/y.png' } }],
		});
		await expect(send).rejects.toThrow(/footer\.text is required/);
		await close();
	});

	test('an embed author icon with no author name is rejected', async () => {
		const { send, close } = await postBody({
			embeds: [{ description: 'hi', author: { icon_url: 'https://x/y.png' } }],
		});
		await expect(send).rejects.toThrow(/author\.name is required/);
		await close();
	});

	test('a poll with zero answers is rejected', async () => {
		const { send, close } = await postBody({ poll: { question: { text: 'Best?' }, answers: [] } });
		await expect(send).rejects.toThrow(/poll must have between 1 and 10 answers/);
		await close();
	});

	test('a poll with no question text is rejected', async () => {
		const { send, close } = await postBody({ poll: { question: {}, answers: [{ poll_media: { text: 'A' } }] } });
		await expect(send).rejects.toThrow(/poll\.question\.text is required/);
		await close();
	});

	test('editing a poll onto an existing message is rejected', async () => {
		const { world, channel } = seedGuildFixture('poll-edit');
		const message = world.registerMessage(channel.id, {
			id: 'poll-edit-msg',
			author: apiUser({ id: TEST_BOT_ID }),
			content: 'hi',
		});
		const bot = await createMockBot({ world });
		await expect(
			bot.rest.request('PATCH', `/channels/${channel.id}/messages/${message.id}`, {
				body: { poll: { question: { text: 'Q' }, answers: [{ poll_media: { text: 'A' } }] } },
			}),
		).rejects.toThrow(/poll cannot be edited/);
		await bot.close();
	});
});
