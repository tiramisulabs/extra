import { Command, type CommandContext, Declare, Middlewares } from 'seyfert';
import { beforeEach, describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { GreetCommand, testMiddlewares } from './_setup';

describe('structured denial info on dispatch results', () => {
	// Same pattern as slash.test.mts' deniedBodyRan: a denied command's run body pushes here, so a test can
	// assert the body never executed (the tracker stays empty) rather than only inspecting the denial metadata.
	const bodyRan: string[] = [];
	beforeEach(() => {
		bodyRan.length = 0;
	});

	@Declare({ name: 'blocked-command', description: 'Blocked by middleware' })
	@Middlewares(['blocker'])
	class BlockedCommand extends Command {
		async onMiddlewaresError(ctx: CommandContext, error: string) {
			await ctx.write({ content: `middleware:${error}` });
		}
		async run(ctx: CommandContext) {
			bodyRan.push('blocked-command');
			await ctx.write({ content: 'should not run' });
		}
	}

	@Declare({ name: 'denied-command', description: 'Denied by a no-next guard' })
	@Middlewares(['denier'])
	class DeniedCommand extends Command {
		async run(ctx: CommandContext) {
			bodyRan.push('denied-command');
			await ctx.write({ content: 'should not run' });
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
			bodyRan.push('needs-member-ban');
			await ctx.write({ content: 'member ok' });
		}
	}

	@Declare({
		name: 'needs-bot-ban',
		description: 'Needs bot ban permission',
		botPermissions: ['BanMembers'],
	})
	class NeedsBotBan extends Command {
		async onBotPermissionsFail(ctx: CommandContext) {
			await ctx.editOrReply({ content: 'missing bot perms' });
		}
		async run(ctx: CommandContext) {
			bodyRan.push('needs-bot-ban');
			await ctx.write({ content: 'bot ok' });
		}
	}

	test('middleware stop(reason) surfaces a structured stop denial', async () => {
		const bot = await createMockBot({ commands: [BlockedCommand], middlewares: testMiddlewares });
		const result = await bot.slash({ name: 'blocked-command' });

		expect(result.denied).toBe(true);
		expect(result.denial?.kind).toBe('stop');
		expect(result.denial?.reason).toBe('blocked');
		expect(result.denial?.middleware).toBe('blocker');
		expect(bodyRan).toEqual([]);
		await bot.close();
	});

	test('a guard that replies and returns without next() surfaces a no-next denial', async () => {
		const bot = await createMockBot({ commands: [DeniedCommand], middlewares: testMiddlewares });
		const result = await bot.slash({ name: 'denied-command' });

		expect(result.denied).toBe(true);
		expect(result.denial?.kind).toBe('no-next');
		expect(result.denial?.middleware).toBe('denier');
		expect(bodyRan).toEqual([]);
		await bot.close();
	});

	test('member permission denial surfaces a structured permissions denial', async () => {
		const bot = await createMockBot({ commands: [NeedsMemberBan] });
		const result = await bot.slash({ name: 'needs-member-ban', memberPermissions: [] });

		expect(result.denied).toBe(true);
		expect(result.denial?.kind).toBe('permissions');
		expect(result.denial?.missing).toContain('BanMembers');
		expect(bodyRan).toEqual([]);
		await bot.close();
	});

	test('bot permission denial surfaces a structured bot-permissions denial', async () => {
		const bot = await createMockBot({ commands: [NeedsBotBan] });
		const result = await bot.slash({ name: 'needs-bot-ban', permissions: [] });

		expect(result.denied).toBe(true);
		expect(result.denial?.kind).toBe('bot-permissions');
		expect(result.denial?.missing).toContain('BanMembers');
		expect(bodyRan).toEqual([]);
		await bot.close();
	});

	test('a command that runs successfully is not denied', async () => {
		const bot = await createMockBot({ commands: [GreetCommand] });
		const result = await bot.slash({ name: 'greet', options: { name: 'world' } });

		expect(result.denied).toBe(false);
		expect(result.denial).toBeUndefined();
		await bot.close();
	});
});
