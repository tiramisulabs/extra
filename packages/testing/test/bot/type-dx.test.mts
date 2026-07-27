import {
	ContextMenuCommand,
	type MenuCommandContext,
	type RESTDeleteAPIChannelMessageResult,
	type RESTGetAPIGuildResult,
	type RESTPatchAPIGuildMemberJSONBody,
	type RESTPatchAPIGuildMemberResult,
	type RESTPostAPIChannelMessageJSONBody,
	type RESTPostAPIChannelMessageResult,
	type RESTPostAPIChannelThreadsJSONBody,
	type RESTPostAPIChannelThreadsResult,
	type RESTPostAPIGuildForumThreadsJSONBody,
	type UserCommandInteraction,
} from 'seyfert';
import { ApplicationCommandType } from 'seyfert/lib/types';
import { describe, expect, test } from 'vitest';
import { Dispatch, type DispatchOptions, type RestCall, type RestCalls, type RouteMatcher, Routes } from '../../src';
import {
	type AutocompleteResult,
	createMockBot,
	type Dispatcher,
	type DispatchResult,
	type EventDispatchResult,
	type MenuResultFor,
	type MessageMenuResult,
	type MockBot,
	type SayResult,
	type TargetFor,
	type UserMenuResult,
} from '../../src/bot/bot';
import { channelOption, mentionableOption, userOption } from '../../src/bot/interactions';
import {
	type ApiChannel,
	type ApiGuild,
	type ApiMember,
	type ApiMessage,
	type ApiRole,
	type ApiUser,
	apiMember,
	apiMessage,
	apiUser,
} from '../../src/bot/payloads';
import { mockWorld, type WorldBuilder } from '../../src/bot/world';
import { richChannel, richGuild, richMember, richRole, richUser } from '../../src/factories';
import { GreetCommand, ReportUser } from './_setup';

/** Compile-time assertion that the argument is assignable to `Expected`; the typed parameter does the checking. */
function expectAssignable<Expected>(_value: Expected): void {}

function constructPublicDispatch(options: DispatchOptions<DispatchResult>): Dispatch<DispatchResult> {
	return new Dispatch(options);
}
void constructPublicDispatch;

type RouteBody<TMatcher> = TMatcher extends RouteMatcher<string, infer TBody, unknown> ? TBody : never;
type RouteResponse<TMatcher> = TMatcher extends RouteMatcher<string, unknown, infer TResponse> ? TResponse : never;
type IsExactly<TLeft, TRight> =
	(<T>() => T extends TLeft ? 1 : 2) extends <T>() => T extends TRight ? 1 : 2
		? (<T>() => T extends TRight ? 1 : 2) extends <T>() => T extends TLeft ? 1 : 2
			? true
			: false
		: false;
type UntypedBuiltInRoute = {
	[TKey in keyof typeof Routes]: IsExactly<RouteBody<(typeof Routes)[TKey]>, Record<string, unknown>> extends true
		? TKey
		: unknown extends RouteResponse<(typeof Routes)[TKey]>
			? TKey
			: never;
}[keyof typeof Routes];

// Every built-in descriptor must carry a concrete body and response contract.
expectAssignable<never>(undefined as never as UntypedBuiltInRoute);

