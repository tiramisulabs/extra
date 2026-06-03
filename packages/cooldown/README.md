# @slipher/cooldown

Per-command cooldowns for Seyfert bots. Ships a Seyfert plugin, a `CooldownManager` on `ctx.cooldown` and `client.cooldown`, rich `CooldownResult` values, decorator shortcuts, custom target resolvers, shared buckets across commands, and a `formatRemaining` helper with text and Discord timestamp output.

## Install

```sh
pnpm add @slipher/cooldown
```

## Plugin Setup

```ts
import { Client } from 'seyfert';
import { cooldown } from '@slipher/cooldown';

const client = new Client({
	plugins: [cooldown()],
});
```

The plugin attaches a `CooldownManager` to the client (`client.cooldown`) and exposes it on every interaction context (`ctx.cooldown`). Storage is backed by `client.cache`.

## Declaring a Cooldown

The simplest way is the `@Cooldown` class decorator, with typed shortcuts per scope.

```ts
import { Command, CommandContext, Declare } from 'seyfert';
import { Cooldown, formatRemaining } from '@slipher/cooldown';

@Declare({ name: 'ping', description: 'Ping' })
@Cooldown.user(5_000) // 5s per user, 1 use
export default class PingCommand extends Command {
	async run(ctx: CommandContext) {
		const result = await ctx.cooldown.context(ctx);

		if (result && !result.allowed) {
			return ctx.write({
				content: `Try again ${formatRemaining(result.retryAfter, { style: 'discord' })}.`,
			});
		}

		await ctx.write({ content: 'Pong!' });
	}
}
```

### Decorator shortcuts

```ts
@Cooldown.user(5_000)                     // type: 'user', uses: { default: 1 }
@Cooldown.guild(60_000, { default: 5 })   // type: 'guild', custom uses
@Cooldown.channel(10_000)                 // type: 'channel'
@Cooldown.global(1_000)                   // type: 'global' — single bucket for the whole bot
@Cooldown.custom(ctx => `${ctx.guildId}:${ctx.author.id}`, 5_000)
```

All shortcuts accept an `extras` argument for advanced features:

```ts
@Cooldown.user(5_000, { default: 1 }, { group: 'moderation' })
```

### Raw decorator

`@Cooldown(props)` accepts a full `CooldownProps` if you need every field at once:

```ts
@Cooldown({
	type: 'user',
	interval: 5_000,
	uses: { default: 3 },
	group: 'moderation',
})
```

## CooldownProps

```ts
interface CooldownProps {
	type?: 'user' | 'guild' | 'channel' | 'global' | ((ctx: AnyContext) => string | undefined);
	interval: number;        // ms before the bucket refills
	uses: { default: number; [variant: string]: number };
	group?: string;          // shared bucket — see below
}
```

`type` defaults to `'user'` when omitted. When `type` is a function, the manager calls it with the active context to resolve a string target. Returning `undefined` skips the cooldown for that invocation.

## CooldownResult

Every state-changing call returns a `CooldownResult`. Methods return `undefined` when the command resolves to no cooldown.

```ts
interface CooldownResult {
	allowed: boolean;
	remainingMs: number;     // 0 when allowed
	retryAfter: Date;        // absolute timestamp at which the bucket frees
	limit: number;           // max tokens for the resolved variant
	remainingUses: number;   // tokens left after this call
	key: string;             // cache key, useful for logs and metrics
}
```

## Manager API

```ts
ctx.cooldown.context(ctx);                              // resolve target, consume, return result
ctx.cooldown.check({ name: 'ping', target: ctx.author.id });
ctx.cooldown.consume({ name: 'ping', target: ctx.author.id });
ctx.cooldown.remaining({ name: 'ping', target: ctx.author.id });
ctx.cooldown.reset('ping', ctx.author.id);
```

- `check` is read-only: it peeks at the bucket and returns the result that a `consume` *would* produce, without mutating state.
- `consume` decrements the bucket. Returns `allowed: false` instead of mutating when the bucket is empty or `tokens` exceeds `limit`.
- `remaining` is a thin wrapper that returns just the milliseconds left (or 0).
- `reset` clears the bucket for a target. Returns `false` when no cooldown is configured.
- `context` resolves the target from the active interaction context (using `type`), then calls `consume`.

Both `check` and `consume` accept an optional `tokens?: number` to model multi-token consumption.

## Shared Buckets (`group`)

Commands that share a `group` share the same cache key. The key is built as `${group ?? resolvedCommandName}:${typeLabel}:${target}`, so different commands in the same group hit one bucket per target.

```ts
@Cooldown.user(5_000, { default: 1 }, { group: 'moderation' })
class BanCommand extends Command { /* ... */ }

@Cooldown.user(5_000, { default: 1 }, { group: 'moderation' })
class KickCommand extends Command { /* ... */ }
```

A user that runs `/ban` cannot immediately run `/kick`; both are gated by the same `moderation:user:<userId>` bucket.

## Custom Target Resolvers

When the built-in scopes are not enough, pass a resolver as `type`:

```ts
@Cooldown.custom(
	ctx => (ctx.member?.premium ? `premium:${ctx.author.id}` : `free:${ctx.author.id}`),
	30_000,
)
class HeavyCommand extends Command { /* ... */ }
```

The resolved string is used verbatim as the target portion of the cache key. The type label in the key is `custom`. Returning `undefined` skips the cooldown.

## `formatRemaining` Helper

```ts
import { formatRemaining } from '@slipher/cooldown';
import { TimestampStyle } from 'seyfert';
```

### Text mode (default)

```ts
formatRemaining(5_000)                // "5s"
formatRemaining(90_000)               // "1m 30s"
formatRemaining(3_660_000)            // "1h 1m"
formatRemaining(result.remainingMs)   // relative to now()
formatRemaining(result.retryAfter)    // accepts Date
```

### Discord mode

Discord mode uses Seyfert's `Formatter.timestamp` under the hood and accepts the `TimestampStyle` enum. Default style is `TimestampStyle.RelativeTime` (`R`), the natural choice for cooldown messages.

```ts
formatRemaining(result.retryAfter, { style: 'discord' });
// "<t:1717372805:R>"

formatRemaining(result.retryAfter, {
	style: 'discord',
	discordStyle: TimestampStyle.ShortTime,
});
// "<t:1717372805:t>"
```

### Idiomatic command reply

```ts
const result = await ctx.cooldown.context(ctx);
if (result && !result.allowed) {
	return ctx.write({
		content: `Wait ${formatRemaining(result.retryAfter, { style: 'discord' })} before reusing this command.`,
	});
}
```

## Programmatic Usage

If you do not want the plugin, build the manager yourself:

```ts
import { CooldownManager } from '@slipher/cooldown';

const manager = new CooldownManager(client);
```

Or detach plugin construction from attach time:

```ts
import { createCooldown, installCooldown } from '@slipher/cooldown';

const manager = createCooldown();
installCooldown(client, manager);
```

## Development

```sh
pnpm --filter @slipher/cooldown test
pnpm --filter @slipher/cooldown build
```
