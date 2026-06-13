import {
	ActionRow,
	Button,
	Command,
	type CommandContext,
	ComponentCommand,
	type ComponentContext,
	ContextMenuCommand,
	createEvent,
	createMiddleware,
	createStringOption,
	Declare,
	Label,
	type MenuCommandContext,
	Middlewares,
	Modal,
	ModalCommand,
	type ModalContext,
	Options,
	type ParseMiddlewares,
	StringSelectMenu,
	type StringSelectMenuInteraction,
	StringSelectOption,
	TextInput,
	type UserCommandInteraction,
} from 'seyfert';
import { ApplicationCommandType, ButtonStyle, PermissionFlagsBits, TextInputStyle } from 'seyfert/lib/types';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../src/bot/bot';
import { buttonInteraction, chatInputInteraction, modalSubmitInteraction, userOption } from '../src/bot/interactions';
import { apiChannel, apiGuild, apiMember, apiMessage, apiRole, apiUser } from '../src/bot/payloads';
import {
	ALL_PERMISSIONS,
	combineRolePermissions,
	computeChannelPermissions,
	permissionBits,
} from '../src/bot/permissions';
import { apiError, MockApiError, MockApiHandler } from '../src/bot/rest';
import { Routes } from '../src/bot/routes';
import { mockWorld } from '../src/bot/world';

describe('api payload factories', () => {
	test('apiUser produces a snake_case user with unique ids', () => {
		const a = apiUser();
		const b = apiUser({ username: 'socram', globalName: null, bot: true });
		expect(a.id).not.toBe(b.id);
		expect(a).toMatchObject({ username: 'slipher-test-user', global_name: 'Slipher Test User', bot: false });
		expect(b).toMatchObject({ username: 'socram', global_name: null, bot: true });
	});

	test('apiGuild and apiChannel link via guild_id', () => {
		const guild = apiGuild({ name: 'Slipher Lab' });
		const channel = apiChannel({ guildId: guild.id });
		expect(guild).toMatchObject({ name: 'Slipher Lab', preferred_locale: 'en-US' });
		expect(channel.guild_id).toBe(guild.id);
		expect(channel.type).toBe(0);
	});

	test('apiMember wraps a user and apiMessage wraps an author', () => {
		const user = apiUser();
		const member = apiMember({ user });
		const message = apiMessage({ author: user, content: 'hi' });
		expect(member.user.id).toBe(user.id);
		expect(member.roles).toEqual([]);
		expect(message).toMatchObject({ author: { id: user.id }, content: 'hi', type: 0 });
	});
});

describe('interaction payload builders', () => {
	test('chatInputInteraction encodes primitive options by type', () => {
		const payload = chatInputInteraction({
			name: 'config',
			options: { key: 'volume', amount: 3, exact: 1.5, enabled: true },
		});
		expect(payload.type).toBe(2);
		expect(payload.data).toMatchObject({ name: 'config', type: 1 });
		expect(payload.data.options).toEqual([
			{ name: 'key', type: 3, value: 'volume' },
			{ name: 'amount', type: 4, value: 3 },
			{ name: 'exact', type: 10, value: 1.5 },
			{ name: 'enabled', type: 5, value: true },
		]);
		expect(payload.guild_id).toBeDefined();
		expect(payload.member?.user).toBeDefined();
		expect(payload.token).toContain('slipher');
	});

	test('chatInputInteraction encodes user options into resolved data', () => {
		const target = { id: '42', username: 'target', global_name: null, discriminator: '0', avatar: null, bot: false };
		const payload = chatInputInteraction({ name: 'ban', options: { user: userOption(target) } });
		expect(payload.data.options).toEqual([{ name: 'user', type: 6, value: '42' }]);
		expect(payload.data.resolved?.users?.['42']).toMatchObject({ username: 'target' });
	});

	test('chatInputInteraction nests subcommand and group', () => {
		const payload = chatInputInteraction({
			name: 'admin',
			group: 'users',
			subcommand: 'kick',
			options: { reason: 'spam' },
		});
		expect(payload.data.options).toEqual([
			{
				name: 'users',
				type: 2,
				options: [{ name: 'kick', type: 1, options: [{ name: 'reason', type: 3, value: 'spam' }] }],
			},
		]);
	});

	test('guildId: null builds a DM interaction', () => {
		const payload = chatInputInteraction({ name: 'ping', guildId: null });
		expect(payload.guild_id).toBeUndefined();
		expect(payload.member).toBeUndefined();
		expect(payload.user).toBeDefined();
	});

	test('buttonInteraction and modalSubmitInteraction build component payloads', () => {
		const button = buttonInteraction({ customId: 'confirm' });
		expect(button.type).toBe(3);
		expect(button.data).toMatchObject({ custom_id: 'confirm', component_type: 2 });
		expect(button.message).toBeDefined();

		const modal = modalSubmitInteraction({ customId: 'feedback', fields: { rating: '5' } });
		expect(modal.type).toBe(5);
		expect(modal.data).toMatchObject({ custom_id: 'feedback' });
		expect(modal.data.components).toEqual([{ type: 1, components: [{ type: 4, custom_id: 'rating', value: '5' }] }]);
	});
});

