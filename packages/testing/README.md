# @slipher/testing

Runner-agnostic testing for Seyfert bots and Slipher plugins, in two layers behind a single import:

- **Fixtures** - plain mock objects (`mockCommandContext`, factories, stubs) for fast unit tests of a `run()` body in isolation.
- **Mock bot** - boots a real Seyfert client in-process (no token, no gateway, no network) so you can test any part of the bot - commands, components, modals, events, middlewares, plugins - by dispatching raw payloads through the real pipeline and asserting on every REST call the bot makes, without ever talking to Discord.

Rule of thumb: pure `run()` logic -> fixtures; anything touching option parsing,
middlewares, permissions, components, REST, or events -> mock bot. Both come
from the same import and coexist in one suite - existing fixture tests need no
changes.

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

test('command replies', async () => {
	const ctx = mockCommandContext<{ user: ReturnType<typeof mockUser> }>({
		commandName: 'ban',
		options: { user: mockUser({ id: '123' }) },
	});

	// MockCommandContext models the Seyfert fields most command tests touch, but
	// it is intentionally not a full CommandContext implementation.
	const run = async (context: typeof ctx) => {
		await context.write({ content: `Banned ${context.options.user.id}` });
	};
	await run(ctx);

	expect(ctx.responses.at(-1)).toMatchObject({ content: expect.stringContaining('Banned') });
});
```

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

The raw interaction response stays available as `result.reply?.body` (`{ type, data }`)
for the rare assertion where the Discord wire shape itself is the contract. Prefer
`result.content`, `result.deferred`, and `result.edits` for normal behavior checks.

`createMockBot()` accepts:

- `commands`, `components`, `events` - your real classes, registered programmatically
- `middlewares` - same record you would pass to `client.setServices`
- `globalMiddlewares` - forwarded to Seyfert's global middleware hooks
- `world` - entities to seed into the client cache
- `simulateGateway` - emit matching member update/remove events for stateful writes; defaults to `true`
- `onUnhandledRest` - warn, throw, or stay silent for unmatched shape fallback reads
- `clientOptions` - forwarded to the Seyfert `Client` constructor, including plugins
- `loadFromConfig`, `commandsDir`, `componentsDir`, `eventsDir`, `langsDir` - load the real bot through Seyfert's loaders
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

### Execution model

Every dispatcher returns a lazy `Dispatch`. Await it directly for one-shot runs, or
call `dispatch.until(Routes.ban)` / `dispatch.untilModal()` first to step through
the same dispatch. Awaiting always releases any active checkpoint, so it cannot
deadlock.

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
| `await emitEvent(...)` | REST work the handler awaited |
| nothing | only `waitForAction(...)` observes fire-and-forget work |

### Step-by-step flows

The mock bot is long-lived: cache, collectors, plugin state, cooldowns, and
world mutations persist across dispatches. Bind an identity once with
`bot.actor()` instead of repeating `user`, `guildId`, and `channel` on every
call:

```ts
await using bot = await createMockBot({ commands: [PurgeCommand], world: world.build() });
const alice = bot.actor({ member: aliceMember, guildId: guild.id, channel });

await alice.slash({ name: 'poll' });
await alice.clickButton('poll/yes');
await bot.emitEvent('GUILD_MEMBER_ADD', newMember);
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
await bot.emitEvent('GUILD_MEMBER_ADD', rawMemberPayload);
```

Every dispatch defaults to the bot's single test user (`bot.defaultUser`), so
cross-dispatch state such as cooldowns, waiting modals, and per-user collectors
correlates automatically. Pin `guildId` for state that must persist per guild.

Primitive option values are encoded automatically. For entity options use the
explicit helpers, which also populate `resolved` data:

```ts
import { apiUser, userOption } from '@slipher/testing';

