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
	await command.run(ctx as never);

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
	const bot = await createMockBot({ commands: [GreetCommand] });
	const result = await bot.slash({ name: 'greet', options: { name: 'slipher' } });

	expect(result.content).toBe('Hello, slipher!');
	await bot.close();
});
```

The raw interaction response stays available as `result.reply?.body` (`{ type, data }`)
for the rare assertion where the Discord wire shape itself is the contract. Prefer
`result.content`, `result.deferred`, and `result.edits` for normal behavior checks.

`createMockBot()` accepts:

- `commands`, `components`, `events` - your real classes, registered programmatically
- `middlewares` - same record you would pass to `client.setServices`
- `world` - entities to seed into the client cache
- `clientOptions` - forwarded to the Seyfert `Client` constructor, including plugins
- `botId`, `applicationId`

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

### Dispatching

```ts
await bot.slash({ name: 'admin', group: 'users', subcommand: 'kick', options: { reason: 'spam' } });
await bot.fillModal('feedback', { rating: '5' });
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

const bot = await createMockBot({ commands: [WhereCommand], world });
await bot.slash({ name: 'where', guildId: guild.id });
```

Entities are written into the real client cache (`CacheFrom.Test`), so
`ctx.guild()`, `ctx.channel()`, and related cache reads resolve like production
cache hits.

### Real-world recipes

```ts
import { Routes, apiUser, createMockBot, userOption } from '@slipher/testing';
import { expect, test } from 'vitest';
import { BanCommand } from '../../src/commands/ban';

test('/ban bans the target and confirms', async () => {
	const bot = await createMockBot({ commands: [BanCommand] });
	const target = apiUser({ id: '42', username: 'spammer' });

	const result = await bot.slash({
		name: 'ban',
		options: { user: userOption(target), reason: 'raid' },
	});

	expect(result.content).toBe('Banned spammer');
	const ban = await bot.waitForAction(Routes.ban);
	expect(ban.reason).toBe('raid');
	await bot.close();
});
```

Plugins go through `clientOptions`; their real `setup()` runs inside
`createMockBot()` and teardown runs on `bot.close()`:

```ts
const bot = await createMockBot({
	commands: [PingCommand],
	clientOptions: { plugins: [myPlugin()] },
});
```

### Scope

The mock bot is in-process and runner-agnostic: no WebSocket server, no fake
timers, no assertions. Discord-side behavior the world does not model is
simulated with `rest.intercept()`. Files ride along raw as `result.reply?.files`
and `action.files`, so attachment presence is asserted through the captured
reply or recorded action.