function assertStatefulInteractionTypes(bot: MockBot): void {
	expectAssignable<Promise<DispatchResult>>(bot.slash({ name: 'type-only' }));
	expectAssignable<Promise<DispatchResult>>(bot.slash(GreetCommand, { options: { name: 'type-only' } }));
	expectAssignable<Promise<DispatchResult>>(bot.submitModal('type-only'));
	expectAssignable<Promise<DispatchResult>>(bot.clickButton('type-only'));
	expectAssignable<Promise<DispatchResult>>(bot.selectMenu('type-only', ['value']));
	expectAssignable<Promise<UserMenuResult>>(bot.userMenu({ name: 'type-only' }));
	expectAssignable<Promise<MessageMenuResult>>(bot.messageMenu({ name: 'type-only' }));
	expectAssignable<Promise<UserMenuResult>>(bot.menu(ReportUser, { target: apiUser({ username: 'spammer' }) }));
	expectAssignable<Promise<DispatchResult>>(bot.entryPoint({ name: 'type-only' }));
	expectAssignable<Promise<void>>(bot.reset());
	// One factory, two modes: session: false keeps the identity and hands back the Dispatch instead of the step.
	const raw: Dispatcher = bot.actor({ session: false });
	expectAssignable<Dispatch<DispatchResult>>(raw.slash({ name: 'type-only' }));
	expectAssignable<Dispatch<DispatchResult>>(raw.slash(GreetCommand, { options: { name: 'type-only' } }));
	expectAssignable<Dispatch<DispatchResult>>(raw.submitModal('type-only'));
	expectAssignable<Dispatch<DispatchResult>>(raw.clickButton('type-only'));
	expectAssignable<Dispatch<DispatchResult>>(raw.selectMenu('type-only', ['value']));
	expectAssignable<Dispatch<UserMenuResult>>(raw.userMenu({ name: 'type-only' }));
	expectAssignable<Dispatch<MessageMenuResult>>(raw.messageMenu({ name: 'type-only' }));
	expectAssignable<Dispatch<UserMenuResult>>(raw.menu(ReportUser, { target: apiUser({ username: 'spammer' }) }));
	expectAssignable<Dispatch<DispatchResult>>(raw.entryPoint({ name: 'type-only' }));
	expectAssignable<Dispatch<AutocompleteResult>>(raw.autocomplete({ name: 'type-only', focused: 'q', value: 'x' }));
	expectAssignable<Dispatch<SayResult>>(raw.say('!type-only'));
	expectAssignable<Dispatch<EventDispatchResult>>(raw.emit('GUILD_MEMBER_ADD'));
	// @ts-expect-error an un-sessioned dispatcher has no session to scope a causal REST history to.
	void raw.restCalls;
	const memberEdits = bot.restCalls(Routes.editMember);
	expectAssignable<
		readonly RestCall<
			{ guildId: string; userId: string },
			RESTPatchAPIGuildMemberJSONBody,
			RESTPatchAPIGuildMemberResult
		>[]
	>(memberEdits);
	expectAssignable<string>(memberEdits[0].params.guildId);
	expectAssignable<string>(memberEdits[0].params.userId);
	expectAssignable<RESTPatchAPIGuildMemberJSONBody | undefined>(memberEdits[0].body);
	expectAssignable<RESTPatchAPIGuildMemberResult | undefined>(memberEdits[0].response);

	const messages = bot.restCalls(Routes.createMessage);
	expectAssignable<RESTPostAPIChannelMessageJSONBody | undefined>(messages[0].body);
	expectAssignable<RESTPostAPIChannelMessageResult | undefined>(messages[0].response);
	expectAssignable<string>(messages[0].params.channelId);

	const guilds = bot.restCalls(Routes.fetchGuild);
	expectAssignable<undefined>(guilds[0].body);
	expectAssignable<RESTGetAPIGuildResult | undefined>(guilds[0].response);
	expectAssignable<string>(guilds[0].params.guildId);

	const deletes = bot.restCalls(Routes.deleteMessage);
	expectAssignable<undefined>(deletes[0].body);
	expectAssignable<RESTDeleteAPIChannelMessageResult | undefined>(deletes[0].response);
	expectAssignable<string>(deletes[0].params.messageId);

	const threads = bot.restCalls(Routes.createThread);
	expectAssignable<RESTPostAPIChannelThreadsJSONBody | RESTPostAPIGuildForumThreadsJSONBody | undefined>(
		threads[0].body,
	);
	expectAssignable<RESTPostAPIChannelThreadsResult | undefined>(threads[0].response);

	type CustomBody = { name: string };
	type CustomResponse = { id: string; name: string };
	const customRoute: RouteMatcher<'/widgets/:widgetId', CustomBody, CustomResponse> = {
		method: 'POST',
		route: '/widgets/:widgetId',
	};
	const customCalls = bot.restCalls(customRoute);
	expectAssignable<string>(customCalls[0].params.widgetId);
	expectAssignable<CustomBody | undefined>(customCalls[0].body);
	expectAssignable<CustomResponse | undefined>(customCalls[0].response);

	const noRouteParam = bot.restCalls()[0]?.params.arbitrary;
	expectAssignable<undefined>(noRouteParam);
	expectAssignable<Record<string, unknown> | undefined>(bot.restCalls()[0]?.body);
	expectAssignable<unknown>(bot.restCalls()[0]?.response);
	// @ts-expect-error no-route reads cannot invent a string route parameter.
	const inventedRouteParam: string = noRouteParam;
	void inventedRouteParam;
	const actor = bot.actor({ user: apiUser() });
	expectAssignable<RestCalls>(actor.restCalls);
	expectAssignable<readonly RestCall[]>(actor.restCalls());
	expectAssignable<Promise<DispatchResult>>(actor.slash({ name: 'type-only' }));
	expectAssignable<Promise<DispatchResult>>(actor.slash(GreetCommand, { options: { name: 'type-only' } }));
	expectAssignable<Promise<DispatchResult>>(actor.submitModal('type-only'));
	expectAssignable<Promise<DispatchResult>>(actor.clickButton('type-only'));
	expectAssignable<Promise<DispatchResult>>(actor.selectMenu('type-only', ['value']));
	expectAssignable<Promise<UserMenuResult>>(actor.userMenu({ name: 'type-only' }));
	expectAssignable<Promise<MessageMenuResult>>(actor.messageMenu({ name: 'type-only' }));
	expectAssignable<Promise<DispatchResult>>(actor.entryPoint({ name: 'type-only' }));
	expectAssignable<Promise<UserMenuResult>>(actor.menu(ReportUser, { target: apiUser({ username: 'spammer' }) }));
	// Synthetic source describes the click, not the surface it was made from: it binds on the stateful verbs
	// and on the actor, so a panel-clicking flow keeps its identity instead of dropping to a raw dispatcher.
	expectAssignable<Promise<DispatchResult>>(bot.clickButton('type-only', { allowSyntheticSource: true }));
	expectAssignable<Promise<DispatchResult>>(
		bot.actor({ user: apiUser(), allowSyntheticSource: true }).clickButton('type-only'),
	);
	// The actor binds the whole identity, not four fields of it.
	expectAssignable<Promise<DispatchResult>>(
		bot.actor({ user: apiUser(), locale: 'es-ES', memberPermissions: 'all' }).slash({ name: 'type-only' }),
	);
	// The modal half of the same option: it names the submission, not the surface, so it binds here too.
	expectAssignable<Promise<DispatchResult>>(bot.submitModal('type-only', {}, { allowSyntheticSource: true }));
	expectAssignable<Promise<DispatchResult>>(
		bot.actor({ user: apiUser(), allowSyntheticSource: true }).submitModal('type-only'),
	);
	// @ts-expect-error fillModal was intentionally removed; submitModal is the only modal submission verb.
	void bot.fillModal;
	// @ts-expect-error restCalls accepts only an optional route descriptor, never a filter object.
	bot.restCalls(Routes.editMember, { userId: 'type-only' });
	// @ts-expect-error restCalls snapshots are read-only arrays.
	void memberEdits.push;
	if (memberEdits[0]) {
		// @ts-expect-error each captured REST call is read-only.
		memberEdits[0].route = '/changed';
	}
	// @ts-expect-error channelId is not a parameter in Routes.editMember.
	void memberEdits[0]?.params.channelId;
	// @ts-expect-error legacy single-result REST readers were removed.
	void bot.findAction;
	// @ts-expect-error legacy filtered REST readers were removed.
	void bot.findActions;
	// @ts-expect-error temporal REST assertion helpers are not part of MockBot.
	void bot.waitForAction;
	// @ts-expect-error resource-specific REST readers were removed.
	void bot.created;
	// @ts-expect-error global and current raw action aliases were removed from MockBot.
	void bot.actions;
	// @ts-expect-error actor action aliases were replaced by actor.restCalls().
	void actor.currentActions;
	// @ts-expect-error the low-level REST surface no longer owns assertion-oriented finders.
	void bot.rest.findActions;
	// @ts-expect-error the low-level REST surface no longer owns assertion-oriented required lookups.
	void bot.rest.requireAction;
	// @ts-expect-error temporal action waits are internal, not a public testing reader.
	void bot.rest.waitForAction;
}
void assertStatefulInteractionTypes;

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
	test('richUser exposes both camelCase and snake_case intentionally', () => {
		const user = richUser({ username: 'socram', globalName: 'Socram' });
		expect(user.globalName).toBe('Socram');
		expect(user.global_name).toBe('Socram');
		// Both fields are part of the declared interface; neither read is a type error.
		expectAssignable<string | null>(user.globalName);
		expectAssignable<string | null>(user.global_name);
	});

	test('richMember exposes joinedAt and joined_at from the declared shape', () => {
		const member = richMember({ joinedAt: '2026-06-14T00:00:00.000Z' });
		expect(member.joinedAt).toBe('2026-06-14T00:00:00.000Z');
		expect(member.joined_at).toBe('2026-06-14T00:00:00.000Z');
	});

	test('richUser type does not leak fields outside the declared contract', () => {
		const user = richUser();
		// @ts-expect-error `nick` is a member field, never part of the declared RichUser contract.
		void user.nick;
		// @ts-expect-error `preferred_locale` is a guild field, never part of RichUser.
		void user.preferred_locale;
	});
});