describe('MockApiHandler', () => {
	test('records requests and answers POST with a message-shaped echo', async () => {
		const rest = new MockApiHandler();
		const response = await rest.request<{ id: string; content: string }>('POST', '/channels/123/messages', {
			body: { content: 'hello' },
			reason: 'cleanup',
		});
		expect(response.content).toBe('hello');
		expect(response.id).toBeDefined();
		expect(rest.actions).toHaveLength(1);
		expect(rest.actions[0]).toMatchObject({
			method: 'POST',
			route: '/channels/123/messages',
			body: { content: 'hello' },
			reason: 'cleanup',
		});
	});

	test('interceptors take precedence and expose route params', async () => {
		const rest = new MockApiHandler();
		rest.intercept('GET', '/guilds/:guildId', (_action, params) => ({ id: params.guildId, name: 'Stubbed' }));
		const response = await rest.request<{ name: string }>('GET', '/guilds/999');
		expect(response.name).toBe('Stubbed');
	});

	test('message GET fallbacks are message-shaped', async () => {
		const rest = new MockApiHandler({ onUnhandledRest: 'silent' });
		const response = await rest.request<{ id: string }>('GET', '/webhooks/app/token/messages/@original');
		expect(response.id).toBeTypeOf('string');
	});

	test('waitForAction resolves on matching action and rejects on timeout', async () => {
		const rest = new MockApiHandler();
		const pending = rest.waitForAction(action => action.route.includes('/webhooks/'), 1000);
		await rest.request('POST', '/webhooks/app/token');
		await expect(pending).resolves.toMatchObject({ method: 'POST' });

		await expect(rest.waitForAction(action => action.route === '/never', 20)).rejects.toThrow(/timed out/);
	});
});

describe('mockWorld', () => {
	test('builds linked guilds, channels, users and members', () => {
		const world = mockWorld();
		const guild = world.registerGuild({ name: 'Lab' });
		const channel = world.registerChannel(guild.id, { name: 'general' });
		const member = world.registerMember(guild.id, { nick: 'soc' });
		const built = world.build();

		expect(built.guilds).toHaveLength(1);
		expect(channel.guild_id).toBe(guild.id);
		expect(built.members[0]).toMatchObject({ guildId: guild.id, member: { nick: 'soc' } });
		expect(built.users.some(user => user.id === member.user.id)).toBe(true);
	});
});

describe('permission helpers', () => {
	test('permissionBits normalizes named permissions and rejects unknown names', () => {
		expect(permissionBits(['BanMembers', 'KickMembers'])).toBe(
			(PermissionFlagsBits.BanMembers | PermissionFlagsBits.KickMembers).toString(),
		);
		expect(() => permissionBits(['NotRealPermission' as keyof typeof PermissionFlagsBits])).toThrow(/Valid names/);
	});

	test('combineRolePermissions ORs role bitfields', () => {
		expect(
			combineRolePermissions([
				{ permissions: permissionBits(['BanMembers']) },
				{ permissions: permissionBits(['KickMembers']) },
			]),
		).toBe((PermissionFlagsBits.BanMembers | PermissionFlagsBits.KickMembers).toString());
	});

	test('computeChannelPermissions follows owner, admin, overwrite, and timeout rules', () => {
		const guild = { id: 'guild', owner_id: 'owner' };
		const everyone = {
			id: guild.id,
			permissions: permissionBits(['ViewChannel', 'ReadMessageHistory', 'SendMessages']),
		};
		const mod = { id: 'mod', permissions: permissionBits(['BanMembers', 'KickMembers']) };

		expect(
			computeChannelPermissions({
				guild,
				roles: [everyone, mod],
				member: { userId: 'owner', roles: [] },
			}),
		).toBe(ALL_PERMISSIONS.toString());

		expect(
			computeChannelPermissions({
				guild,
				roles: [everyone, { id: 'admin', permissions: permissionBits(['Administrator']) }],
				member: { userId: 'admin-user', roles: ['admin'] },
			}),
		).toBe(ALL_PERMISSIONS.toString());

		expect(
			computeChannelPermissions({
				guild,
				roles: [everyone, mod],
				member: { userId: 'member', roles: [mod.id] },
				channel: {
					permission_overwrites: [
						{ id: mod.id, type: 0, allow: '0', deny: permissionBits(['BanMembers']) },
						{ id: 'member', type: 1, allow: permissionBits(['BanMembers']), deny: '0' },
					],
				},
			}),
		).toBe(permissionBits(['ViewChannel', 'ReadMessageHistory', 'SendMessages', 'BanMembers', 'KickMembers']));

		expect(
			computeChannelPermissions({
				guild,
				roles: [everyone],
				member: { userId: 'member', roles: [] },
				channel: {
					permission_overwrites: [
						{ id: guild.id, type: 0, allow: permissionBits(['KickMembers']), deny: permissionBits(['SendMessages']) },
						{ id: guild.id, type: 0, allow: permissionBits(['Administrator']), deny: '0' },
					],
				},
			}),
		).toBe(permissionBits(['ViewChannel', 'ReadMessageHistory', 'KickMembers']));

		expect(() =>
			computeChannelPermissions({
				guild,
				roles: [mod],
				member: { userId: 'member', roles: [mod.id] },
			}),
		).toThrow(/@everyone role/);

		expect(
			computeChannelPermissions({
				guild,
				roles: [everyone, mod],
				member: {
					userId: 'member',
					roles: [mod.id],
					communicationDisabledUntil: new Date(Date.now() + 60_000).toISOString(),
				},
			}),
		).toBe(permissionBits(['ViewChannel', 'ReadMessageHistory']));

		expect(
			computeChannelPermissions({
				guild,
				roles: [everyone, mod],
				member: { userId: 'member', roles: [mod.id], communicationDisabledUntil: new Date(0).toISOString() },
			}),
		).toBe(permissionBits(['ViewChannel', 'ReadMessageHistory', 'SendMessages', 'BanMembers', 'KickMembers']));
	});
});

