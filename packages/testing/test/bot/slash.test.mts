import { Command, type CommandContext, createEvent, Declare } from 'seyfert';
import { InteractionResponseType } from 'seyfert/lib/types';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { TEST_USER_ID } from '../../src/bot/constants';
import { apiMember, apiUser } from '../../src/bot/payloads';
import { mockWorld } from '../../src/bot/world';
import {
	ConfigCommand,
	ConfirmButton,
	DeniedCommand,
	deniedBodyRan,
	denierCalls,
	FeedbackModal,
	GreetCommand,
	GuardedCommand,
	guardCalls,
	InventoryCommand,
	SLOW_DENIER_CHANNEL_ID,
	SlowCommand,
	SlowDeniedCommand,
	slowDenierCalls,
	testMiddlewares,
} from './_setup';

const englishLang = { greeting: 'Hello!' };

declare module 'seyfert' {
	interface SeyfertRegistry {
		langs: typeof englishLang;
	}
}

describe('createMockBot', () => {
	test('dispatches a slash command through the real pipeline and captures the reply', async () => {
		const bot = await createMockBot({ commands: [GreetCommand] });
		const result = await bot.slash({ name: 'greet', options: { name: 'slipher' } });
		expect(result.content).toBe('Hello, slipher!');
		expect(result.reply?.body).toMatchObject({
			type: InteractionResponseType.ChannelMessageWithSource,
			data: { content: 'Hello, slipher!' },
		});
		await bot.close();
	});

	test('OutgoingMessage rejects misspelled body fields at compile time', async () => {
		const bot = await createMockBot({ commands: [GreetCommand] });
		const result = await bot.slash({ name: 'greet', options: { name: 'slipher' } });
		const message = result.messages[0];

		const content: string | undefined = message?.content;
		const embeds: unknown[] | undefined = message?.embeds;
		expect(content).toBe('Hello, slipher!');
		expect(embeds).toBeUndefined();

		// @ts-expect-error flgs is not a field on OutgoingMessage (typo of flags)
		expect(message?.flgs).toBeUndefined();
		// @ts-expect-error contnet is not a field on OutgoingMessage (typo of content)
		expect(message?.contnet).toBeUndefined();
		await bot.close();
	});

	test('omitted guild and channel ids are stable across dispatches', async () => {
		const seen: { guildId?: string; channelId?: string }[] = [];

		@Declare({ name: 'location', description: 'Captures dispatch location' })
		class LocationCommand extends Command {
			async run(ctx: CommandContext) {
				seen.push({ guildId: ctx.guildId, channelId: ctx.channelId });
				await ctx.write({ content: `${ctx.guildId}:${ctx.channelId}` });
			}
		}

		const bot = await createMockBot({ commands: [LocationCommand] });
		await bot.slash({ name: 'location' });
		await bot.slash({ name: 'location' });

		expect(seen).toEqual([
			{ guildId: 'slipher-test-guild', channelId: 'slipher-test-channel' },
			{ guildId: 'slipher-test-guild', channelId: 'slipher-test-channel' },
		]);
		await bot.close();
	});

	test('classifies deferrals, edits and followups semantically', async () => {
		const bot = await createMockBot({ commands: [SlowCommand] });
		const result = await bot.slash({ name: 'slow' });

		expect(result.deferred).toBe(true);
		expect(result.edits).toMatchObject([{ content: 'done' }]);
		expect(result.followups).toMatchObject([{ content: 'extra' }]);
		expect(result.messages).toMatchObject([{ content: 'done' }, { content: 'extra' }]);
		expect(result.content).toBe('extra');
		expect(result.reply?.body).toMatchObject({ type: InteractionResponseType.DeferredChannelMessageWithSource });
		expect(result.actions.some(action => action.method === 'PATCH')).toBe(true);
		await bot.close();
	});

	test('preserves files on deferred edits and followups', async () => {
		const editEmbed = { title: 'Edited' };
		const followupEmbed = { title: 'Followup' };
		const editFile = { filename: 'edited.txt', data: 'edited' };
		const followupFile = { filename: 'followup.txt', data: 'followup' };

		@Declare({ name: 'files', description: 'Sends files after a defer' })
		class FilesCommand extends Command {
			async run(ctx: CommandContext) {
				await ctx.deferReply();
				await ctx.editOrReply({ content: 'edited', embeds: [editEmbed], files: [editFile] });
				await ctx.followup({ content: 'followup', embeds: [followupEmbed], files: [followupFile], flags: 64 });
			}
		}

		const bot = await createMockBot({ commands: [FilesCommand] });
		const result = await bot.slash({ name: 'files' });

		expect(result.edits[0]?.files).toMatchObject([{ filename: 'edited.txt' }]);
		expect(result.followups[0]?.files).toMatchObject([{ filename: 'followup.txt' }]);
		expect(result.messages).toMatchObject([
			{ content: 'edited', embeds: [editEmbed], files: [{ filename: 'edited.txt' }] },
			{ content: 'followup', embeds: [followupEmbed], files: [{ filename: 'followup.txt' }], flags: 64 },
		]);
		expect(result.embeds).toEqual([editEmbed, followupEmbed]);
		expect(result.embed).toEqual(editEmbed);
		expect(result.files).toMatchObject([{ filename: 'edited.txt' }, { filename: 'followup.txt' }]);
		expect(result.content).toBe('followup');
		expect(result.ephemeral).toBe(true);
		await bot.close();
	});

	test('includes followup edits in semantic messages and latest content', async () => {
		@Declare({ name: 'followup-edit', description: 'Edits a followup' })
		class FollowupEditCommand extends Command {
			async run(ctx: CommandContext) {
				await ctx.write({ content: 'original' });
				const followup = await ctx.followup({ content: 'followup' });
				await ctx.interaction.editMessage(followup.id, { content: 'followup edited' });
			}
		}

		const bot = await createMockBot({ commands: [FollowupEditCommand] });
		const result = await bot.slash({ name: 'followup-edit' });

		expect(result.edits).toMatchObject([{ content: 'followup edited' }]);
		expect(result.messages).toMatchObject([
			{ content: 'original' },
			{ content: 'followup' },
			{ content: 'followup edited' },
		]);
		expect(result.content).toBe('followup edited');
		await bot.close();
	});

	test('runs registered middlewares (fully typed, no casts)', async () => {
		const bot = await createMockBot({
			commands: [GuardedCommand],
			middlewares: testMiddlewares,
		});
		const result = await bot.slash({ name: 'guarded' });
		expect(guardCalls).toEqual(['guard']);
		expect(result.reply?.body).toMatchObject({ data: { content: 'passed' } });
		await bot.close();
	});

	test('settles when a middleware denies via editOrReply without next()/stop()/pass()', async () => {
		denierCalls.length = 0;
		deniedBodyRan.length = 0;
		const bot = await createMockBot({
			commands: [DeniedCommand],
			middlewares: testMiddlewares,
		});
		// Without the denial settle this dispatch would hang forever (the middleware chain never resolves).
		const result = await bot.slash({ name: 'denied' });
		expect(denierCalls).toEqual(['denier']);
		expect(deniedBodyRan).toEqual([]);
		expect(result.content).toBe('denied');
		await bot.close();
	});

	test('captures the reply when a guard denies after a slow multi-tick REST hop', async () => {
		slowDenierCalls.length = 0;
		deniedBodyRan.length = 0;
		const bot = await createMockBot({
			commands: [SlowDeniedCommand],
			middlewares: testMiddlewares,
		});
		// The guard awaits a slow channel fetch before replying, so the denial reply's callback request only lands
		// several macrotasks after the middleware promise settles. A single-tick denial settle would finalize the
		// dispatch first and drop the reply; the REST-quiescence drain keeps waiting until the surface is quiet.
		bot.rest.intercept('GET', `/channels/${SLOW_DENIER_CHANNEL_ID}`, async () => {
			for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve));
			return { id: SLOW_DENIER_CHANNEL_ID, type: 0 };
		});
		const result = await bot.slash({ name: 'slow-denied' });
		expect(slowDenierCalls).toEqual(['slowDenier']);
		expect(deniedBodyRan).toEqual([]);
		expect(result.content).toBe('denied');
		await bot.close();
	});

	test('res.command identifies the leaf for flat and subcommand dispatches', async () => {
		const bot = await createMockBot({ commands: [GreetCommand, ConfigCommand] });

		const flat = await bot.slash({ name: 'greet', options: { name: 'x' } });
		expect(flat.command).toEqual({ name: 'greet' });

		const sub = await bot.slash({ name: 'config', subcommand: 'set' });
		expect(sub.command).toEqual({ name: 'config', subcommand: 'set' });

		await bot.close();
	});

	test('dispatches a grouped subcommand and reports the group leaf', async () => {
		const bot = await createMockBot({ commands: [InventoryCommand] });
		const res = await bot.slash({ name: 'inventory', group: 'items', subcommand: 'add' });
		expect(res.content).toBe('added');
		expect(res.command).toEqual({ name: 'inventory', group: 'items', subcommand: 'add' });
		await bot.close();
	});

	test('res.command is undefined for component dispatches', async () => {
		const bot = await createMockBot({ components: [ConfirmButton] });
		const result = await bot.clickButton('confirm');
		expect(result.command).toBeUndefined();
		await bot.close();
	});

	test('seeds the world so ctx.guild() resolves from cache', async () => {
		let seen: string | undefined;

		@Declare({ name: 'where', description: 'Reads the guild from cache' })
		class WhereCommand extends Command {
			async run(ctx: CommandContext) {
				const guild = await ctx.guild();
				seen = guild?.name;
				await ctx.write({ content: seen ?? 'nowhere' });
			}
		}

		const world = mockWorld();
		const guild = world.registerGuild({ name: 'Slipher Lab' });
		world.registerChannel(guild.id);
		world.registerMember(guild.id, { user: apiUser({ id: TEST_USER_ID, username: 'slipher-tester' }) });
		const bot = await createMockBot({ commands: [WhereCommand], world: world.build() });
		await bot.slash({ name: 'where', guildId: guild.id });
		expect(seen).toBe('Slipher Lab');
		await bot.close();
	});

	test('dispatches modals to component commands', async () => {
		const bot = await createMockBot({ components: [ConfirmButton, FeedbackModal] });
		const modal = await bot.fillModal('feedback', { rating: '5' });
		expect(modal.content).toBe('Thanks!');
		await bot.close();
	});

	test('emits gateway events to registered event handlers', async () => {
		const joined: string[] = [];
		const onJoin = createEvent({
			data: { name: 'guildMemberAdd' },
			run(member) {
				joined.push(member.user.username);
			},
		});

		const bot = await createMockBot({ events: [onJoin] });
		await bot.emitEvent('GUILD_MEMBER_ADD', {
			...apiMember({ user: apiUser({ username: 'newbie' }) }),
			guild_id: '123',
		});
		expect(joined).toEqual(['newbie']);
		await bot.close();
	});

	test('main entry exports both layers', async () => {
		const main = await import('../../src/index');
		expect(main.createMockBot).toBeTypeOf('function');
		expect(main.mockCommandContext).toBeTypeOf('function');
	});
});
