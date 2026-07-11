import { ActionRow, Button, Command, type CommandContext, Declare, Embed } from 'seyfert';
import { ButtonStyle } from 'seyfert/lib/types';
import { describe, expect, test } from 'vitest';
import { mockCommandContext, mockComponentContext, rendered } from '../src';
import { createMockBot } from '../src/bot/bot';

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

describe('rendered embed reader', () => {
	test('matches normalized fields and returns the matched embed', async () => {
		const ctx = mockCommandContext();
		await ctx.write({
			embeds: [new Embed().setTitle('Order #12').setDescription('shipped today').setFooter({ text: 'logistics' })],
		});

		expect(() => rendered(ctx).get.embed({ title: /Order/, description: /shipped/ })).not.toThrow();
		expect(rendered(ctx).get.embed({ footer: 'logistics' }).title).toBe('Order #12');
		expect(rendered(ctx).get.embed().title).toBe('Order #12');
	});

	test('contains scans title + description + fields, field matches a field', async () => {
		const ctx = mockCommandContext();
		await ctx.write({
			embeds: [{ title: 'Status', fields: [{ name: 'state', value: 'reopened' }] }],
		});

		rendered(ctx).get.embed({ contains: /reopened/ });
		rendered(ctx).get.embed({ field: { name: 'state', value: /reopen/ } });
	});

	test('absence checks stay in the test runner', async () => {
		const ctx = mockCommandContext();
		await ctx.write({ embeds: [{ title: 'Status', description: 'available' }] });

		expect(rendered(ctx).all.embed({ contains: /currently owned by/ })).toHaveLength(0);
		expect(rendered(ctx).all.embed({ contains: /available/ })).toHaveLength(1);

		const empty = mockCommandContext();
		await empty.write({ content: 'no embed' });
		expect(rendered(empty).all.embed({ contains: /anything/ })).toHaveLength(0);
	});

	test('throws (not vacuous) when no embed was sent or none matches', async () => {
		const ctx = mockCommandContext();
		await ctx.write({ content: 'no embed' });
		expect(() => rendered(ctx).get.embed()).toThrow(/found 0 embeds/);

		await ctx.write({ embeds: [{ title: 'real' }] });
		expect(() => rendered(ctx).get.embed({ title: 'imaginary' })).toThrow(/found 0 embeds/);
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
		rendered(res).get.embed({ title: 'Card', description: /body/ });
		await bot.close();
	});
});

describe('context path: component accessors + rendered component reader', () => {
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

	test('rendered component readers match customId/type/disabled, select options, and throw when none match', async () => {
		const ctx = mockCommandContext();
		await ctx.write({
			components: [
				{ type: 1, components: [{ type: 2, custom_id: 'delete_item_menu', label: 'Delete', disabled: true }] },
			],
		});
		const button = rendered(ctx).get.button({ customId: 'delete_item_menu', disabled: true });
		expect(button.customId).toBe('delete_item_menu');
		expect(() => rendered(ctx).get.button('nope')).toThrow(/found 0 buttons/);

		const select = mockCommandContext();
		await select.write({
			components: [
				{ type: 1, components: [{ type: 3, custom_id: 'pick', options: [{ label: 'Display c1', value: 'c1' }] }] },
			],
		});
		rendered(select).get.select({ type: 'string', option: { label: /Display/, value: 'c1' } });
	});

	test('rendered normalizes raw component payloads passed directly', () => {
		const components = [
			new ActionRow<Button>()
				.setComponents([new Button().setCustomId('sample-action').setLabel('Run Action').setStyle(ButtonStyle.Success)])
				.toJSON(),
		];

		expect(rendered({ components }).get.button('sample-action').label).toBe('Run Action');
	});

	test('rendered throws (not vacuous) when no component was sent', async () => {
		const ctx = mockCommandContext();
		await ctx.write({ content: 'no components here' });
		expect(() => rendered(ctx).get.button()).toThrow(/found 0 buttons/);
	});

	test('same matcher works on a bot-path DispatchResult', async () => {
		@Declare({ name: 'menu', description: 'sends a button' })
		class MenuCommand extends Command {
			async run(ctx: CommandContext) {
				await ctx.write({
					components: [
						new ActionRow<Button>().setComponents([
							new Button().setCustomId('sample:link:item-1').setLabel('Link').setStyle(ButtonStyle.Primary),
						]),
					],
				});
			}
		}

		const bot = await createMockBot({ commands: [MenuCommand] });
		const res = await bot.slash({ name: 'menu' });
		rendered(res).get.button({ customId: /sample:link/ });
		await bot.close();
	});
});