const greetOptions = {
	name: createStringOption({ description: 'Who to greet', required: true }),
};

@Declare({ name: 'greet', description: 'Greets someone' })
@Options(greetOptions)
class GreetCommand extends Command {
	async run(ctx: CommandContext<typeof greetOptions>) {
		await ctx.write({ content: `Hello, ${ctx.options.name}!` });
	}
}

@Declare({ name: 'slow', description: 'Defers then follows up' })
class SlowCommand extends Command {
	async run(ctx: CommandContext) {
		await ctx.deferReply();
		await ctx.editOrReply({ content: 'done' });
		await ctx.followup({ content: 'extra' });
	}
}

class ConfirmButton extends ComponentCommand {
	componentType = 'Button' as const;
	filter(ctx: ComponentContext<'Button'>) {
		return ctx.customId === 'confirm';
	}
	async run(ctx: ComponentContext<'Button'>) {
		await ctx.write({ content: 'Confirmed!' });
	}
}

class FeedbackModal extends ModalCommand {
	filter(ctx: ModalContext) {
		return ctx.customId === 'feedback';
	}
	async run(ctx: ModalContext) {
		await ctx.write({ content: 'Thanks!' });
	}
}

const guardCalls: string[] = [];
const guard = createMiddleware<void>(middle => {
	guardCalls.push('guard');
	middle.next();
});
const testMiddlewares = { guard };

declare module 'seyfert' {
	interface RegisteredMiddlewares extends ParseMiddlewares<typeof testMiddlewares> {}
}

@Declare({ name: 'guarded', description: 'Guarded command' })
@Middlewares(['guard'])
class GuardedCommand extends Command {
	async run(ctx: CommandContext) {
		await ctx.write({ content: 'passed' });
	}
}

describe('createMockBot', () => {
	test('dispatches a slash command through the real pipeline and captures the reply', async () => {
		const bot = await createMockBot({ commands: [GreetCommand] });
		const result = await bot.slash({ name: 'greet', options: { name: 'slipher' } });
		expect(result.content).toBe('Hello, slipher!');
		expect(result.reply?.body).toMatchObject({ type: 4, data: { content: 'Hello, slipher!' } });
		await bot.close();
	});

	test('classifies deferrals, edits and followups semantically', async () => {
		const bot = await createMockBot({ commands: [SlowCommand] });
		const result = await bot.slash({ name: 'slow' });

		expect(result.deferred).toBe(true);
		expect(result.edits).toMatchObject([{ content: 'done' }]);
		expect(result.followups).toMatchObject([{ content: 'extra' }]);
		expect(result.content).toBe('done');
		expect(result.reply?.body).toMatchObject({ type: 5 });
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
		world.registerMember(guild.id, { user: apiUser({ id: 'slipher-default-user', username: 'slipher-tester' }) });
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
		const main = await import('../src/index');
		expect(main.createMockBot).toBeTypeOf('function');
		expect(main.mockCommandContext).toBeTypeOf('function');
	});
});

const searchOptions = {
	query: createStringOption({
		description: 'Search term',
		required: true,
		autocomplete: async interaction => {
			const partial = interaction.getInput();
			await interaction.respond([{ name: `result:${partial}`, value: partial }]);
		},
	}),
};

@Declare({ name: 'search', description: 'Searches things' })
@Options(searchOptions)
class SearchCommand extends Command {
	async run(ctx: CommandContext<typeof searchOptions>) {
		await ctx.write({ content: ctx.options.query });
	}
}

@Declare({ name: 'Report User', type: ApplicationCommandType.User })
class ReportUser extends ContextMenuCommand {
	async run(ctx: MenuCommandContext<UserCommandInteraction>) {
		await ctx.write({ content: `Reported ${ctx.target.username}` });
	}
}

