import {
	Command,
	ContextMenuCommand,
	createNumberOption,
	Declare,
	type MenuCommandContext,
	Options,
	type ParseLocales,
	type UserCommandInteraction,
} from 'seyfert';
import { ApplicationCommandType, InteractionResponseType } from 'seyfert/lib/types';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { apiUser } from '../../src/bot/payloads';
import { mockWorld } from '../../src/bot/world';
import { ReportMessage, ReportUser, SearchCommand } from './_setup';

const englishLang = { greeting: 'Hello!' };

declare module 'seyfert' {
	interface DefaultLocale extends ParseLocales<typeof englishLang> {}
}

describe('autocomplete and context menus', () => {
	test('autocomplete returns the responded choices', async () => {
		const bot = await createMockBot({ commands: [SearchCommand] });
		const result = await bot.autocomplete({ name: 'search', focused: 'query', value: 'sey' });
		expect(result.choices).toEqual([{ name: 'result:sey', value: 'sey' }]);
		await bot.close();
	});

	test('autocomplete preserves declared number option type for whole-number values', async () => {
		const seenTypes: number[] = [];
		const options = {
			ratio: createNumberOption({
				description: 'Decimal ratio',
				required: true,
				autocomplete: async interaction => {
					const focused = interaction.data.options?.find(option => option.name === 'ratio');
					if (focused) seenTypes.push(focused.type);
					await interaction.respond([{ name: 'one', value: 1 }]);
				},
			}),
		};
		@Declare({ name: 'numbers', description: 'Numbers' })
		@Options(options)
		class NumbersCommand extends Command {}

		const bot = await createMockBot({ commands: [NumbersCommand] });
		await bot.autocomplete({ name: 'numbers', focused: 'ratio', value: 1 });

		expect(seenTypes).toEqual([10]);
		await bot.close();
	});

	test('userMenu resolves the target user', async () => {
		const bot = await createMockBot({ commands: [ReportUser] });
		const target = apiUser({ id: '42', username: 'spammer' });
		const result = await bot.userMenu({ name: 'Report User', target });
		expect(result.reply?.body).toMatchObject({
			type: InteractionResponseType.ChannelMessageWithSource,
			data: { content: 'Reported spammer' },
		});
		await bot.close();
	});

	test('userMenu includes resolved member data for world-backed targets', async () => {
		class InspectMember extends ContextMenuCommand {
			type = ApplicationCommandType.User as const;
			name = 'Inspect Member';

			async run(ctx: MenuCommandContext<UserCommandInteraction>) {
				const members = ctx.interaction.data.resolved.members as Record<string, { permissions?: string }> | undefined;
				const member = members?.[ctx.interaction.data.targetId];
				await ctx.write({ content: member?.permissions ? 'member' : 'missing' });
			}
		}

		const world = mockWorld();
		const guild = world.registerGuild({ id: 'menu-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'menu-actor' }) });
		const target = world.registerMember(guild.id, { user: apiUser({ id: 'menu-target', username: 'target' }) });
		const channel = world.registerChannel(guild.id);
		const bot = await createMockBot({ commands: [InspectMember], world });
		const result = await bot.userMenu({
			name: 'Inspect Member',
			guildId: guild.id,
			channel,
			user: actor.user,
			target: target.user,
		});

		expect(result.content).toBe('member');
		await bot.close();
	});

	test('context menu dispatchers require a matching command type', async () => {
		const bot = await createMockBot({ commands: [ReportUser, ReportMessage] });

		expect(() => bot.userMenu({ name: 'Report Message' })).toThrow(/userMenu: command "Report Message"/);
		expect(() => bot.messageMenu({ name: 'Report User' })).toThrow(/messageMenu: command "Report User"/);

		await bot.close();
	});
});
