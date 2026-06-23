import { Command, type CommandContext, Declare, Embed } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../src/bot/bot';
import { expectEmbed, mockCommandContext, mockComponentContext } from '../src';

describe('context path: embed accessors kill the vacuous-pass footgun', () => {
	test('lastEmbed normalizes a seyfert Embed builder (whose fields live under toJSON)', async () => {
		const ctx = mockCommandContext();
		await ctx.write({ embeds: [new Embed().setTitle('Reopen').setDescription('are you sure?')] });

		// the footgun: a builder instance exposes nothing under bare property access
		expect((ctx.lastResponse() as { embeds: { description?: string }[] }).embeds[0].description).toBeUndefined();

		// the fix: lastEmbed reads the normalized data
		expect(ctx.lastEmbed().title).toBe('Reopen');
		expect(ctx.lastEmbed().description).toBe('are you sure?');
	});

	test('lastEmbed throws (never returns undefined) when there is nothing to read', async () => {
		const ctx = mockCommandContext();
		expect(() => ctx.lastEmbed()).toThrow(/no responses were captured/);

		await ctx.write({ content: 'plain text, no embed' });
		expect(() => ctx.lastEmbed()).toThrow(/no embeds/);

		await ctx.write({ embeds: [{ title: 'only one' }] });
		expect(() => ctx.lastEmbed(3)).toThrow(/out of range/);
	});

	test('lastEmbeds returns all normalized embeds of the last response, [] when none', async () => {
		const ctx = mockCommandContext();
		await ctx.write({ embeds: [{ title: 'A' }, new Embed().setTitle('B')] });
		expect(ctx.lastEmbeds().map(embed => embed.title)).toEqual(['A', 'B']);

		await ctx.write({ content: 'no embeds now' });
		expect(ctx.lastEmbeds()).toEqual([]);
	});

	test('works on component contexts too (shared response surface)', async () => {
		const ctx = mockComponentContext();
		await ctx.write({ embeds: [new Embed().setDescription('from a button')] });
		expect(ctx.lastEmbed().description).toBe('from a button');
	});
});

describe('expectEmbed matcher', () => {
	test('matches normalized fields and returns the matched embed', async () => {
		const ctx = mockCommandContext();
		await ctx.write({
			embeds: [new Embed().setTitle('Order #12').setDescription('shipped today').setFooter({ text: 'logistics' })],
		});

		expect(() => expectEmbed(ctx, { title: /Order/, description: 'shipped' })).not.toThrow();
		expect(expectEmbed(ctx, { footer: 'logistics' }).title).toBe('Order #12');
		expect(expectEmbed(ctx).title).toBe('Order #12'); // no criteria = "an embed was sent"
	});

	test('contains scans title + description + fields, fieldsInclude matches a field', async () => {
		const ctx = mockCommandContext();
		await ctx.write({
			embeds: [{ title: 'Status', fields: [{ name: 'state', value: 'reopened' }] }],
		});

		expectEmbed(ctx, { contains: /reopened/ });
		expectEmbed(ctx, { fieldsInclude: [{ name: 'state', value: /reopen/ }] });
	});

	test('throws (not vacuous) when no embed was sent or none matches', async () => {
		const ctx = mockCommandContext();
		await ctx.write({ content: 'no embed' });
		expect(() => expectEmbed(ctx)).toThrow(/no embed was sent/);

		await ctx.write({ embeds: [{ title: 'real' }] });
		expect(() => expectEmbed(ctx, { title: 'imaginary' })).toThrow(/no embed matched/);
	});

	test('same matcher works on a bot-path DispatchResult', async () => {
		@Declare({ name: 'card', description: 'replies with an embed' })
		class CardCommand extends Command {
			async run(ctx: CommandContext) {
				await ctx.write({ embeds: [new Embed().setTitle('Card').setDescription('body text')] });
			}
		}

		const bot = await createMockBot({ commands: [CardCommand] });
		const res = await bot.slash({ name: 'card' });
		expectEmbed(res, { title: 'Card', description: /body/ });
		await bot.close();
	});
});