describe('autocomplete and context menus', () => {
	test('autocomplete returns the responded choices', async () => {
		const bot = await createMockBot({ commands: [SearchCommand] });
		const result = await bot.autocomplete({ name: 'search', focused: 'query', value: 'sey' });
		expect(result.choices).toEqual([{ name: 'result:sey', value: 'sey' }]);
		await bot.close();
	});

	test('userMenu resolves the target user', async () => {
		const bot = await createMockBot({ commands: [ReportUser] });
		const target = apiUser({ id: '42', username: 'spammer' });
		const result = await bot.userMenu({ name: 'Report User', target });
		expect(result.reply?.body).toMatchObject({ type: 4, data: { content: 'Reported spammer' } });
		await bot.close();
	});
});

describe('component flows', () => {
	test('clickButton reaches a component collector on the sent message', async () => {
		const clicked: string[] = [];

		@Declare({ name: 'poll', description: 'Starts a poll' })
		class PollCommand extends Command {
			async run(ctx: CommandContext) {
				const row = new ActionRow().setComponents([
					new Button().setCustomId('poll/yes').setLabel('Yes').setStyle(ButtonStyle.Primary),
				]);
				await ctx.write({ content: 'Vote now', components: [row] });
				const message = await ctx.fetchResponse();
				const collector = message.createComponentCollector();
				collector.run('poll/yes', async interaction => {
					clicked.push(interaction.customId);
					await interaction.write({ content: 'Voted!' });
				});
			}
		}

		const bot = await createMockBot({ commands: [PollCommand] });
		await bot.slash({ name: 'poll' });
		const result = await bot.clickButton('poll/yes');
		expect(clicked).toEqual(['poll/yes']);
		expect(result.reply?.body).toMatchObject({ data: { content: 'Voted!' } });
		await bot.close();
	});

	test('clickButton with no prior message uses a fresh one for ComponentCommand handlers', async () => {
		const bot = await createMockBot({ components: [ConfirmButton] });
		const result = await bot.clickButton('confirm');
		expect(result.reply?.body).toMatchObject({ data: { content: 'Confirmed!' } });
		await bot.close();
	});

	test('selectMenu reaches a component collector and exposes selected values', async () => {
		const selected: string[][] = [];

		@Declare({ name: 'pick-color', description: 'Starts a color picker' })
		class PickColorCommand extends Command {
			async run(ctx: CommandContext) {
				const row = new ActionRow().setComponents([
					new StringSelectMenu()
						.setCustomId('pick')
						.setOptions([new StringSelectOption().setLabel('Red').setValue('red')]),
				]);
				await ctx.write({ content: 'Pick one', components: [row] });
				const message = await ctx.fetchResponse();
				const collector = message.createComponentCollector();
				collector.run<StringSelectMenuInteraction>('pick', async interaction => {
					selected.push(interaction.values);
					await interaction.write({ content: `Picked ${interaction.values.join(',')}` });
				});
			}
		}

		const bot = await createMockBot({ commands: [PickColorCommand] });
		await bot.slash({ name: 'pick-color' });
		const result = await bot.selectMenu('pick', ['red']);
		expect(selected).toEqual([['red']]);
		expect(result.content).toBe('Picked red');
		await bot.close();
	});

	test('selectMenu auto-resolves seeded entity select values', async () => {
		const seen: string[][] = [];
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'select-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'select-actor' }) });
		const role = world.registerRole(guild.id, { id: 'select-role', name: 'Mods' });
		const channel = world.registerChannel(guild.id);

		class RoleSelectComponent extends ComponentCommand {
			componentType = 'RoleSelect' as const;
			filter(ctx: ComponentContext<'RoleSelect'>) {
				return ctx.customId === 'settings/mod';
			}
			async run(ctx: ComponentContext<'RoleSelect'>) {
				seen.push(ctx.interaction.roles.map(entry => entry.id));
				await ctx.write({ content: ctx.interaction.roles.map(entry => entry.name).join(',') });
			}
		}

		const bot = await createMockBot({ components: [RoleSelectComponent], world });
		const result = await bot.selectMenu('settings/mod', [role.id], {
			componentType: 'role',
			guildId: guild.id,
			channel,
			user: actor.user,
		});
		expect(seen).toEqual([[role.id]]);
		expect(result.content).toBe('Mods');
		expect(() =>
			bot.selectMenu('settings/mod', ['missing-role'], {
				componentType: 'role',
				guildId: guild.id,
				channel,
				user: actor.user,
			}),
		).toThrow(/Seeded roles: select-guild, select-role/);
		await bot.close();
	});

	test('a modal opened from a button resolves via fillModal from the same user', async () => {
		const submitted: string[] = [];

		class FeedbackButton extends ComponentCommand {
			componentType = 'Button' as const;
			filter(ctx: ComponentContext<'Button'>) {
				return ctx.customId === 'open-feedback';
			}
			async run(ctx: ComponentContext<'Button'>) {
				const modal = new Modal()
					.setCustomId('feedback-modal')
					.setTitle('Feedback')
					.setComponents([
						new Label()
							.setLabel('Rating')
							.setComponent(new TextInput({ custom_id: 'rating', style: TextInputStyle.Short })),
					]);
				const submit = await ctx.interaction.modal(modal, { waitFor: 2000 });
				if (submit) {
					submitted.push(submit.user.id);
					await submit.write({ content: 'thanks' });
				}
			}
		}

		const bot = await createMockBot({ components: [FeedbackButton] });
		const user = apiUser({ id: '777' });

		const dispatch = bot.clickButton('open-feedback', { user });
		await dispatch.untilModal();
		const modal = await bot.fillModal('feedback-modal', { rating: '5' }, { user });
		await dispatch;

		expect(submitted).toEqual(['777']);
		expect(modal.reply?.body).toMatchObject({ data: { content: 'thanks' } });
		await bot.close();
	});
});