await bot.slash({
	name: 'ban',
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

App-level `DefaultLocale` augmentation works unchanged; the mock only feeds the
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

Awaited modal flows must keep the opener dispatch alive, because
`interaction.modal(..., { waitFor })` resumes inside the opener after the submit:

```ts
const dispatch = bot.clickButton('open-feedback', { user });
await dispatch.untilModal();
const modal = await bot.fillModal('feedback-modal', { rating: '5' }, { user });
await dispatch;

expect(modal.content).toBe('thanks');
```

Use the same `user` for the opener and `fillModal()`. Collector `idle`/`timeout`
and modal `waitFor` options use real timers, so keep them short in tests.

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

Unstubbed `POST`/`PATCH` requests answer with a message-shaped echo of the body.
Unstubbed collection `GET`s answer with the empty collection shape. Other unmatched
`GET`s warn by default because unseeded reads are where mock tests lie; tune with
`createMockBot({ onUnhandledRest: 'error' | 'silent' })`.

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

Bare dispatches stay permissive: `DEFAULT_PERMISSIONS` includes every bit,
including `Administrator`, so Seyfert skips missing-permission paths. Restrict a
test explicitly when you want `onPermissionsFail` or `onBotPermissionsFail`:

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

Use `apiError()` to drive REST error branches:

```ts
bot.rest.intercept(Routes.ban, () => apiError(403, 50013, 'Missing Permissions'));
```

`MockApiError` is intentionally small; commands that branch on Seyfert's real
error classes should test that real parse path separately.

### Querying world state

Recorded actions prove calls happened. World state proves what the bot built:

```ts
const channel = bot.cachedGuild(guild.id)?.channel('acme-s1');

expect(channel?.lastMessage?.content).toContain('Welcome');
expect(channel?.lastMessage?.button('Approve')).toMatchObject({ customId: 'approve' });
expect(channel?.lastMessage?.embeds[0]).toMatchObject({
	title: 'Acme S1',
	fields: [{ name: 'Budget', value: '$5,000' }],
});
```

State includes seeded entities and writes made during the test: created
channels/threads, messages, interaction replies, edits, followups, DMs, bans,
role changes, timeouts, and channel overwrites. DMs are queryable by user:

```ts
expect(bot.cachedDm(user.id)?.lastMessage?.content).toBe('Check your inbox');
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

### Real-world recipes

```ts
import { Routes, apiUser, createMockBot, userOption } from '@slipher/testing';
import { expect, test } from 'vitest';
import { BanCommand } from '../../src/commands/ban';

test('/ban bans the target and confirms', async () => {
	await using bot = await createMockBot({ commands: [BanCommand] });
	const target = apiUser({ id: '42', username: 'spammer' });

	const result = await bot.slash({
		name: 'ban',
		options: { user: userOption(target), reason: 'raid' },
	});

	expect(result.content).toBe('Banned spammer');
	const ban = await bot.waitForAction(Routes.ban);
	expect(ban.reason).toBe('raid');
});
```

Plugins go through `clientOptions`; their real `setup()` runs inside
`createMockBot()` and teardown runs on `bot.close()`:

```ts
const bot = await createMockBot({
	commands: [PingCommand],
	clientOptions: { plugins: [myPlugin()] },
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
- Hand-pick classes for focused specs (`commands: [BanCommand]`). Reserve
  `loadFromConfig: true` for broad smoke specs such as "every command registers".
- Share fixtures as functions. `createMockBot` deep-clones the world, but
  module-level state in your command files still persists within a worker.
- Prefer `await using bot = ...`; use `afterEach(() => bot.close())` only when
  your runner or transpiler cannot handle explicit resource management.
- Parallel test files are safe because each worker owns fully in-process bots.

### Troubleshooting

- **"command X is not registered"** - check `@Declare({ name })`, the dispatch
  name, and whether the class reached `commands` or compiled `loadFromConfig`
  output.
- **My collector never fires** - send a real message first, click as the same
  user, and avoid passing a stale `source`.
- **My modal flow hangs** - `waitFor` uses real timers; the usual cause is a
  different user between the opener dispatch and `fillModal()`.
- **`no interceptor or world entity matched GET ...`** - seed the world,
  `intercept()` the route, or set `onUnhandledRest: 'silent'` for that test.
- **Decorator/transform errors on `@Declare`** - enable
  `experimentalDecorators` in the test transform config.
- **Cache looks stale after `emitEvent`** - emit full Discord event shapes, not
  partial patches.
- **Passes alone, fails in CI** - reset module-level state in your command files
  with `beforeEach`.

### Stability

Stable across minor versions: the single default user (`TEST_USER_ID`),
`onUnhandledRest` defaulting to `'warn'`, empty collection GET fallbacks,
newest-first message lists, route-id echoing for message fallbacks, and command
errors flowing through Seyfert hooks instead of rejecting `Dispatch`.

Options bags only gain optional fields. Build tests through `createMockBot()` and
`mockWorld()` rather than subclassing exported classes. Unspecified and subject
to change during 0.x: `mockId()` format, warning text, `RecordedAction.seq`,
`MockGateway`, and raw `bot.state` internals.

### Scope

The mock bot is in-process and runner-agnostic: no WebSocket server, no fake
timers, no assertions. Discord-side behavior the world does not model is
simulated with `rest.intercept()`. Files ride along raw as `result.reply?.files`
and `action.files`, so attachment presence is asserted through the captured
reply or recorded action.