// A seeded world is structuredCloned into the client cache, so a payload slot may not hold a rich* fixture —
// the fixtures carry methods and structuredClone refuses functions. The api* payload types say so themselves
// now (PlainPayload), which is what turns the seeding guard from the primary defence into a backstop.
// Compile-time only: the rejected calls would still MUTATE the world if they ran, so this is never invoked.
function assertPayloadBranding(world: WorldBuilder, guildId: string): void {
	// @ts-expect-error richUser carries methods; a seeded world is structuredCloned, so it takes apiUser.
	world.registerMember(guildId, { user: richUser({ id: 'plain-payload-user' }) });
	// @ts-expect-error same rule one level down, at the payload factory itself.
	apiMember({ user: richUser() });
	// @ts-expect-error and on a message author.
	apiMessage({ author: richUser() });
	// @ts-expect-error richChannel is not an ApiChannel.
	expectAssignable<ApiChannel>(richChannel());
	// @ts-expect-error richGuild is not an ApiGuild.
	expectAssignable<ApiGuild>(richGuild());
	// @ts-expect-error richRole is not an ApiRole.
	expectAssignable<ApiRole>(richRole());
	// @ts-expect-error richMember is not an ApiMember.
	expectAssignable<ApiMember>(richMember());
}
void assertPayloadBranding;