describe('permission emulation', () => {
	test('fires bot and member permission failure hooks from payload bitfields', async () => {
		let botRun = false;
		let memberRun = false;

		@Declare({ name: 'needs-bot-ban', description: 'Needs bot ban permission', botPermissions: ['BanMembers'] })
		class NeedsBotBan extends Command {
			async onBotPermissionsFail(ctx: CommandContext) {
				await ctx.editOrReply({ content: 'missing bot perms' });
			}
			async run(ctx: CommandContext) {
				botRun = true;
				await ctx.write({ content: 'bot ok' });
			}
		}

		@Declare({
			name: 'needs-member-ban',
			description: 'Needs member ban permission',
			defaultMemberPermissions: ['BanMembers'],
		})
		class NeedsMemberBan extends Command {
			async onPermissionsFail(ctx: CommandContext) {
				await ctx.editOrReply({ content: 'missing member perms' });
			}
			async run(ctx: CommandContext) {
				memberRun = true;
				await ctx.write({ content: 'member ok' });
			}
		}

		const bot = await createMockBot({ commands: [NeedsBotBan, NeedsMemberBan] });
		await expect(bot.slash({ name: 'needs-bot-ban', permissions: [] })).resolves.toMatchObject({
			content: 'missing bot perms',
		});
		await expect(bot.slash({ name: 'needs-member-ban', memberPermissions: [] })).resolves.toMatchObject({
			content: 'missing member perms',
		});
		expect(botRun).toBe(false);
		expect(memberRun).toBe(false);
		await bot.close();
	});

	test('memberRoles grant permissions and populate the payload member roles', async () => {
		const banRole = apiRole({ id: 'ban-role', permissions: permissionBits(['BanMembers']) });

		@Declare({
			name: 'member-role-pass',
			description: 'Needs member role permission',
			defaultMemberPermissions: ['BanMembers'],
		})
		class MemberRolePass extends Command {
			async onPermissionsFail(ctx: CommandContext) {
				await ctx.editOrReply({ content: 'missing member perms' });
			}
			async run(ctx: CommandContext) {
				await ctx.write({ content: 'member ok' });
			}
		}

		const payload = chatInputInteraction({ name: 'member-role-pass', memberRoles: [banRole] });
		expect(payload.member?.roles).toContain(banRole.id);
		const bot = await createMockBot({ commands: [MemberRolePass] });
		const result = await bot.slash({ name: 'member-role-pass', memberRoles: [banRole] });
		expect(result.content).toBe('member ok');
		await bot.close();
	});

	test('computes member permissions from world roles and channel overwrites', async () => {
		@Declare({
			name: 'world-member-ban',
			description: 'Needs computed member ban permission',
			defaultMemberPermissions: ['BanMembers'],
		})
		class WorldMemberBan extends Command {
			async onPermissionsFail(ctx: CommandContext) {
				await ctx.editOrReply({ content: 'missing member perms' });
			}
			async run(ctx: CommandContext) {
				await ctx.write({ content: 'member ok' });
			}
		}

		const world = mockWorld();
		const guild = world.registerGuild({
			id: 'world-guild',
			ownerId: 'owner-user',
			everyonePermissions: ['SendMessages'],
		});
		const banRole = world.registerRole(guild.id, { id: 'ban-role', permissions: ['BanMembers'], position: 1 });
		const member = world.registerMember(guild.id, { user: apiUser({ id: 'member-user' }), roles: [banRole.id] });
		const owner = world.registerMember(guild.id, { user: apiUser({ id: guild.owner_id }) });
		const plain = world.registerChannel(guild.id, { id: 'plain-channel' });
		const denied = world.registerChannel(guild.id, {
			id: 'denied-channel',
			overwrites: [{ id: banRole.id, type: 'role', deny: ['BanMembers'] }],
		});

		const bot = await createMockBot({ commands: [WorldMemberBan], world });
		await expect(
			bot.slash({ name: 'world-member-ban', guildId: guild.id, channel: plain, user: member.user }),
		).resolves.toMatchObject({ content: 'member ok' });
		await expect(
			bot.slash({ name: 'world-member-ban', guildId: guild.id, channel: denied, user: member.user }),
		).resolves.toMatchObject({ content: 'missing member perms' });
		await expect(
			bot.slash({ name: 'world-member-ban', guildId: guild.id, channel: denied, user: owner.user }),
		).resolves.toMatchObject({ content: 'member ok' });
		await expect(
			bot.slash({
				name: 'world-member-ban',
				guildId: guild.id,
				channel: denied,
				user: member.user,
				memberPermissions: ['Administrator'],
			}),
		).resolves.toMatchObject({ content: 'member ok' });
		expect(() => bot.slash({ name: 'world-member-ban', guildId: 'missing-guild', user: member.user })).toThrow(
			/Seeded guilds: world-guild/,
		);
		await bot.close();
	});

	test('computes app permissions from the seeded bot member', async () => {
		@Declare({
			name: 'world-bot-ban',
			description: 'Needs computed bot ban permission',
			botPermissions: ['BanMembers'],
		})
		class WorldBotBan extends Command {
			async onBotPermissionsFail(ctx: CommandContext) {
				await ctx.editOrReply({ content: 'missing bot perms' });
			}
			async run(ctx: CommandContext) {
				await ctx.write({ content: 'bot ok' });
			}
		}

		const world = mockWorld();
		const guild = world.registerGuild({ id: 'bot-perm-guild' });
		const weakRole = world.registerRole(guild.id, { id: 'weak-role', permissions: ['SendMessages'] });
		const member = world.registerMember(guild.id, { user: apiUser({ id: 'actor-user' }) });
		const channel = world.registerChannel(guild.id);
		world.registerBotMember(guild.id, { roles: [weakRole.id] });
		const bot = await createMockBot({ commands: [WorldBotBan], world });
		const result = await bot.slash({ name: 'world-bot-ban', guildId: guild.id, channel, user: member.user });
		expect(result.content).toBe('missing bot perms');
		await bot.close();
	});

	test('role positions are available through the real cache for hierarchy checks', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'hierarchy-guild' });
		const mod = world.registerRole(guild.id, { id: 'mod-role', name: 'mod', position: 5 });
		const admin = world.registerRole(guild.id, { id: 'admin-role', name: 'admin', position: 10 });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'mod-user' }), roles: [mod.id] });
		const target = world.registerMember(guild.id, { user: apiUser({ id: 'admin-user' }), roles: [admin.id] });
		const channel = world.registerChannel(guild.id);
		let targetUserId = target.user.id;

		@Declare({ name: 'hierarchy-check', description: 'Checks cached role hierarchy' })
		class HierarchyCheck extends Command {
			async run(ctx: CommandContext) {
				const roles = await ctx.client.cache.roles?.values(ctx.guildId ?? '');
				const actorMember = await ctx.client.members.raw(ctx.guildId ?? '', ctx.author.id, true);
				const targetMember = await ctx.client.members.raw(ctx.guildId ?? '', targetUserId, true);
				const position = (roleId: string) => roles?.find(role => role.id === roleId)?.position ?? 0;
				const actorTop = Math.max(0, ...actorMember.roles.map(position));
				const targetTop = Math.max(0, ...targetMember.roles.map(position));
				await ctx.write({ content: targetTop > actorTop ? 'target outranks you' : 'can moderate' });
			}
		}

		const bot = await createMockBot({ commands: [HierarchyCheck], world });
		await expect(
			bot.slash({ name: 'hierarchy-check', guildId: guild.id, channel, user: actor.user }),
		).resolves.toMatchObject({ content: 'target outranks you' });
		targetUserId = actor.user.id;
		await expect(
			bot.slash({ name: 'hierarchy-check', guildId: guild.id, channel, user: target.user }),
		).resolves.toMatchObject({ content: 'can moderate' });
		await bot.close();
	});
});

