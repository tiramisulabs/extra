# @slipher/testing

Runner-agnostic testing for Seyfert bots and Slipher plugins, in two layers behind a single import:

- **Fixtures** - plain mock objects (`mockCommandContext`, factories, stubs) for fast unit tests of a `run()` body in isolation.
- **Mock bot** - boots a real Seyfert client in-process (no token, no gateway, no network) so you can test any part of the bot - commands, components, modals, events, middlewares, plugins - by dispatching raw payloads through the real pipeline and asserting on every REST call the bot makes, without ever talking to Discord.

Rule of thumb: pure `run()` logic -> fixtures; anything touching option parsing,
middlewares, permissions, components, REST, or events -> mock bot. Both come
from the same import and can coexist in one suite.

Requires Seyfert v5 (peer dependency).

## How it works

The fixture layer is plain mock objects - no assertions, spies, or fake timers bundled - so they work with any test runner. The core is `mockCommandContext()`: a stand-in for a Seyfert command context with the fields most commands touch, plus working Slipher stubs (`logger`, `queues`, `scheduler`) that **record what your command does** so you can assert on it afterward. Factories (`mockUser`, `mockGuild`, ...) build the entities, with deterministic ids you can override. The mock-bot layer below keeps the same runner-agnostic model while driving a real Seyfert client pipeline.

## Install

```sh
pnpm add -D @slipher/testing
```

## Mock Command Contexts

```ts
import { mockCommandContext, mockUser } from '@slipher/testing';
import { expect, test } from 'vitest';
import BanCommand from './commands/ban';

test('replies after banning', async () => {
	// A stand-in context carrying just the fields the command touches.
	// `TOptions` is inferred from `options` — no generic annotation needed.
	const ctx = mockCommandContext({
		commandName: 'ban',
		options: { user: mockUser({ id: '123' }) },
	});

	// Run the real command body against the mock — no cast at the call site.
	// MockCommandContext is intentionally a partial, not a full CommandContext;
	// ctx.run() owns that one cast internally so your test doesn't.
	await ctx.run(new BanCommand());

	// Every reply lands in ctx.responses, so you assert without spies.
	expect(ctx.lastResponse()).toMatchObject({ content: expect.stringContaining('Banned') });
});
```