describe('type DX: a rich* fixture cannot stand in for an api* payload', () => {
	test('a raw wire literal and the payload factory both still satisfy a seeding slot', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'plain-payload-guild' });
		// Branding rejects behaviour, not provenance: an object literal typed ApiUser needs no factory and no cast.
		const raw: ApiUser = {
			id: 'plain-payload-raw',
			username: 'raw',
			global_name: null,
			discriminator: '0',
			avatar: null,
			bot: false,
		};
		world.registerMember(guild.id, { user: raw });
		world.registerMember(guild.id, { user: apiUser({ id: 'plain-payload-api' }) });

		await using seeded = await createMockBot({ world });
		expect(seeded.world.query.member({ guildId: guild.id, userId: 'plain-payload-raw' })).toBeDefined();
		expect(seeded.world.query.member({ guildId: guild.id, userId: 'plain-payload-api' })).toBeDefined();
	});

	test('encoding an entity into resolved option data still takes a fixture', () => {
		// Resolved option data is encoded, never cloned, and the rich* fixtures carry the wire fields for exactly
		// this. Branding the payloads must not cost that: these are the calls S24's snake_case contract is for.
		expect(userOption(richUser({ id: 'encoded-user' })).value).toBe('encoded-user');
		expect(channelOption(richChannel({ id: 'encoded-channel' })).value).toBe('encoded-channel');
		expect(mentionableOption(richUser({ id: 'encoded-mentionable' })).value).toBe('encoded-mentionable');
	});
});

describe('type DX: public bot.world is a read-only surface', () => {
	test('@internal mutators are NOT part of the public bot.world type', async () => {
		const bot = await createMockBot();
		// Read methods are part of the public WorldStateReader and compile.
		void (bot.world.query.reaction({ channelId: 'c', messageId: 'm', emoji: '👍' })?.users ?? []);
		void bot.world.query.rawMessage({ channelId: 'c', id: 'm' });
		void bot.world.snapshot();
		// @ts-expect-error addReaction is an @internal mutator, absent from the public bot.world type.
		bot.world.addReaction;
		// @ts-expect-error patchMember is an @internal mutator, absent from the public bot.world type.
		bot.world.patchMember;
		// @ts-expect-error setChannelOverwrite is an @internal mutator, absent from the public type.
		bot.world.setChannelOverwrite;
		// @ts-expect-error addOriginalResponse is an @internal mutator, absent from the public type.
		bot.world.addOriginalResponse;
		await bot.close();
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

	test('raw menu keeps the class-narrowed result type', () => {
		const probe = (bot: MockBot) => {
			expectAssignable<Dispatch<UserMenuResult>>(
				bot.actor({ session: false }).menu(ReportUser, { target: apiUser({ username: 'spammer' }) }),
			);
		};
		void probe;
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
