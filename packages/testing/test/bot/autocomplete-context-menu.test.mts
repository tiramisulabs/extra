import {
	Command,
	ContextMenuCommand,
	createBooleanOption,
	createIntegerOption,
	createNumberOption,
	createStringOption,
	Declare,
	type MenuCommandContext,
	Options,
	type UserCommandInteraction,
} from 'seyfert';
import { ApplicationCommandType, InteractionResponseType } from 'seyfert/lib/types';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { apiMember, apiMessage, apiUser } from '../../src/bot/payloads';
import { mockWorld } from '../../src/bot/world';
import { ReportMessage, ReportUser, SearchCommand } from './_setup';

const englishLang = { greeting: 'Hello!' };

declare module 'seyfert' {
	interface SeyfertRegistry {
		langs: typeof englishLang;
	}
}

describe('autocomplete and context menus', () => {
	test('autocomplete returns the responded choices', async () => {
		const bot = await createMockBot({ commands: [SearchCommand] });
		const result = await bot.autocomplete({ name: 'search', focused: 'query', value: 'sey' });
		expect(result.choices).toEqual([{ name: 'result:sey', value: 'sey' }]);
		await bot.close();
	});

	test('autocomplete requires the focused option to be declared', async () => {
		const bot = await createMockBot({ commands: [SearchCommand] });

		expect(() => bot.autocomplete({ name: 'search', focused: 'missing', value: 'sey' })).toThrow(
			/focused option "missing" is not declared/,
		);
		await bot.close();
	});

	test('autocomplete requires the focused option to define an autocomplete callback', async () => {
		@Options({
			query: createStringOption({ description: 'Search query' }),
		})
		@Declare({ name: 'plain-search', description: 'Plain search' })
		class PlainSearchCommand extends Command {
			async run() {}
		}

		const bot = await createMockBot({ commands: [PlainSearchCommand] });

		expect(() => bot.autocomplete({ name: 'plain-search', focused: 'query', value: 'sey' })).toThrow(
			/does not declare an autocomplete callback/,
		);
		await bot.close();
	});

	test('autocomplete can opt out of validation for raw payload experiments', async () => {
		@Options({
			query: createStringOption({ description: 'Search query' }),
		})
		@Declare({ name: 'plain-search-raw', description: 'Plain search raw payload' })
		class PlainSearchRawCommand extends Command {
			async run() {}
		}

		const bot = await createMockBot({ commands: [PlainSearchRawCommand], validateOptions: false });
		const result = await bot.autocomplete({ name: 'plain-search-raw', focused: 'query', value: 'sey' });

		expect(result.choices).toBeUndefined();
		await bot.close();
	});

	test('autocomplete rejects passing the focused option again in options', async () => {
		const bot = await createMockBot({ commands: [SearchCommand] });

		expect(() =>
			bot.autocomplete({ name: 'search', focused: 'query', value: 'sey', options: { query: 'already-present' } }),
		).toThrow(/focused option "query" must be passed with focused\/value/);
		await bot.close();
	});

	test('autocomplete rejects duplicate option names in array payloads', async () => {
		@Options({
			query: createStringOption({ description: 'Search query', autocomplete: async () => {} }),
			label: createStringOption({ description: 'Optional label' }),
		})
		@Declare({ name: 'dup-autocomplete', description: 'Duplicate autocomplete options' })
		class DuplicateAutocompleteCommand extends Command {
			async run() {}
		}

		const bot = await createMockBot({ commands: [DuplicateAutocompleteCommand] });

		expect(() =>
			bot.autocomplete({
				name: 'dup-autocomplete',
				focused: 'query',
				value: 'sey',
				options: [
					{ name: 'label', value: 'one' },
					{ name: 'label', value: 'two' },
				],
			}),
		).toThrow(/option "label" is provided more than once/);
		await bot.close();
	});

	test('autocomplete rejects focused values with the wrong type', async () => {
		const bot = await createMockBot({ commands: [SearchCommand] });

		expect(() => bot.autocomplete({ name: 'search', focused: 'query', value: 1 })).toThrow(
			/option "query" must be a string/,
		);
		await bot.close();
	});

	test('autocomplete rejects focused options with unsupported Discord option types', async () => {
		const options = {
			flag: Object.assign(createBooleanOption({ description: 'Flag' }), { autocomplete: async () => {} }),
		};
		@Options(options)
		@Declare({ name: 'flag-search', description: 'Invalid autocomplete option type' })
		class FlagSearchCommand extends Command {
			async run() {}
		}

		const bot = await createMockBot({ commands: [FlagSearchCommand] });

		expect(() => bot.autocomplete({ name: 'flag-search', focused: 'flag', value: 'true' })).toThrow(
			/cannot autocomplete type 5/,
		);
		await bot.close();
	});

	test('autocomplete responding with more than 25 choices does not deliver them (rejected at the REST boundary)', async () => {
		@Options({
			q: createStringOption({
				description: 'q',
				autocomplete: async interaction => {
					await interaction.respond(Array.from({ length: 26 }, (_, n) => ({ name: `r${n}`, value: `${n}` })));
				},
			}),
		})
		@Declare({ name: 'too-many', description: 'overflows the choice cap' })
		class TooMany extends Command {
			async run() {}
		}
		const bot = await createMockBot({ commands: [TooMany] });
		// seyfert's autocomplete runner swallows the 400 (as it does against real Discord), so the dispatch resolves;
		// the over-limit respond is rejected at the callback boundary and recorded as an errored action.
		await bot.autocomplete({ name: 'too-many', focused: 'q', value: 'x' });
		expect(bot.actions.some(action => /at most 25 choices/.test(String((action.error as Error)?.message)))).toBe(true);
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

	test('autocomplete rejects non-finite and unsafe integer focused values', async () => {
		const options = {
			ratio: createNumberOption({
				description: 'Decimal ratio',
				autocomplete: async interaction => {
					await interaction.respond([{ name: 'ratio', value: interaction.getInput() }]);
				},
			}),
			count: createIntegerOption({
				description: 'Whole count',
				autocomplete: async interaction => {
					await interaction.respond([{ name: 'count', value: interaction.getInput() }]);
				},
			}),
		};
		@Declare({ name: 'invalid-numbers', description: 'Invalid numeric autocomplete values' })
		@Options(options)
		class InvalidNumbersCommand extends Command {}

		const bot = await createMockBot({ commands: [InvalidNumbersCommand] });

		expect(() => bot.autocomplete({ name: 'invalid-numbers', focused: 'ratio', value: Number.NaN })).toThrow(
			/ratio.*finite number/i,
		);
		expect(() =>
			bot.autocomplete({ name: 'invalid-numbers', focused: 'ratio', value: Number.POSITIVE_INFINITY }),
		).toThrow(/ratio.*finite number/i);
		expect(() =>
			bot.autocomplete({ name: 'invalid-numbers', focused: 'count', value: Number.MAX_SAFE_INTEGER + 1 }),
		).toThrow(/count.*safe integer/i);
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

describe('context-menu result target and class-typed dispatch', () => {
	test('result.target exposes the resolved user without optional chaining', async () => {
		const bot = await createMockBot({ commands: [ReportUser] });
		const result = await bot.userMenu({ name: 'Report User', target: apiUser({ id: '42', username: 'spammer' }) });
		expect(result.target.kind).toBe('user');
		expect(result.target.id).toBe('42');
		expect(result.target.user.username).toBe('spammer');
		await bot.close();
	});

	test('default messageMenu target carries guild_id in a guild', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'mt-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'mt-actor' }) });
		const channel = world.registerChannel(guild.id);
		const bot = await createMockBot({ commands: [ReportMessage], world });

		const result = await bot.messageMenu({ name: 'Report Message', guildId: guild.id, channel, user: actor.user });

		expect(result.target.kind).toBe('message');
		expect(result.target.message.guild_id).toBe(guild.id);
		await bot.close();
	});

	test('messageMenu resolves the target author member from the world', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'author-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'author-actor' }) });
		const author = world.registerMember(guild.id, { user: apiUser({ id: 'author-1' }), roles: ['mod-role'] });
		const channel = world.registerChannel(guild.id);
		const message = world.registerMessage(channel.id, { id: 'm-1', author: author.user });
		const bot = await createMockBot({ commands: [ReportMessage], world });

		const result = await bot.messageMenu({
			name: 'Report Message',
			guildId: guild.id,
			channel,
			user: actor.user,
			target: message,
		});

		expect(result.target.message.id).toBe('m-1');
		expect(result.target.member?.roles).toContain('mod-role');
		await bot.close();
	});

	test('explicit targetMember populates result.target.member without a world', async () => {
		const bot = await createMockBot({ commands: [ReportMessage] });
		const result = await bot.messageMenu({
			name: 'Report Message',
			target: apiMessage({ id: 'm-9' }),
			targetMember: apiMember({ roles: ['vip'], permissions: '8' }),
		});
		expect(result.target.member?.permissions).toBe('8');
		expect(result.target.member?.roles).toContain('vip');
		await bot.close();
	});

	test('menu(class) infers the target kind from the command type', async () => {
		const bot = await createMockBot({ commands: [ReportUser, ReportMessage] });

		const fromUser = await bot.menu(ReportUser, { target: apiUser({ username: 'spammer' }) });
		expect(fromUser.content).toBe('Reported spammer');

		const fromMessage = await bot.menu(ReportMessage, { target: apiMessage({ id: 'msg-7' }) });
		expect(fromMessage.content).toBe('Reported message msg-7');

		const wrongKind = () => {
			// @ts-expect-error User menu rejects an ApiMessage target
			bot.menu(ReportUser, { target: apiMessage({ id: 'x' }) });
			// @ts-expect-error Message menu rejects an ApiUser target
			bot.menu(ReportMessage, { target: apiUser() });
		};
		void wrongKind;
		await bot.close();
	});
});
