import { ContextMenuCommand, type MenuCommandContext, type UserCommandInteraction } from 'seyfert';
import { ApplicationCommandType } from 'seyfert/lib/types';
import { describe, expect, test } from 'vitest';
import { createMockBot, type MenuResultFor, type TargetFor } from '../../src/bot/bot';
import { type ApiMessage, type ApiUser, apiMember, apiMessage, apiUser } from '../../src/bot/payloads';
import { mockMember, mockUser } from '../../src/factories';
import { ReportUser } from './_setup';

/** Compile-time assertion that the argument is assignable to `Expected`; the typed parameter does the checking. */
function expectAssignable<Expected>(_value: Expected): void {}

// A context menu class that does NOT narrow `type` with `as const`. seyfert's ContextMenuCommand declares
// `type: ApplicationCommandType.User | ApplicationCommandType.Message`, so without `as const` the property
// stays the base union — exactly the widened case TargetFor must degrade gracefully for. The runtime value
// is User so the dispatch still routes to a user menu.
class LooseUserMenu extends ContextMenuCommand {
	type: ApplicationCommandType.User | ApplicationCommandType.Message = ApplicationCommandType.User;
	name = 'Loose User';
	async run(ctx: MenuCommandContext<UserCommandInteraction>) {
		await ctx.write({ content: `Reported ${ctx.target.username}` });
	}
}

describe('type DX: S23 unified MemberInput', () => {
	test('apiMember() is accepted as a dispatcher member: with no cast', async () => {
		const bot = await createMockBot({ commands: [ReportUser] });
		// S23: a full ApiMember (the return of apiMember) is assignable to the dispatcher `member` field.
		const result = await bot.userMenu({
			name: 'Report User',
			member: apiMember({ roles: ['r1'] }),
			target: apiUser({ username: 'spammer' }),
		});
		expect(result.content).toBe('Reported spammer');
		await bot.close();
	});

	test('apiMember() is accepted as targetMember: with no cast', async () => {
		const bot = await createMockBot({ commands: [ReportUser] });
		const result = await bot.userMenu({
			name: 'Report User',
			target: apiUser({ id: 't-1', username: 'spammer' }),
			targetMember: apiMember({ roles: ['vip'], permissions: '8' }),
		});
		expect(result.target.member?.permissions).toBe('8');
		expect(result.target.member?.roles).toContain('vip');
		await bot.close();
	});

	test('apiMember() is accepted by actor({ member }) with no cast', async () => {
		const bot = await createMockBot({ commands: [ReportUser] });
		const actor = bot.actor({ member: apiMember({ user: apiUser({ id: 'a-1' }) }) });
		const result = await actor.userMenu({ name: 'Report User', target: apiUser({ username: 'spammer' }) });
		expect(result.content).toBe('Reported spammer');
		await bot.close();
	});

	test('the loose options bag still works alongside the full member', async () => {
		const bot = await createMockBot({ commands: [ReportUser] });
		const result = await bot.userMenu({
			name: 'Report User',
			member: { roles: ['r1'], nick: 'mod' },
			target: apiUser({ username: 'spammer' }),
		});
		expect(result.content).toBe('Reported spammer');
		await bot.close();
	});
});

describe('type DX: S24 declared factory interfaces', () => {
	test('mockUser exposes both camelCase and snake_case intentionally', () => {
		const user = mockUser({ username: 'socram', globalName: 'Socram' });
		expect(user.globalName).toBe('Socram');
		expect(user.global_name).toBe('Socram');
		// Both fields are part of the declared interface; neither read is a type error.
		expectAssignable<string | null>(user.globalName);
		expectAssignable<string | null>(user.global_name);
	});

	test('mockMember exposes joinedAt and joined_at from the declared shape', () => {
		const member = mockMember({ joinedAt: '2026-06-14T00:00:00.000Z' });
		expect(member.joinedAt).toBe('2026-06-14T00:00:00.000Z');
		expect(member.joined_at).toBe('2026-06-14T00:00:00.000Z');
	});

	test('mockUser type does not leak fields outside the declared contract', () => {
		const user = mockUser();
		// @ts-expect-error `nick` is a member field, never part of the declared MockUser contract.
		void user.nick;
		// @ts-expect-error `preferred_locale` is a guild field, never part of MockUser.
		void user.preferred_locale;
	});
});

describe('type DX: S20 menu<C> as-const target discrimination', () => {
	test('as-const class gives a strict, non-optional result.target.user', async () => {
		const bot = await createMockBot({ commands: [ReportUser] });
		const result = await bot.menu(ReportUser, { target: apiUser({ username: 'spammer' }) });
		// as-const ReportUser → UserMenuResult: target is present, target.user is ApiUser (no `?.`).
		const username: string = result.target.user.username;
		expect(username).toBe('spammer');
		await bot.close();
	});

	test('as-const TargetFor narrows to the exact target type', () => {
		// ReportUser declares `type = ApplicationCommandType.User as const` → TargetFor is exactly ApiUser.
		const target: TargetFor<typeof ReportUser> = apiUser();
		expectAssignable<ApiUser>(target);
		// @ts-expect-error a strict User TargetFor rejects an ApiMessage.
		const wrong: TargetFor<typeof ReportUser> = apiMessage();
		void wrong;
	});

	test('non-as-const class degrades gracefully without a compile error', async () => {
		const bot = await createMockBot({ commands: [LooseUserMenu] });
		// LooseUserMenu omits `as const`: TargetFor widens to ApiUser | ApiMessage, MenuResultFor → DispatchResult.
		// This must compile (graceful degradation), not error. target is optional on the degraded result.
		const result = await bot.menu(LooseUserMenu, { target: apiUser({ username: 'spammer' }) });
		expect(result.target?.user?.username).toBe('spammer');
		await bot.close();
	});

	test('non-as-const TargetFor/MenuResultFor degrade to the graceful unions', () => {
		// Without `as const`, the target accepts either kind and the result is the base DispatchResult.
		const target: TargetFor<typeof LooseUserMenu> = apiMessage();
		expectAssignable<ApiUser | ApiMessage>(target);
		const targetUser: TargetFor<typeof LooseUserMenu> = apiUser();
		expectAssignable<ApiUser | ApiMessage>(targetUser);
		type Result = MenuResultFor<typeof LooseUserMenu>;
		// Degraded result keeps `target` optional (DispatchResult), so it needs optional chaining.
		const probe = (r: Result) => r.target?.kind;
		void probe;
	});
});