> `ctx.run()` skips the whole Seyfert pipeline (middlewares, option parsing) and calls `run()` directly — the lightweight path for unit-testing a command body. When you want the **real** `CommandContext` with parsing and middlewares, use the [mock bot](#mock-bot) instead, which never needs a cast.

`mockCommandContext()` includes:

- `author`, `user`, `guild()`, `channel()`, `me()`, and `member`
- `options` and `metadata`
- `write`, `editOrReply`, `followup`, and `deferReply`
- `logger`, `queues`, and `scheduler` stubs, plus `client` with the same stub instances
- `responses`, `lastResponse()`, and `clearResponses()`

`ctx.client.logger === ctx.logger`, `ctx.client.queues === ctx.queues`, and `ctx.client.scheduler === ctx.scheduler`. Use `mockClient({ extra })` when a command touches client surfaces that this package does not model.

## Factories

```ts
import { mockChannel, mockGuild, mockMember, mockUser } from '@slipher/testing';

const user = mockUser({ username: 'socram' });
const guild = mockGuild({ name: 'Slipher Lab' });
const channel = mockChannel({ guildId: guild.id });
const member = mockMember({ user });
```

## Slipher Stubs

```ts
const ctx = mockCommandContext();

ctx.logger.info('queued');
ctx.client.logger.info('also queued');
ctx.logger.add({ command: 'welcome' });
await ctx.queues.get('welcome').add('send', { userId: ctx.author.id });
ctx.scheduler.add('reminder', '30m', () => undefined);

expect(ctx.logger.entries).toHaveLength(3);
expect(ctx.logger.currentContext.command).toBe('welcome');
expect(ctx.queues.get('welcome').jobs).toHaveLength(1);
expect(ctx.scheduler.tasks).toHaveLength(1);
```

`logger.add()` mutates `currentContext` and records a synthetic `{ level: 'add' }` entry so tests can assert context changes in order with regular log calls.

`queue.add(name, payload, options)` uses the third argument to disambiguate named jobs. A call like `queue.add('send', { delay: '5s' })` is ambiguous because it could mean a string payload plus job options or a named job whose payload happens to look like job options; the mock throws with a descriptive error instead of guessing.

## Behavior Recipes

Attach runner-specific behavior by replacing the method or nested surface you need:

```ts
import { vi } from 'vitest';
import { mockCommandContext, mockGuild, mockMember } from '@slipher/testing';

const ctx = mockCommandContext();
ctx.guild = vi.fn(async () => ({
	...mockGuild(),
	members: { fetch: vi.fn(async () => mockMember()) },
}));
```

```ts
import { mockCommandContext, mockGuild, mockMember } from '@slipher/testing';

const ctx = mockCommandContext();
ctx.guild = jest.fn(async () => ({
	...mockGuild(),
	members: { fetch: jest.fn(async () => mockMember()) },
}));
```

For commands with large entity graphs, use `vitest-mock-extended` or `jest-mock-extended` in the app test suite:

```ts
import { mockDeep } from 'vitest-mock-extended';
import type { CommandContext } from 'seyfert';

const ctx = mockDeep<CommandContext>();
```

## Deterministic ids

Generated ids are overridable on every factory. When a test asserts on a generated id, reset the counter first:

```ts
import { beforeEach } from 'vitest';
import { resetMockIds } from '@slipher/testing';

beforeEach(() => resetMockIds());
```

### Time-relative ids

Discord encodes a message's creation time in its snowflake, so logic like a `clear` command ("delete messages newer than two weeks") reads that timestamp back. `mockId()` is anchored to a fixed base, so it always looks old. To mint an id created at a specific time, pass `at` (absolute) or `age` (relative to now), and decode with `timestampFrom`/`idAge` — no bit-twiddling:

```ts
import { mockId, idAge, timestampFrom } from '@slipher/testing';

const recent = mockId({ age: '13d' });               // created 13 days ago
const stale = mockId({ age: '15d' });                // created 15 days ago
const exact = mockId({ at: new Date('2024-03-01') }); // absolute created-at

idAge(recent) < 14 * 24 * 60 * 60 * 1000;            // true — ms since creation
timestampFrom(exact);                                 // 1709251200000 (epoch ms)
```

`age` uses Slipher's duration format (`'30m'`, `'12h'`, `'7d'` — same as queues/scheduler; **no weeks**, so write `'14d'` not `'2w'`). Two notes:

- These ids read the wall clock, so they are **not reproducible** across runs — don't snapshot them, and `resetMockIds()` doesn't make them stable.
- For "newer/older than N" assertions, **avoid the exact boundary** (`'13d'`/`'15d'`, not `'14d'`): your test's clock and the command's clock differ by a few ms, so the boundary is a coin flip.

## Mock bot

The mock bot runs your real command classes end-to-end. Where
`mockCommandContext()` hands your `run()` a fake context, the mock bot builds a real
`CommandContext` the same way production does: a raw `APIInteraction` goes through
`HandleCommand`, options are parsed by Seyfert's resolver, middlewares run, and
every REST call is recorded instead of sent.

```ts
import { createMockBot } from '@slipher/testing';
import { expect, test } from 'vitest';
import { GreetCommand } from '../src/commands/greet';

test('greet replies through the real pipeline', async () => {
	await using bot = await createMockBot({ commands: [GreetCommand] });
	const result = await bot.slash({ name: 'greet', options: { name: 'slipher' } });

	expect(result.content).toBe('Hello, slipher!');
});
```

Use `bot.slash(GreetCommand, { options })` when you want option inference from
the command class. Use `bot.slash({ name, ... })` for concise raw by-name
payload dispatch.

Subcommands can use the same class-first form once their parent command is
registered or loaded. The mock resolves the parent from Seyfert's loaded command
registry, including `@AutoLoad` command trees:

```ts
await using bot = await createMockBot({ commands: [ConfigCommand] });
const result = await bot.slash(ConfigSetSub, { options: { key: 'prefix' } });

expect(result.command).toEqual({ name: 'config', subcommand: 'set' });
```

For ambiguous subcommand names, use the explicit payload form:
`bot.slash({ name: 'config', group: 'admin', subcommand: 'set' })`.

The raw interaction response stays available as `result.reply?.body` (`{ type, data }`)
for the rare assertion where the Discord wire shape itself is the contract. Prefer
`result.content`, `result.deferred`, and `result.edits` for normal behavior checks.

Embeds and components come back parsed and typed, so you assert without casting:
`result.embedView?.title`, `result.embedViews`, `result.buttons`,
`result.button('Approve')?.customId`, and `result.textDisplays` (components-v2). The
raw `result.embeds`/`result.embed` expose the flattened Discord payloads for
wire-shape assertions.

`createMockBot()` accepts:

- `commands`, `components`, `events` - your real classes, registered programmatically
- `middlewares` - same record you would pass to `client.setServices`
- `globalMiddlewares` - forwarded to Seyfert's global middleware hooks
- `world` - entities to seed into the client cache
- `simulateGateway` - emit matching member update/remove events for stateful writes; defaults to `true`
- `onUnhandledRest` - throw by default, or warn/stay silent for explicitly allowed fallback reads
- `plugins` - Seyfert plugins loaded through the mock client lifecycle
- `clientOptions` - forwarded to the Seyfert `Client` constructor, excluding plugin loading
- `loadFromConfig`, `commandsDir`, `componentsDir`, `eventsDir`, `langsDir` - load the real bot through Seyfert's loaders; command dirs are imported on first dispatch by default
- `shards`, `shardLatency` - shape the in-process `MockGateway`
- `botId`, `applicationId`
- `prefixes`, `mentionAsPrefix` - enable prefix/message-command dispatch with `say()`

### Test your real bot

Import the classes you ship. Commands, events, and components are registered
the same way as production:

```ts
import { createMockBot } from '@slipher/testing';
import { BanCommand } from '../src/commands/moderation/ban';
import { ConfirmButton } from '../src/components/confirm';
import guildMemberAdd from '../src/events/guildMemberAdd';

await using bot = await createMockBot({
	commands: [BanCommand],
	components: [ConfirmButton],
	events: [guildMemberAdd],
});
```

Or boot the production set from `seyfert.config`, using the same loaders
`client.start()` would use:

```ts
await using bot = await createMockBot({ loadFromConfig: true });
await bot.slash({ name: 'ping' });
```

The config must be resolvable from the test runner's working directory. Bot
configs usually point at compiled output, so build before running broad
integration specs. Explicit directories override the config:

```ts
import { join } from 'node:path';

await using bot = await createMockBot({
	loadFromConfig: true,
	commandsDir: join(process.cwd(), 'dist/commands'),
});
```

`commandsDir` keeps startup light: the mock catalogs command file paths first,
then imports the matching group on `slash()`, `autocomplete()`, `userMenu()`, or
`messageMenu()`. Dispatch by class still works:

```ts
await using bot = await createMockBot({
	commandsDir: join(process.cwd(), 'src/commands'),
	loadModule: path => import(path),
});

await bot.slash(PingCommand);
await bot.slash(ConfigSetSub, { options: { key: 'prefix' } });
```

Use `bot.registeredCommands()` to inspect the current catalog. Each entry has a
`path`, `loaded`, and `found` array, so before dispatch you can see discovered
files and after dispatch you can see which command or subcommand materialized
from that path.

### Execution model

Every dispatcher returns a lazy `Dispatch`. Await it directly for one-shot runs, or
call `dispatch.until(Routes.ban)` first to step through the same dispatch. For a
dispatch that opens a modal, drive it in one call with `.fillModal(...)` /
`.timeoutModal()` (see below). Awaiting always releases any active checkpoint, so it
cannot deadlock.

- Immediate replies, deferrals, and modal opens are captured in `result.replies`.
- REST work awaited by the command is classified into `result.edits`,
  `result.followups`, and dispatch-scoped `result.actions`.
- `waitForAction()` is for work your command did not await: timers,
  fire-and-forget promises, queue/scheduler side effects.
- Dispatches do not reject for command errors; Seyfert routes them through error
  hooks, and you assert the user-facing error reply.

| After you awaited | Guaranteed |
|---|---|
| `await dispatch` | everything `run()` awaited: replies, edits, followups, and dispatch actions |
| `dispatch.until(...)` resolved | the matched call started; `response` is still `undefined` while suspended |
| `await emit(...)` | REST work the handler awaited |
| nothing | only `waitForAction(...)` observes fire-and-forget work |

### Step-by-step flows

The mock bot is long-lived: cache, collectors, plugin state, cooldowns, and
world mutations persist across dispatches. Bind an identity once with
`bot.actor()` instead of repeating `user`, `guildId`, and `channel` on every
call:

```ts
await using bot = await createMockBot({ commands: [PurgeCommand], world });
const alice = bot.actor({ member: aliceMember, guildId: guild.id, channel });

await alice.slash({ name: 'poll' });
await alice.clickButton('poll/yes');
await bot.emit('GUILD_MEMBER_ADD', newMember, { allowNoHandler: true });
const result = await alice.slash({ name: 'results' });

expect(result.content).toContain('1 vote');
```

To pause inside a single command, step the same dispatch instead of awaiting it
immediately:

```ts
const dispatch = bot.slash({ name: 'ban', options: { user: userOption(target) } });

const ban = await dispatch.until(Routes.ban);
expect(ban.body).toMatchObject({ delete_message_seconds: 0 });

const result = await dispatch;
expect(result.content).toBe('Banned');
```

### Dispatching

```ts
await bot.slash({ name: 'admin', group: 'users', subcommand: 'kick', options: { reason: 'spam' } });
await bot.autocomplete({ name: 'search', focused: 'query', value: 'sey' });
await bot.userMenu({ name: 'Report User', target: apiUser({ id: '42' }) });
await bot.clickButton('confirm');
await bot.selectMenu('pick-color', ['red']);
await bot.fillModal('feedback', { rating: '5' });
await bot.say('!echo -text hello');
await bot.emit('GUILD_MEMBER_ADD', rawMemberPayload);
```

`emit` fails loud when no registered handler ran — the silent trap where a
mis-cased gateway name (`'guildMemberAdd'` instead of `'GUILD_MEMBER_ADD'`) or a
forgotten `events:[...]` registration makes the assertion pass green over a handler
that never fired. `registeredEvents()` lists what's wired. When you emit only to
seed world state (no handler expected), opt out explicitly:

```ts
await bot.emit('CHANNEL_CREATE', rawChannelPayload, { allowNoHandler: true });
```

Every dispatch defaults to the bot's single test user (`bot.defaultUser`), so
cross-dispatch state such as cooldowns, waiting modals, and per-user collectors
correlates automatically. Pin `guildId` for state that must persist per guild.

Primitive option values are encoded automatically. For entity options use the
explicit helpers, which also populate `resolved` data:

```ts
import { apiUser, userOption } from '@slipher/testing';

await bot.slash({ name: 'ban',
	options: { user: userOption(apiUser({ id: '42' })), reason: 'spam' },
});
```

### Fully typed tests

The mock boots a real Seyfert client, so app augmentations such as
`RegisteredMiddlewares`, `UsingClient`, and `DefaultLocale` apply in tests too:

```ts
import type { ParseMiddlewares } from 'seyfert';
import { InteractionResponseType } from 'seyfert/lib/types';
import { TEST_BOT_ID, createMockBot } from '@slipher/testing';
import { GuardedCommand } from '../src/commands/guarded';
import { middlewares } from '../src/middlewares';

declare module 'seyfert' {
	interface RegisteredMiddlewares extends ParseMiddlewares<typeof middlewares> {}
}

await using bot = await createMockBot({
	botId: TEST_BOT_ID,
	commands: [GuardedCommand],
	middlewares,
});
const result = await bot.slash({ name: 'guarded' });

expect(result.reply?.body).toMatchObject({
	type: InteractionResponseType.ChannelMessageWithSource,
	data: { content: 'passed' },
});
```

### Prefix commands

Prefix commands use Seyfert's real message-command pipeline. Configure prefixes
on the mock client, then call `say()` with a raw message string:

```ts
await using bot = await createMockBot({ commands: [EchoCommand], prefixes: ['!'] });
const result = await bot.say('!echo -text hello');

expect(result.content).toBe('echo: hello');
expect(result.messages).toMatchObject([{ content: 'echo: hello' }]);
```

`say()` returns message-create REST calls in `result.messages`; the complete REST
trail is still in `result.actions`. Message commands do not use interaction
responses, so they do not populate `result.reply`.

Set `mentionAsPrefix: true` to include `<@botId>` and `<@!botId>` as prefixes.
Options are parsed by Seyfert's default message args parser, so command options
use flag-style syntax such as `-text hello` unless your bot supplies a custom
parser through `clientOptions`.

### i18n

Provide translations programmatically with `langs` and set a fallback with
`defaultLang`. Dispatchers already accept `locale`, so localized assertions can
stay on the real `ctx.t` path:

```ts
await using bot = await createMockBot({
	commands: [HelloCommand],
	langs: {
		'en-US': { greeting: 'Hello!' },
		'es-ES': { greeting: '¡Hola!' },
	},
	defaultLang: 'en-US',
});

expect((await bot.slash({ name: 'hello' })).content).toBe('Hello!');
expect((await bot.slash({ name: 'hello', locale: 'es-ES' })).content).toBe('¡Hola!');
```

App-level `DefaultLocale` augmentation is supported; the mock only feeds the
same translation data that Seyfert would normally load from lang files.

### Autocomplete and context menus

Autocomplete uses the real Seyfert option callback and returns the choices it
responded with:

```ts
const result = await bot.autocomplete({ name: 'search', focused: 'query', value: 'sey' });
expect(result.choices).toEqual([{ name: 'result:sey', value: 'sey' }]);
```

Context-menu commands dispatch through the same interaction pipeline as slash
commands. The raw reply remains available for wire-level assertions:

```ts
const target = apiUser({ id: '42', username: 'spammer' });
const result = await bot.userMenu({ name: 'Report User', target });

expect(result.reply?.body).toMatchObject({
	type: InteractionResponseType.ChannelMessageWithSource,
	data: { content: 'Reported spammer' },
});
```

### Component collectors and modals

For messages with component collectors, fetch the message, register the collector,
then dispatch the component. `clickButton()` and `selectMenu()` default to the
latest message-shaped REST response (`lastSentMessage()`), so most tests do not
thread message ids by hand:

```ts
class PollCommand extends Command {
	async run(ctx: CommandContext) {
		await ctx.write({ content: 'Vote now', components: [row] });
		const message = await ctx.fetchResponse();
		message.createComponentCollector().run('poll/yes', async interaction => {
			await interaction.write({ content: 'Voted!' });
		});
	}
}

await bot.slash({ name: 'poll' });
await bot.clickButton('poll/yes');
```

Pass `source` when a flow has multiple messages:

```ts
const sent = bot.lastSentMessage();
await bot.clickButton('approve', { source: sent?.id });
await bot.selectMenu('settings/mod', [role.id], { source: sent, componentType: 'role' });
```

Entity selects auto-resolve seeded world users, members, roles, and channels.
Use explicit `resolved` when testing a raw Discord payload. For a
`ComponentCommand` select-menu path without a collector, build the raw payload
with `selectMenuInteraction()` and pass it to `dispatchInteraction()`.

A dispatch that opens a modal (`interaction.modal(..., { waitFor })`) is driven in one
call — the open → resolve → settle handshake is handled for you. Submit it with
`.fillModal(...)`, or take its timeout branch with `.timeoutModal()`:

```ts
// the user submitted the modal
const modal = await bot.clickButton('open-feedback', { user }).fillModal('feedback-modal', { rating: '5' });
expect(modal.content).toBe('thanks');

// the user never submitted — the waitFor expires (instant, no fake-timer setup)
const timedOut = await bot.clickButton('open-feedback', { user }).timeoutModal();
expect(timedOut.content).toBe('timed out');
```

The `DispatchResult` returned by `.fillModal(...)` is scoped to the modal-submit
interaction. If the opener resumes after `await interaction.modal(...)` and writes
visible output from that continuation, assert through `rendered(bot)` or another
bot-level state reader when that cross-dispatch output is the contract. Use
`rendered(flow)` for the modal that the opener displayed before submission.

Awaiting a modal-opener directly (without `.fillModal()`/`.timeoutModal()`) fails loud,
since in real seyfert it would stall on the `waitFor` timer and silently take the
timeout branch.

### Testing timed behavior

Collector `idle`/`timeout` and modal `waitFor` use seyfert's bare global
`setTimeout`, which the mock can't own. Bridge your runner's fake clock through the
`timers` callback — the package imports no test runner, so the bridge is yours —
then `bot.advanceTime(ms)` fires them. Fake only `setTimeout`/`clearTimeout`:
faking `setImmediate` deadlocks the mock's drain.

```ts
import { afterEach, vi } from 'vitest';
import { createMockBot } from '@slipher/testing';

afterEach(() => vi.useRealTimers());

// vitest / sinon: list the timers TO fake
vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
const bot = await createMockBot({
	commands: [Cmd],
	timers: { advance: ms => vi.advanceTimersByTime(ms) },
});

await bot.slash({ name: 'opens-a-60s-collector' });
await bot.advanceTime(60_000); // collector onStop('idle') runs now, no real wait
```

Jest's fake timers use the inverted option — `jest.useFakeTimers({ doNotFake: ['setImmediate'] })`
keeps `setImmediate` real — with `timers: { advance: ms => jest.advanceTimersByTime(ms) }`.

### Recorded actions

Everything else the bot does goes through REST and is recorded:

```ts
import { Routes } from '@slipher/testing';

const edit = await bot.waitForAction(Routes.editOriginalResponse);
expect(edit.body).toMatchObject({ content: 'done' });

bot.actions; // every call, in order: { seq, method, route, body, query, response }
```

Stub specific endpoints when a command reads from the API:

```ts
bot.rest.intercept('GET', '/guilds/:guildId', (_action, params) => ({ id: params.guildId, name: 'Stubbed' }));
```

By default, unmatched REST requests throw. Set
`createMockBot({ onUnhandledRest: 'warn' | 'silent' })` when a test intentionally
leans on the synthetic fallback shapes for unmodeled routes.

### Seeding a world

```ts
import { createMockBot, mockWorld } from '@slipher/testing';

const world = mockWorld();
const guild = world.registerGuild({ name: 'Slipher Lab' });
world.registerChannel(guild.id);
world.registerMember(guild.id, { nick: 'soc' });

await using bot = await createMockBot({ commands: [WhereCommand], world });
await bot.slash({ name: 'where', guildId: guild.id });
```

Entities are written into the real client cache (`CacheFrom.Test`), so
`ctx.guild()`, `ctx.channel()`, and related cache reads resolve like production
cache hits.

Seed **voice states** the same way for commands and middlewares that read
`member.voice()` (music, moderation, temp-voice bots):

```ts
const world = mockWorld();
const guild = world.registerGuild();
const channel = world.registerChannel(guild.id, { name: 'General' });
const member = world.registerMember(guild.id);
world.registerVoiceState(guild.id, { userId: member.user.id, channelId: channel.id });
```

`member.voice()` then resolves from the cache like a production hit. The mock
models voice **state** only — actual voice connections and audio are out of scope.

### Permissions

Bare dispatches stay permissive: the **bot's** `app_permissions` default to every
bit (`DEFAULT_PERMISSIONS`), so `botPermissions` guards pass. The **invoking
member** defaults to a non-admin set (`DEFAULT_MEMBER_PERMISSIONS`); pass
`memberPermissions: 'all'` for an admin invoker. Restrict a test explicitly to
trigger `onPermissionsFail` (member) or `onBotPermissionsFail` (bot):

```ts
await bot.slash({ name: 'ban', memberPermissions: [] });
await bot.slash({ name: 'ban', permissions: [] });
```

Use helpers for readable bitfields:

```ts
import { apiRole, permissionBits } from '@slipher/testing';

const mod = apiRole({ id: 'mod', permissions: permissionBits(['BanMembers']) });
await bot.slash({ name: 'ban', memberRoles: [mod] });
```

`memberRoles` also accepts minimal role objects. Missing `permissions` default to
`"0"`, so `{ id: 'viewer', name: 'Viewer' }` seeds membership without granting
extra permission bits.

For Discord-like permission tests, seed the world and dispatch as a registered
member. The mock computes `member.permissions` and `app_permissions` from
`@everyone`, member roles, the bot member, and channel overwrites:

```ts
const world = mockWorld();
const guild = world.registerGuild({
	id: 'guild',
	ownerId: 'owner-user', // apiGuild otherwise mints a random owner id
	everyonePermissions: ['SendMessages'],
});
const mod = world.registerRole(guild.id, { permissions: ['BanMembers'], position: 5 });
const member = world.registerMember(guild.id, { roles: [mod.id] });
const denied = world.registerChannel(guild.id, {
	overwrites: [{ id: mod.id, type: 'role', deny: ['BanMembers'] }],
});
world.registerBotMember(guild.id, { roles: [mod.id] });

await using bot = await createMockBot({ commands: [BanCommand], world });
await bot.slash({ name: 'ban', guildId: guild.id, channel: denied, user: member.user });
```

Role positions are written into Seyfert's role cache, so hierarchy checks can
read `client.cache.roles.values(guildId)` just like production. If a dispatch
targets a seeded guild with an unregistered user, the mock warns once; register
that user with `world.registerMember(...)` or pass explicit `memberPermissions`.

Once a bot member is seeded with `world.registerBotMember(...)`, moderation REST
routes (ban/kick/bulk-ban/edit-member/add-role/remove-role) enforce the bot's
computed guild permissions and role hierarchy, returning Discord's `403 50013`
just like production. Without a seeded bot member the routes stay permissive,
which is useful for unit-style tests that are not asserting bot authorization.
Seed the bot member whenever the permission contract matters.

Use `apiError()` to drive REST error branches:

```ts
bot.rest.intercept(Routes.ban, () => apiError(403, 50013, 'Missing Permissions'));
```

`MockApiError` is intentionally small; commands that branch on Seyfert's real
error classes should test that real parse path separately.

### Querying world state

Recorded actions prove calls happened. World state proves what the bot built:

```ts
const channel = bot.world.get.channel({ guildId: guild.id, name: 'acme-s1' });

expect(channel.lastMessage?.content).toContain('Welcome');
expect(channel.lastMessage?.component('Approve')).toMatchObject({ customId: 'approve' });
expect(channel.lastMessage?.embeds[0]).toMatchObject({
	title: 'Acme S1',
	fields: [{ name: 'Budget', value: '$5,000' }],
});
```

Use `get.*` when the entity must exist exactly once; it throws a
`WorldStateError` with candidate paths when nothing or too much matches. Use
`query.*` for optional reads, and `all.*` when the assertion is about a
collection:

```ts
expect(bot.world.query.member({ guildId: guild.id, userId: 'ghost' })).toBeUndefined();
expect(bot.world.all.message({ channelId: channel.id }).map(message => message.content)).toEqual([
	'edited',
	'followup',
]);
```

State includes seeded entities and writes made during the test: created
channels/threads, messages, interaction replies, edits, followups, DMs, bans,
role changes, timeouts, and channel overwrites. DMs are queryable by user:

```ts
expect(bot.world.query.dm({ userId: user.id })?.lastMessage?.content).toBe('Check your inbox');
```

Channels and roles also resolve by id alone — no guild id needed — mirroring how
Discord keys them. The role view carries `permissions` and `color`, not just identity:

```ts
expect(bot.world.query.channel({ id: channel.id })?.name).toBe('general');
expect(bot.world.query.role({ id: role.id })?.permissions).toBe('4'); // BanMembers
```

Seed message history with `registerMessage`; `bot.client.channels.fetchMessages()`
then returns newest-first without an interceptor:

```ts
world.registerMessage(channel.id, { content: 'old' });
world.registerMessage(channel.id, { content: 'new' });

expect(await bot.client.channels.fetchMessages(channel.id)).toMatchObject([
	{ content: 'new' },
	{ content: 'old' },
]);
```

Use `ChannelView.overwrites` for permission-matrix assertions. Direct replies
also remain available as `result.reply?.body.data` when the channel view is not
the clearest assertion surface.

### Outcome reader

Naive checks pass green when nothing happened — `expect(result.content).toContain('ok')`
is satisfied by `content` being `undefined`. Use the runner-agnostic outcome reader for
dispatch-level facts, and keep ordinary comparisons in your test runner:

```ts
import { outcome } from '@slipher/testing';

outcome(result).get.response(); // throws if the dispatch never responded
outcome(result).get.denial({ kind: 'permissions', missing: 'BanMembers' });
const { error } = outcome(result).get.error(/timeout/); // needs onCommandError: 'capture'
```

### Real-world recipes

```ts
import { Routes, apiUser, createMockBot, userOption } from '@slipher/testing';
import { expect, test } from 'vitest';
import { BanCommand } from '../../src/commands/ban';

test('/ban bans the target and confirms', async () => {
	await using bot = await createMockBot({ commands: [BanCommand] });
	const target = apiUser({ id: '42', username: 'spammer' });

	const result = await bot.slash({ name: 'ban',
		options: { user: userOption(target), reason: 'raid' },
	});

	expect(result.content).toBe('Banned spammer');
	const ban = await bot.waitForAction(Routes.ban);
	expect(ban.reason).toBe('raid');
});
```

Plugins go through `plugins`; their real `setup()` runs inside
`createMockBot()` and teardown runs on `bot.close()`:

```ts
const bot = await createMockBot({
	commands: [PingCommand],
	plugins: [myPlugin()],
});

await bot.close();
```

Bots with a **custom `Client`** (extra services like a Lavalink manager or a
database) attach fakes for anything the package doesn't model:

```ts
const bot = await createMockBot({ commands: [PlayCommand] });
Object.assign(bot.client, {
	manager: { getPlayer: () => ({ get: () => true, set: () => {} }), useable: true },
	database: { getPrefix: async () => '!' },
});
```

Commands read these via `ctx.client` by duck typing; the fakes only need the
methods the path under test touches. Audio/Lavalink playback itself is out of
scope — stub the manager, don't emulate it.

Simulate Discord **REST failures** to exercise your error handling. `fail`
throws a faithful `SeyfertError` (same `code`/`metadata` a production `catch`
sees), not a bespoke mock error:

```ts
import { DiscordErrors, Routes } from '@slipher/testing';

bot.rest.fail(Routes.ban, DiscordErrors.MissingPermissions); // 403 / 50013
bot.rest.fail(Routes.createMessage, { status: 429, retryAfter: 5 }); // raw shape
bot.rest.fail(Routes.ban, DiscordErrors.MissingAccess, { times: 1 }); // fail once, then normal
```

For sequential or request-conditional failures, use `bot.rest.intercept(...)`
with a closure.

### MockGateway

`createMockBot()` installs an in-process `MockGateway` where Seyfert expects its
gateway manager. It records presence updates and raw sends, exposes controllable
shards, and lets infra handlers exercise disconnect/reconnect hooks without a
WebSocket:

```ts
import { ActivityType, GatewayOpcodes, PresenceUpdateStatus } from 'seyfert/lib/types';

await using bot = await createMockBot({ shards: 3, shardLatency: 12 });

bot.client.gateway.setPresence({
	activities: [{ name: 'testing', type: ActivityType.Playing }],
	afk: false,
	since: null,
	status: PresenceUpdateStatus.Online,
});
await bot.client.gateway.send(0, { op: GatewayOpcodes.Heartbeat, d: null });
await bot.gateway.simulateDisconnect(0);

expect(bot.gateway.presences.at(-1)).toMatchObject({ status: PresenceUpdateStatus.Online });
expect([...bot.gateway.values()]).toHaveLength(3);
expect(bot.gateway.sent.at(-1)).toMatchObject({ shardId: 0 });
```

`MockGateway` is not a transport emulator; it only models the surface bots touch
in tests.

### Structuring a real suite

- Use one fresh bot per test by default. Boot is in-process and cheap, and state
  isolation comes free.
- Hand-pick classes for focused specs (`commands: [BanCommand]`). Use
  `loadFromConfig: true` or `commandsDir` for broad smoke specs, then inspect
  `registeredCommands()` or dispatch the command groups the spec cares about.
- Share fixtures as functions. `createMockBot` deep-clones the world, but
  module-level state in your command files still persists within a worker.
- Prefer `await using bot = ...`; use `afterEach(() => bot.close())` only when
  your runner or transpiler cannot handle explicit resource management.
- Parallel test files are safe because each worker owns fully in-process bots.

### Troubleshooting

- **"command X is not registered"** - check `@Declare({ name })`, the dispatch
  name, and `registeredCommands()` to see whether the file path was discovered
  and whether a command was found after import.
- **My collector never fires** - send a real message first, click as the same
  user, and avoid passing a stale `source`.
- **My modal flow hangs** - `waitFor` uses real timers; the usual cause is a
  different user between the opener dispatch and `fillModal()`.
- **`no interceptor or world entity matched GET ...`** - seed the world,
  `intercept()` the route, or set `onUnhandledRest: 'silent'` for that test.
- **Decorator/transform errors on `@Declare`** - enable
  `experimentalDecorators` in the test transform config.
- **Cache looks stale after `emit`** - emit full Discord event shapes, not
  partial patches.
- **Passes alone, fails in CI** - reset module-level state in your command files
  with `beforeEach`.

### Current defaults

The package is pre-1.0. Current defaults: the single default user
(`TEST_USER_ID`), strict `onUnhandledRest: 'error'`, opt-in REST fallback shapes
under `onUnhandledRest: 'warn' | 'silent'`, and newest-first message lists. An
unhandled error inside a command/component/modal/event handler **rejects the
`Dispatch` by default** (`onCommandError: 'throw'`);
pass `onCommandError: 'capture'` to surface it on `result.error` instead. The
read-only `bot.world` (`WorldStateReader`) is the supported way to assert on the
~20 entity types the views don't surface (pins, reactions, bans, webhooks,
emojis, invites, automod rules, scheduled events, poll voters, …).

During 0.x, prefer direct supported entry points over subclassing exported
classes: build bot tests through `createMockBot()`, seed worlds through
`mockWorld()`, and use named dispatchers such as `slash()`, `clickButton()`, and
`emit()`.
Unspecified and subject to change during 0.x: `mockId()` format, warning text,
`RecordedAction.seq`, and `MockGateway`.

### Scope

The mock bot is in-process and runner-agnostic: no WebSocket server, no fake
timers, no assertions. Discord-side behavior the world does not model is
simulated with `rest.intercept()`. Files ride along raw as `result.reply?.files`
and `action.files`, so attachment presence is asserted through the captured
reply or recorded action.
