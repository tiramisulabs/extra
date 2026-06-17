import { Command, type CommandContext, ComponentCommand, type ComponentContext, Declare } from 'seyfert';
import { describe, expect, test, vi } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { TEST_USER_ID } from '../../src/bot/constants';
import { apiUser } from '../../src/bot/payloads';
import { Routes } from '../../src/bot/routes';
import { mockWorld } from '../../src/bot/world';
import { GreetCommand } from './_setup';

const englishLang = { greeting: 'Hello!' };

declare module 'seyfert' {
	interface SeyfertRegistry {
		langs: typeof englishLang;
	}
}

describe('actors and dispatch tempo', () => {
	@Declare({
		name: 'actor-ban',
		description: 'Needs actor ban permission',
		defaultMemberPermissions: ['BanMembers'],
	})
	class ActorBanCommand extends Command {
		async onPermissionsFail(ctx: CommandContext) {
			await ctx.editOrReply({ content: 'blocked' });
		}
		async run(ctx: CommandContext) {
			await ctx.write({ content: `ok:${ctx.author.id}:${ctx.channelId}` });
		}
	}

	@Declare({ name: 'slowban', description: 'Bans and logs' })
	class SlowBanCommand extends Command {
		async run(ctx: CommandContext) {
			await ctx.client.members.ban('1', '42');
			await ctx.write({ content: 'banned' });
			await ctx.followup({ content: 'logged' });
		}
	}

	class OnlyFooButton extends ComponentCommand {
		componentType = 'Button' as const;
		filter(ctx: ComponentContext) {
			return ctx.customId === 'foo';
		}
		async run(ctx: ComponentContext) {
			await ctx.write({ content: 'foo' });
		}
	}

	@Declare({ name: 'route-write', description: 'Writes a channel message via REST' })
	class RouteWriteCommand extends Command {
		async run(ctx: CommandContext) {
			await ctx.client.messages.write('route-channel', { content: 'side' });
		}
	}

	test('until() surfaces a rejecting dispatch error instead of a misleading timeout', async () => {
		const bot = await createMockBot({ components: [OnlyFooButton] });

		// The dispatch executor rejects (no component handler matches "nomatch"); without surfacing that
		// rejection, until() would wait the full waitForAction timeout and report a generic "timed out" error.
		await expect(bot.clickButton('nomatch').until(Routes.createMessage)).rejects.toThrow(
			/no handler matched customId "nomatch"/,
		);
		await bot.close();
	});

	test('waitForAction with a plain route matcher resolves after the response is populated', async () => {
		const bot = await createMockBot({ commands: [RouteWriteCommand] });
		const pending = bot.waitForAction(Routes.createMessage);
		await bot.slash({ name: 'route-write' });

		const write = await pending;
		expect((write.response as { id?: string }).id).toBeDefined();
		await bot.close();
	});

	test('actor binds a seeded member identity across dispatchers', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'actor-guild' });
		const modRole = world.registerRole(guild.id, { id: 'actor-mod', permissions: ['BanMembers'] });
		const aliceMember = world.registerMember(guild.id, {
			user: apiUser({ id: 'alice' }),
			roles: [modRole.id],
		});
		const bobMember = world.registerMember(guild.id, { user: apiUser({ id: 'bob' }) });
		const channel = world.registerChannel(guild.id, { id: 'actor-channel' });

		const bot = await createMockBot({ commands: [ActorBanCommand], world });
		const alice = bot.actor({ member: aliceMember });
		const bob = bot.actor({ member: bobMember });

		await expect(alice.slash({ name: 'actor-ban' })).resolves.toMatchObject({
			content: `ok:${aliceMember.user.id}:${channel.id}`,
		});
		await expect(bob.slash({ name: 'actor-ban' })).resolves.toMatchObject({ content: 'blocked' });
		await bot.close();
	});

	test('await alone runs the whole dispatch', async () => {
		const bot = await createMockBot({ commands: [SlowBanCommand] });
		const result = await bot.slash({ name: 'slowban' });
		expect(result.content).toBe('logged');
		expect(result.messages).toMatchObject([{ content: 'banned' }, { content: 'logged' }]);
		expect(result.followups).toMatchObject([{ content: 'logged' }]);
		await bot.close();
	});

	test('until suspends the command at a matching call', async () => {
		const bot = await createMockBot({ commands: [SlowBanCommand] });
		const dispatch = bot.slash({ name: 'slowban' });

		const inFlight = await dispatch.until(Routes.ban);
		expect(inFlight.response).toBeUndefined();
		expect(bot.findActions(Routes.ban)).toHaveLength(1);
		expect(bot.findAction(Routes.ban)?.params).toMatchObject({ guildId: '1', userId: '42' });

		const result = await dispatch;
		expect(result.content).toBe('logged');
		await bot.close();
	});

	test('checkpoints chain and advance between matching calls', async () => {
		const bot = await createMockBot({ commands: [SlowBanCommand] });
		const dispatch = bot.slash({ name: 'slowban' });

		const ban = await dispatch.until(Routes.ban);
		expect(ban.response).toBeUndefined();
		const log = await dispatch.until(Routes.followup);
		expect(log.body).toMatchObject({ content: 'logged' });

		const result = await dispatch;
		expect(result.content).toBe('logged');
		expect(result.followups).toMatchObject([{ content: 'logged' }]);
		await bot.close();
	});

	test('a dispatch is lazy until awaited or stepped', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const bot = await createMockBot({ commands: [SlowBanCommand] });
		bot.slash({ name: 'slowban' });

		await new Promise(resolve => setImmediate(resolve));
		expect(bot.actions).toHaveLength(0);
		await bot.close();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('dispatch(es) were created but never awaited'));
		warn.mockRestore();
	});

	test('async disposal closes the bot', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		{
			await using bot = await createMockBot({ commands: [GreetCommand] });
			expect(bot.defaultUser.id).toBe(TEST_USER_ID);
		}
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});
});
