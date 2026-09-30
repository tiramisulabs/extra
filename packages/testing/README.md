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

`WorldBuilder.botUser({ id?, username?, globalName?, avatar? })` configures and returns the one bot user. Use it as the author of seeded bot messages; the same profile reaches `client.me`, guild members, REST messages, interaction replies, and `bot.world.snapshot().botUser`. When only `username` is set, `global_name` uses that username.

```ts
const world = mockWorld();
const botUser = world.botUser({ username: 'support-bot', globalName: 'Support Bot' });
const guild = world.registerGuild();
const channel = world.registerChannel(guild.id);
world.registerBotMember(guild.id);
world.registerMessage(channel.id, { author: botUser, content: 'Ready' });
const bot = await createMockBot({ world });
```

`createMockBot({ botUser: { ... } })` configures the same profile without a world. Existing `botId` and `registerBotMember({ botId })` still work; contradictory IDs throw. With no profile, the bot is `slipher-test-bot` / `Slipher Test Bot` at `TEST_BOT_ID`. Generic `apiUser()` remains a human fixture with its existing defaults.

## Inspect a running flow

`bot.observe(listener)` streams REST request and settlement, dispatch start and end, world diffs, and pending interaction changes. It returns an unsubscribe function. Observer exceptions are reported as warnings and do not stop the bot.

`bot.conversation({ userId, channelId })` returns the messages visible to that actor. Guild visibility uses current `ViewChannel` and `ReadMessageHistory` permissions with roles, channel overwrites, owner, and administrator rules. Without history permission, an actor sees only messages they received live while connected with channel access, plus their own ephemeral messages. Seeded messages precede the initial connection; joining members connect when they join. `bot.connect(userId)` moves one actor's connection point to the current message sequence without erasing earlier receipts. Switching the viewed actor does not reconnect anyone. A fresh bot starts a fresh session; `bot.reset()` keeps the world and receipts. A view reports `history-hidden:N` only when it hides N messages. Bot REST lists return `[]` without `ReadMessageHistory`; a single-message read requires both permissions, and voice channel reads also require `Connect`.

Ephemeral replies and followups are visible only to their interaction owner. A deferred reply has the `Loading` flag until its original response is edited; editing preserves its ephemeral state. The first followup after a deferred reply edits that original response, and later followups create messages. Seeded ephemeral messages can declare `ownerId` with `world.registerMessage(channelId, { flags: MessageFlags.Ephemeral, ownerId, ... })`. Without an owner, `conversation` hides them and reports `ephemeral-owner-unknown:N-hidden`. `bot.inspectChannel(channelId)` includes all messages, with owner, creation sequence, live recipient IDs, initial-history status, and deletion metadata. `rendered(actor)` still reads only the latest stateful step. This deterministic receipt model is not a complete Discord gateway. The `@slipher/lab` session layer uses `conversation` to enforce channel access for actions.

`bot.pendingInteractions()` lists open modals with their exact callback payload and live component collectors. `await bot.commandSchemas()` returns Seyfert's complete command JSON, including options, subcommands and choices. It imports deferred `commandsDir` / `loadFromConfig` commands before returning, so callers must await it.

`await bot.admin.addMemberRole({ guildId, userId, roleId })` and `removeMemberRole(...)` simulate an external role change through `GUILD_MEMBER_UPDATE`. They validate the seeded guild, member and role; update the world and Seyfert cache; and run any registered event handler. They do not use the bot's REST permissions, so they can grant a role to the bot before testing its own REST actions.
