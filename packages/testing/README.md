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

## Bot identity

`world.botUser({ id?, username?, globalName?, avatar? })` configures the bot's user and returns it, so seeded messages can use it as author. The same profile is used for `client.me`, the bot's guild members, and every message the bot sends. `createMockBot({ botUser })` does the same without a world.

```ts
const world = mockWorld();
const botUser = world.botUser({ username: 'my-bot' });
const guild = world.registerGuild();
const channel = world.registerChannel(guild.id);
world.registerBotMember(guild.id);
world.registerMessage(channel.id, { author: botUser, content: 'Ready' });
const bot = await createMockBot({ world });
```

## Observe a running bot

- `bot.observe(listener)` streams REST requests, dispatches, world diffs, and pending interaction changes. It returns an unsubscribe function.
- `bot.conversation({ userId, channelId })` returns what that user can see: channel permissions and overwrites apply, ephemeral messages are shown only to their owner, and without `ReadMessageHistory` only messages received while the user had access are visible. `bot.inspectChannel(channelId)` returns every message, including hidden and deleted ones.
- `bot.pendingInteractions()` lists open modals and live component collectors. `await bot.commandSchemas()` returns the full JSON of every registered command, loading deferred commands first.
- `await bot.admin.addMemberRole({ guildId, userId, roleId })` and `removeMemberRole(...)` simulate a role change made outside the bot, dispatching `GUILD_MEMBER_UPDATE`. They ignore the bot's own permissions.