describe('stateful world defaults', () => {
	test('world-backed member reads, synthetic reads, and user intercept overrides work', async () => {
		const targetId = 'fetch-target';

		@Declare({ name: 'fetch-member-world', description: 'Fetches a member through REST' })
		class FetchMemberWorld extends Command {
			async run(ctx: CommandContext) {
				const member = await ctx.client.members.raw(ctx.guildId ?? 'synthetic-guild', targetId, true);
				await ctx.write({ content: `${member.user.username}:${member.roles.join(',')}` });
			}
		}

		const world = mockWorld();
		const guild = world.registerGuild({ id: 'fetch-guild' });
		const role = world.registerRole(guild.id, { id: 'seed-role' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'fetch-actor' }) });
		world.registerMember(guild.id, { user: apiUser({ id: targetId, username: 'seeded' }), roles: [role.id] });
		const channel = world.registerChannel(guild.id);
		const bot = await createMockBot({ commands: [FetchMemberWorld], world });
		await expect(
			bot.slash({ name: 'fetch-member-world', guildId: guild.id, channel, user: actor.user }),
		).resolves.toMatchObject({ content: 'seeded:seed-role' });
		bot.rest.intercept(Routes.fetchMember, () =>
			apiMember({ user: apiUser({ id: targetId, username: 'stubbed' }), roles: ['stub-role'] }),
		);
		await expect(
			bot.slash({ name: 'fetch-member-world', guildId: guild.id, channel, user: actor.user }),
		).resolves.toMatchObject({ content: 'stubbed:stub-role' });
		await bot.close();

		const synthetic = await createMockBot({ commands: [FetchMemberWorld] });
		await expect(synthetic.slash({ name: 'fetch-member-world' })).resolves.toMatchObject({
			content: 'slipher-test-user:',
		});
		await synthetic.close();
	});

	test('ban removes the member from world, cache, later REST fetches, and emits remove events', async () => {
		const removed: string[] = [];
		const onRemove = createEvent({
			data: { name: 'guildMemberRemove' },
			run(member) {
				removed.push(member.user.id);
			},
		});
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'ban-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'ban-actor' }) });
		const target = world.registerMember(guild.id, { user: apiUser({ id: 'ban-target' }) });
		const channel = world.registerChannel(guild.id);

		@Declare({ name: 'ban-target', description: 'Bans the target' })
		class BanTarget extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.members.ban(ctx.guildId ?? '', target.user.id);
				await ctx.write({ content: 'banned' });
			}
		}

		@Declare({ name: 'fetch-banned', description: 'Fetches the banned target' })
		class FetchBanned extends Command {
			async run(ctx: CommandContext) {
				try {
					await ctx.client.members.fetch(ctx.guildId ?? '', target.user.id, true);
					await ctx.write({ content: 'found' });
				} catch (error) {
					await ctx.write({ content: error instanceof MockApiError ? error.message : 'other error' });
				}
			}
		}

		const bot = await createMockBot({ commands: [BanTarget, FetchBanned], events: [onRemove], world });
		await expect(
			bot.slash({ name: 'ban-target', guildId: guild.id, channel, user: actor.user }),
		).resolves.toMatchObject({
			content: 'banned',
		});
		expect(bot.guild(guild.id)?.member(target.user.id)).toBeUndefined();
		expect(bot.guild(guild.id)?.bans).toContain(target.user.id);
		await expect(Promise.resolve(bot.client.cache.members?.get(target.user.id, guild.id))).resolves.toBeUndefined();
		await expect(
			bot.slash({ name: 'fetch-banned', guildId: guild.id, channel, user: actor.user }),
		).resolves.toMatchObject({
			content: 'Unknown Member',
		});
		expect(removed).toEqual([target.user.id]);
		await bot.close();
	});

	test('role writes and member timeouts mutate the world and respect simulateGateway', async () => {
		const updates: string[] = [];
		const onUpdate = createEvent({
			data: { name: 'guildMemberUpdate' },
			run([member]) {
				updates.push(member.user.id);
			},
		});
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'mutate-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'mutate-actor' }) });
		const target = world.registerMember(guild.id, { user: apiUser({ id: 'mutate-target' }) });
		const role = world.registerRole(guild.id, { id: 'mutated-role' });
		const channel = world.registerChannel(guild.id);
		const timeoutAt = new Date(Date.now() + 60_000).toISOString();

		@Declare({ name: 'mutate-member', description: 'Mutates a member' })
		class MutateMember extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.members.addRole(ctx.guildId ?? '', target.user.id, role.id);
				await ctx.client.members.edit(ctx.guildId ?? '', target.user.id, {
					communication_disabled_until: timeoutAt,
				});
				const member = await ctx.client.members.raw(ctx.guildId ?? '', target.user.id, true);
				await ctx.write({ content: `${member.roles.join(',')}:${member.communication_disabled_until}` });
			}
		}

		const bot = await createMockBot({ commands: [MutateMember], events: [onUpdate], world, simulateGateway: false });
		const result = await bot.slash({ name: 'mutate-member', guildId: guild.id, channel, user: actor.user });
		expect(result.content).toBe(`${role.id}:${timeoutAt}`);
		expect(bot.guild(guild.id)?.member(target.user.id)?.roles).toEqual([role.id]);
		expect(bot.guild(guild.id)?.member(target.user.id)?.communicationDisabledUntil).toBe(timeoutAt);
		expect(updates).toEqual([]);
		await bot.close();
	});

	test('apiError responders propagate to command catch paths while recording the action', async () => {
		@Declare({ name: 'catch-rest-error', description: 'Catches REST errors' })
		class CatchRestError extends Command {
			async run(ctx: CommandContext) {
				try {
					await ctx.client.members.ban(ctx.guildId ?? '', 'error-target');
					await ctx.write({ content: 'banned' });
				} catch {
					await ctx.write({ content: 'no permission' });
				}
			}
		}

		const bot = await createMockBot({ commands: [CatchRestError] });
		bot.rest.intercept(Routes.ban, () => apiError(403, 50013, 'Missing Permissions'));
		const result = await bot.slash({ name: 'catch-rest-error' });
		expect(result.content).toBe('no permission');
		expect(bot.call(Routes.ban)).toMatchObject({ method: 'PUT' });
		await bot.close();
	});

	test('world-backed user fetches return seeded and synthetic users', async () => {
		@Declare({ name: 'fetch-users', description: 'Fetches users through REST' })
		class FetchUsers extends Command {
			async run(ctx: CommandContext) {
				const seeded = await ctx.client.users.fetch('seed-user', true);
				const synthetic = await ctx.client.users.fetch('missing-user', true);
				await ctx.write({ content: `${seeded.username}:${synthetic.id}` });
			}
		}

		const world = mockWorld();
		const guild = world.registerGuild();
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'user-fetch-actor' }) });
		const channel = world.registerChannel(guild.id);
		world.registerUser({ id: 'seed-user', username: 'Seeded' });
		const bot = await createMockBot({ commands: [FetchUsers], world });
		const result = await bot.slash({ name: 'fetch-users', guildId: guild.id, channel, user: actor.user });
		expect(result.content).toBe('Seeded:missing-user');
		await bot.close();
	});
});

