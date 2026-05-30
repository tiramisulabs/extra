# @slipher/testing

Runner-agnostic fixtures for testing Seyfert bots and Slipher plugins.

## Install

```sh
pnpm add -D @slipher/testing
```

## Mock Command Contexts

```ts
import { mockCommandContext, mockUser } from '@slipher/testing';
import { expect, test } from 'vitest';

test('command replies', async () => {
	const ctx = mockCommandContext({
		commandName: 'ban',
		options: { user: mockUser({ id: '123' }) },
	});

	await command.run(ctx as never);

	expect(ctx.responses.at(-1)).toMatchObject({ content: expect.stringContaining('Banned') });
});
```

`mockCommandContext()` includes:

- `author`, `user`, `guild`, `channel`, and `member`
- `options` and `metadata`
- `write`, `editOrReply`, `followup`, and `deferReply`
- `logger`, `queues`, and `scheduler` stubs
- `responses`, `lastResponse()`, and `clearResponses()`

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
await ctx.queues.get('welcome').add({ userId: ctx.author.id });
ctx.scheduler.add('reminder', '30m', () => undefined);

expect(ctx.logger.entries).toHaveLength(1);
expect(ctx.queues.get('welcome').jobs).toHaveLength(1);
expect(ctx.scheduler.tasks).toHaveLength(1);
```

## Implementation Notes

- No assertions, fake timers, or spies are bundled. Use the test runner you already have.
- Generated IDs can be overridden on every factory.
- Mock queue and scheduler stubs record intent; they do not run background workers.

## Development

```sh
pnpm --filter @slipher/testing test
pnpm --filter @slipher/testing build
```
