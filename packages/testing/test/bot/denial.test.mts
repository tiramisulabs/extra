import { Command, type CommandContext, Declare, Middlewares } from 'seyfert';
import { beforeEach, describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { apiRole } from '../../src/bot/payloads';
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

	@Declare({ name: 'skipped-command', description: 'Skipped by a stop() gate' })
	@Middlewares(['skipper'])
	class PassedCommand extends Command {
		async run(ctx: CommandContext) {
			bodyRan.push('skipped-command');
			await ctx.write({ content: 'should not run' });
		}
	}

	test('middleware stop() surfaces a structured stop result and skips run', async () => {
		const bot = await createMockBot({ commands: [PassedCommand], middlewares: testMiddlewares });
		const result = await bot.slash({ name: 'skipped-command' });

		expect(result.denied).toBe(true);
		expect(result.denial?.kind).toBe('stop');
		expect(result.denial?.reason).toBeUndefined();
		expect(result.denial?.middleware).toBe('skipper');
		expect(bodyRan).toEqual([]);
		await bot.close();
	});

	// A user-defined decorator (plugins/devs ship their own) that stamps requiredRoles onto the command.
	// It enforces nothing on its own — a middleware reads the stamp and gates. The mock runs that middleware
	// like any other, and memberRoles seeds the invoking member, so role gates are testable end to end.
	function RequiredRoles(...roleIds: string[]) {
		return <T extends abstract new (...args: never[]) => object>(target: T) => {
			(target.prototype as { requiredRoles?: string[] }).requiredRoles = roleIds;
		};
	}

	@Declare({ name: 'role-gated', description: 'Requires a role' })
	@Middlewares(['requireRoles'])
	@RequiredRoles('admin-role')
	class RoleGated extends Command {
		async run(ctx: CommandContext) {
			bodyRan.push('role-gated');
			await ctx.write({ content: 'role ok' });
		}
	}

	const adminRole = apiRole({ id: 'admin-role' });

	test('custom-decorator role gate denies when the member lacks the role', async () => {
		const bot = await createMockBot({ commands: [RoleGated], middlewares: testMiddlewares });
		const result = await bot.slash({ name: 'role-gated', memberRoles: [] });

		expect(result.denied).toBe(true);
		expect(result.denial?.kind).toBe('stop');
		expect(result.denial?.reason).toBe('missing-role');
		expect(bodyRan).toEqual([]);
		await bot.close();
	});

	test('custom-decorator role gate passes when the member holds the role', async () => {
		const bot = await createMockBot({ commands: [RoleGated], middlewares: testMiddlewares });
		const result = await bot.slash({ name: 'role-gated', memberRoles: [adminRole] });

		expect(result.denied).toBe(false);
		expect(result.denial).toBeUndefined();
		expect(bodyRan).toEqual(['role-gated']);
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
