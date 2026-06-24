import { ActionRow, Button, Command, type CommandContext, Declare, Embed } from 'seyfert';
import { ButtonStyle } from 'seyfert/lib/types';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../src/bot/bot';
import { expectComponent, expectContent, expectEmbed, mockCommandContext, mockComponentContext } from '../src';

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

describe('context path: component accessors + expectComponent', () => {
	test('lastComponents flattens + normalizes builder action rows', async () => {
		const ctx = mockCommandContext();
		await ctx.write({
			components: [
				new ActionRow<Button>().setComponents([
					new Button().setCustomId('go').setLabel('Go').setStyle(ButtonStyle.Primary),
				]),
			],
		});

		// footgun: the raw stored Button builder hides its custom_id under .data (only surfaced via .toJSON())
		const rawButton = (ctx.lastResponse() as { components: { components: { custom_id?: string }[] }[] }).components[0]
			.components[0];
		expect(rawButton.custom_id).toBeUndefined();

		const [button] = ctx.lastComponents();
		expect(button.customId).toBe('go');
		expect(button.label).toBe('Go');
		expect(button.type).toBe(2);
	});

	test('expectComponent matches customId/type/disabled, select options, and throws when none match', async () => {
		const ctx = mockCommandContext();
		await ctx.write({
			components: [
				{ type: 1, components: [{ type: 2, custom_id: 'delete_payout_menu', label: 'Delete', disabled: true }] },
			],
		});
		expectComponent(ctx, { customId: 'delete_payout_menu', type: 'button', disabled: true });
		expect(() => expectComponent(ctx, { customId: 'nope' })).toThrow(/no component matched/);

		const select = mockCommandContext();
		await select.write({
			components: [
				{ type: 1, components: [{ type: 3, custom_id: 'pick', options: [{ label: 'Display c1', value: 'c1' }] }] },
			],
		});
		expectComponent(select, { type: 'select', options: [{ label: /Display/, value: 'c1' }] });
	});

	test('expectComponent throws (not vacuous) when no component was sent', async () => {
		const ctx = mockCommandContext();
		await ctx.write({ content: 'no components here' });
		expect(() => expectComponent(ctx)).toThrow(/no interactive component/);
	});

	test('same matcher works on a bot-path DispatchResult', async () => {
		@Declare({ name: 'menu', description: 'sends a button' })
		class MenuCommand extends Command {
			async run(ctx: CommandContext) {
				await ctx.write({
					components: [
						new ActionRow<Button>().setComponents([
							new Button().setCustomId('manage-account:link:c1').setLabel('Link').setStyle(ButtonStyle.Primary),
						]),
					],
				});
			}
		}

		const bot = await createMockBot({ commands: [MenuCommand] });
		const res = await bot.slash({ name: 'menu' });
		expectComponent(res, { customId: /manage-account:link/ });
		await bot.close();
	});
});

describe('expectContent', () => {
	test('matches content (anti-vacuous) on context, bare strings, and DispatchResult', async () => {
		const ctx = mockCommandContext();
		await ctx.write({ content: 'reopened campaign' });
		expect(expectContent(ctx, /reopened/)).toBe('reopened campaign');
		expect(() => expectContent(ctx, 'closed')).toThrow(/no reply text matched/);

		const bare = mockCommandContext();
		await bare.write('bare string reply');
		expectContent(bare, /bare/);

		const noContent = mockCommandContext();
		await noContent.write({ embeds: [{ title: 'x' }] });
		expect(() => expectContent(noContent, /x/)).toThrow(/no reply with text/);
	});
});

describe('assertion gaps (RegExp render, cross-response, TextDisplay)', () => {
	test('A: expect* error renders the RegExp pattern, not {}', async () => {
		const ctx = mockCommandContext();
		await ctx.write({ embeds: [{ title: 'real' }] });
		expect(() => expectEmbed(ctx, { contains: /needle/ })).toThrow(/\/needle\//);
	});

	test('B: expectComponent/components() span ALL responses, not just the last', async () => {
		const ctx = mockCommandContext();
		await ctx.write({
			components: [{ type: 1, components: [{ type: 3, custom_id: 'delete_payout_menu', options: [] }] }],
		});
		await ctx.write({ embeds: [{ title: 'Timeout' }] }); // last reply has no component

		expect(ctx.lastComponents()).toEqual([]); // last response: nothing
		expect(ctx.allComponents().map(component => component.customId)).toContain('delete_payout_menu');
		expect(() => expectComponent(ctx, { customId: 'delete_payout_menu' })).not.toThrow();

		const e = mockCommandContext();
		await e.write({ embeds: [{ title: 'First' }] });
		await e.write({ content: 'plain last' });
		expect(e.allEmbeds().map(embed => embed.title)).toContain('First');
		expect(() => expectEmbed(e, { title: 'First' })).not.toThrow();
	});

	test('C: Components-v2 TextDisplay is surfaced via texts()/lastReply and scanned by expectContent', async () => {
		const ctx = mockCommandContext();
		await ctx.write({ components: [{ type: 17, components: [{ type: 10, content: 'Found 2 payouts' }] }] });

		expect(ctx.allTexts()).toContain('Found 2 payouts');
		expect(ctx.lastReply().texts).toContain('Found 2 payouts');
		expect(expectContent(ctx, /Found 2 payouts/)).toBe('Found 2 payouts');
	});
});

describe('lastReply (typed front door)', () => {
	test('returns content + typed embeds + components in one object, no casts', async () => {
		const ctx = mockCommandContext();
		await ctx.write({
			content: 'done',
			embeds: [new Embed().setTitle('Receipt')],
			components: [
				new ActionRow<Button>().setComponents([
					new Button().setCustomId('ok').setLabel('OK').setStyle(ButtonStyle.Primary),
				]),
			],
		});

		const reply = ctx.lastReply();
		expect(reply.content).toBe('done');
		expect(reply.embeds[0]?.title).toBe('Receipt'); // EmbedView, typed
		expect(reply.components[0]?.customId).toBe('ok'); // InteractiveComponentView, typed

		const empty = mockCommandContext();
		expect(() => empty.lastReply()).toThrow(/no responses were captured/);
	});
});

describe('light harness directs collector/fetch flows to createMockBot (no silent hand-stub)', () => {
	test('reply.createComponentCollector() throws a directed error, invisible to response comparison', async () => {
		const ctx = mockCommandContext();
		const reply = (await ctx.write({ content: 'x' })) as { createComponentCollector(): unknown };
		expect(() => reply.createComponentCollector()).toThrow(/createMockBot/);
		// non-enumerable: the verbatim responses log is unaffected
		expect(ctx.responses).toEqual([{ content: 'x' }]);
	});

	test('ctx.client.guilds/channels/users.fetch throw a directed error', () => {
		const ctx = mockCommandContext();
		expect(() => ctx.client.guilds.fetch('1')).toThrow(/createMockBot/);
		expect(() => ctx.client.channels.fetch('1')).toThrow(/createMockBot/);
		expect(() => ctx.client.users.fetch('1')).toThrow(/createMockBot/);
	});

	test('createMockBot accepts a single command class (sugar)', async () => {
		@Declare({ name: 'solo', description: 'one command' })
		class SoloCommand extends Command {
			async run(ctx: CommandContext) {
				await ctx.write({ content: 'solo' });
			}
		}
		const bot = await createMockBot({ commands: SoloCommand });
		const res = await bot.slash({ name: 'solo' });
		expect(res.content).toBe('solo');
		await bot.close();
	});
});
