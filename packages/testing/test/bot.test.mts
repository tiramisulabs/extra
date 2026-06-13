import { describe, expect, test } from 'vitest';
import {
	Command,
	type CommandContext,
	ComponentCommand,
	type ComponentContext,
	Declare,
	Middlewares,
	ModalCommand,
	type ModalContext,
	Options,
	type ParseMiddlewares,
	createEvent,
	createMiddleware,
	createStringOption,
} from 'seyfert';
import { createMockBot } from '../src/bot/bot';
import {
	buttonInteraction,
	chatInputInteraction,
	modalSubmitInteraction,
	userOption,
} from '../src/bot/interactions';
import { apiChannel, apiGuild, apiMember, apiMessage, apiUser } from '../src/bot/payloads';
import { MockApiHandler } from '../src/bot/rest';
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
		const payload = chatInputInteraction({ name: 'admin', group: 'users', subcommand: 'kick', options: { reason: 'spam' } });
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
		expect(modal.data.components).toEqual([
			{ type: 1, components: [{ type: 4, custom_id: 'rating', value: '5' }] },
		]);
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
