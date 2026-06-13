import { Command, type CommandContext, createEvent, Declare, type ParseLocales } from 'seyfert';
import { InteractionResponseType } from 'seyfert/lib/types';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { TEST_USER_ID } from '../../src/bot/constants';
import { apiMember, apiUser } from '../../src/bot/payloads';
import { mockWorld } from '../../src/bot/world';
import {
	ConfirmButton,
	FeedbackModal,
	GreetCommand,
	GuardedCommand,
	guardCalls,
	SlowCommand,
	testMiddlewares,
} from './_setup';

const englishLang = { greeting: 'Hello!' };

declare module 'seyfert' {
	interface DefaultLocale extends ParseLocales<typeof englishLang> {}
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

	test('classifies deferrals, edits and followups semantically', async () => {
		const bot = await createMockBot({ commands: [SlowCommand] });
		const result = await bot.slash({ name: 'slow' });

		expect(result.deferred).toBe(true);
		expect(result.edits).toMatchObject([{ content: 'done' }]);
		expect(result.followups).toMatchObject([{ content: 'extra' }]);
		expect(result.content).toBe('done');
		expect(result.reply?.body).toMatchObject({ type: InteractionResponseType.DeferredChannelMessageWithSource });
		expect(result.actions.some(action => action.method === 'PATCH')).toBe(true);
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
