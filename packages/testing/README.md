# @slipher/testing

Runner-agnostic fixtures for testing Seyfert bots and Slipher plugins.

## How it works

The package is plain mock objects — no assertions, spies, or fake timers bundled — so they work with any test runner. The core is `mockCommandContext()`: a stand-in for a Seyfert command context with the fields most commands touch, plus working Slipher stubs (`logger`, `queues`, `scheduler`) that **record what your command does** so you can assert on it afterward. Factories (`mockUser`, `mockGuild`, …) build the entities, with deterministic ids you can override.

## Install

```sh
pnpm add -D @slipher/testing
```

Requires Seyfert v5.

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