describe('world state views', () => {
	test('materializes created channels, messages, embeds, and buttons', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'state-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'state-actor' }) });
		const dispatchChannel = world.registerChannel(guild.id, { id: 'dispatch-channel' });

		@Declare({ name: 'build-campaign', description: 'Builds a campaign channel' })
		class BuildCampaign extends Command {
			async run(ctx: CommandContext) {
				const channel = await ctx.client.guilds.channels.create(ctx.guildId ?? '', {
					name: 'acme-s1',
					type: 0,
				} as never);
				await ctx.client.messages.write(channel.id, {
					content: 'Welcome Acme S1',
					embeds: [{ title: 'Acme S1', fields: [{ name: 'Budget', value: '$5,000' }] }],
					components: [
						{
							type: 1,
							components: [{ type: 2, style: 1, custom_id: 'approve', label: 'Approve' }],
						},
					],
				});
				await ctx.write({ content: 'built' });
			}
		}

		const bot = await createMockBot({ commands: [BuildCampaign], world });
		await bot.slash({ name: 'build-campaign', guildId: guild.id, channel: dispatchChannel, user: actor.user });
		const channel = bot.guild(guild.id)?.channel('acme-s1');
		expect(channel?.lastMessage?.content).toContain('Welcome Acme S1');
		expect(channel?.lastMessage?.buttons).toMatchObject([{ customId: 'approve', label: 'Approve' }]);
		expect(channel?.lastMessage?.embeds[0]).toMatchObject({
			title: 'Acme S1',
			fields: [{ name: 'Budget', value: '$5,000' }],
		});
		await bot.close();
	});

	test('materializes replies, edits, followups, DMs, and original-response fetch identity', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'reply-state-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'reply-state-actor' }) });
		const channel = world.registerChannel(guild.id, { id: 'reply-state-channel' });
		let fetchedOriginalId: string | undefined;

		@Declare({ name: 'reply-state', description: 'Writes reply state' })
		class ReplyState extends Command {
			async run(ctx: CommandContext) {
				await ctx.write({ content: 'initial' });
				const original = await ctx.fetchResponse();
				fetchedOriginalId = original.id;
				await ctx.editOrReply({ content: 'edited' });
				await ctx.followup({ content: 'followup' });
				await ctx.author.write({ content: 'dm hi' });
			}
		}

		const bot = await createMockBot({ commands: [ReplyState], world });
		await bot.slash({ name: 'reply-state', guildId: guild.id, channel, user: actor.user });
		const messages = bot.guild(guild.id)?.channel(channel.id)?.messages;
		expect(messages?.map(message => message.content)).toEqual(['edited', 'followup']);
		expect(messages?.[0]?.id).toBe(fetchedOriginalId);
		expect(bot.dm(actor.user.id)?.lastMessage?.content).toBe('dm hi');
		await bot.close();
	});

	test('serves seeded message history newest-first and keeps view contract rules', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'history-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'history-actor' }) });
		const first = world.registerChannel(guild.id, { id: 'dup-1', name: 'dupe' });
		const second = world.registerChannel(guild.id, { id: 'dup-2', name: 'dupe' });
		world.registerMessage(first.id, { id: 'old-message', content: 'old' });
		world.registerMessage(first.id, { id: 'new-message', content: 'new' });

		@Declare({ name: 'fetch-history', description: 'Fetches message history' })
		class FetchHistory extends Command {
			async run(ctx: CommandContext) {
				const messages = await ctx.client.channels.fetchMessages(first.id);
				await ctx.client.messages.delete('missing-message', first.id);
				await ctx.client.members.kick(ctx.guildId ?? '', actor.user.id);
				await ctx.write({ content: messages.map(message => message.id).join(',') });
			}
		}

		const bot = await createMockBot({ commands: [FetchHistory], world });
		const result = await bot.slash({ name: 'fetch-history', guildId: guild.id, channel: second, user: actor.user });
		expect(result.content).toBe('new-message,old-message');
		expect(bot.guild(guild.id)?.channel('dupe')?.id).toBe(first.id);
		expect(bot.guild(guild.id)?.bans).toEqual([]);
		expect(bot.guild(guild.id)).not.toBe(bot.guild(guild.id));
		await bot.close();
	});
});