describe('rendered message content reader', () => {
	test('matches content (anti-vacuous) on context, bare strings, and DispatchResult', async () => {
		const ctx = mockCommandContext();
		await ctx.write({ content: 'reopened record' });
		expect(rendered(ctx).get.message({ content: /reopened/ }).content).toBe('reopened record');
		expect(() => rendered(ctx).get.message({ content: 'closed' })).toThrow(/found 0 messages/);

		const bare = mockCommandContext();
		await bare.write('bare string reply');
		rendered(bare).get.message({ content: /bare/ });

		const noContent = mockCommandContext();
		await noContent.write({ embeds: [{ title: 'x' }] });
		expect(() => rendered(noContent).get.message({ content: /x/ })).toThrow(/found 0 messages/);
	});
});

describe('assertion gaps (RegExp render, cross-response, TextDisplay)', () => {
	test('A: rendered error renders the RegExp pattern, not {}', async () => {
		const ctx = mockCommandContext();
		await ctx.write({ embeds: [{ title: 'real' }] });
		expect(() => rendered(ctx).get.embed({ contains: /needle/ })).toThrow(/\/needle\//);
	});

	test('B: rendered spans ALL responses, not just the last', async () => {
		const ctx = mockCommandContext();
		await ctx.write({
			components: [{ type: 1, components: [{ type: 3, custom_id: 'delete_item_menu', options: [] }] }],
		});
		await ctx.write({ embeds: [{ title: 'Timeout' }] }); // last reply has no component

		expect(ctx.lastComponents()).toEqual([]); // last response: nothing
		expect(ctx.allComponents().map(component => component.customId)).toContain('delete_item_menu');
		expect(() => rendered(ctx).get.select('delete_item_menu')).not.toThrow();

		const e = mockCommandContext();
		await e.write({ embeds: [{ title: 'First' }] });
		await e.write({ content: 'plain last' });
		expect(e.allEmbeds().map(embed => embed.title)).toContain('First');
		expect(() => rendered(e).get.embed({ title: 'First' })).not.toThrow();
	});

	test('C: Components-v2 TextDisplay is surfaced via lastTexts()/allTexts() and container-first rendered', async () => {
		const ctx = mockCommandContext();
		await ctx.write({ components: [{ type: 17, components: [{ type: 10, content: 'Found 2 records' }] }] });

		expect(ctx.allTexts()).toContain('Found 2 records');
		expect(ctx.lastTexts()).toContain('Found 2 records');
		expect(
			rendered(ctx)
				.get.container({ content: /Found 2 records/ })
				.get.content().text,
		).toBe('Found 2 records');
	});
});

describe('lastTexts (last reply Components-v2 TextDisplay)', () => {
	test('lastTexts is the last response only; allTexts spans every response', async () => {
		const ctx = mockCommandContext();
		await ctx.write({ components: [{ type: 17, components: [{ type: 10, content: 'Page 1' }] }] });
		await ctx.write({ components: [{ type: 17, components: [{ type: 10, content: 'Page 2' }] }] });

		expect(ctx.lastTexts()).toEqual(['Page 2']); // last response only (symmetric with lastEmbeds/lastComponents)
		expect(ctx.allTexts()).toEqual(['Page 1', 'Page 2']); // across all responses
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
