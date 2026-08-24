# @slipher/testing

Runner-agnostic fixtures and an in-process mock bot for testing Seyfert commands, interactions, events, middleware, plugins, and REST effects without connecting to Discord.

**[Read the complete Testing guide on seyfert.dev](https://seyfert.dev/docs/testing).**

## Install

```sh
pnpm add -D @slipher/testing
```

Requires Seyfert v5 and works with the test runner of your choice.

## Quick start

```ts
import { mockCommandContext } from '@slipher/testing';
import { expect, test } from 'vitest';
import PingCommand from './commands/ping';

test('replies with pong', async () => {
	const ctx = mockCommandContext(PingCommand);

	await ctx.run();

	expect(ctx.lastResponse()).toMatchObject({ content: 'Pong!' });
});
```

Use fixtures for isolated handler bodies. Use `createMockBot()` when the test needs Seyfert option parsing, middleware, permissions, components, modals, events, collectors, or captured REST calls.
