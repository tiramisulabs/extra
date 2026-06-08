# @slipher/cooldown

Per-command cooldowns for Seyfert bots — declare them with decorators, get a rich result you can turn into a friendly retry message, and share buckets across commands.

## How it works

Declare a cooldown on a command (`@Cooldown.user(5_000)`, …). Before the command runs you check and consume it, getting a `CooldownResult` — allowed or not, how long is left, and why it was blocked — which you turn into a reply (often with `formatRemaining`).

Each cooldown is keyed by a **scope** (`user` / `guild` / `channel` / `global`, or a custom resolver) and stored in `client.cache`, so the backend is whatever cache adapter your bot already uses (in-memory, Redis, …). Commands that share a `group` share one bucket.

The manager is a single object, reachable as `ctx.cooldown` or `client.cooldown`.

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
			if (result.reason === 'over_capacity') {
				return ctx.write({ content: 'This command cannot consume that many cooldown tokens.' });
			}

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

Scoped shortcuts accept an `extras` argument as the third parameter:

```ts
@Cooldown.user(5_000, { default: 1 }, { group: 'moderation' })
```

`Cooldown.custom` receives `extras` as the fourth parameter because the first argument is the resolver:

```ts
@Cooldown.custom(
	ctx => `${ctx.guildId}:${ctx.author.id}`,
	5_000,
	{ default: 1 },
	{ group: 'moderation' },
)
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
	reason?: 'rate_limited' | 'over_capacity';
	remainingMs: number;     // 0 when allowed
	retryAfter: Date | null; // null when reason is 'over_capacity'
	limit: number;           // max tokens for the resolved variant
	remainingUses: number;   // tokens left after this call
	key: string;             // cache key, useful for logs and metrics
}
```

`reason` is only present when `allowed` is `false`.

- `rate_limited` means the bucket is temporarily empty. `remainingMs` is finite and `retryAfter` is a `Date`.
- `over_capacity` means the call asked for more tokens than the configured limit. It can never fit in this bucket, so `remainingMs` is `Infinity` and `retryAfter` is `null`.

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

If `use` references an unknown variant, the manager falls back to the `default` limit and emits a warning through `client.debugger`. This keeps the bucket rate-limited instead of writing `NaN` to cache.

For `type: 'guild'`, DMs fall back to `author.id` because there is no `guildId`. `ctx.cooldown.context()` returns `undefined` for component and modal interactions because the command resolver only runs for commands.

### Storage atomicity

`consume` is atomic when the cache adapter supports the Slipher Redis `eval` escape hatch. The default in-memory adapter is also safe for normal single-process usage because operations run synchronously on one event loop. Other adapters use the best-effort read-decide-write path.

| Adapter | Consume atomicity |
| --- | --- |
| Default memory adapter | Yes, single-process event-loop semantics |
| `@slipher/redis-adapter` | Yes, Lua script through `eval` |
| Worker / third-party adapters without `eval` | Best effort |

Only `consume` uses the Redis Lua path. `check`, `remaining`, and `reset` are regular cache reads/writes, so under Redis they can observe state that changes between calls when other workers are consuming the same bucket. Use `consume` as the authority for admission decisions; treat `check` and `remaining` as display/preview helpers.

## Shared Buckets (`group`)

Commands that share a `group` share the same cache key. The key is built as `${group ?? resolvedCommandName}:${typeLabel}:${target}`, so different commands in the same group hit one bucket per target.

```ts
@Cooldown.user(5_000, { default: 1 }, { group: 'moderation' })
class BanCommand extends Command { /* ... */ }

@Cooldown.user(5_000, { default: 1 }, { group: 'moderation' })
class KickCommand extends Command { /* ... */ }
```

A user that runs `/ban` cannot immediately run `/kick`; both are gated by the same `moderation:user:<userId>` bucket.

`group` is only the cache namespace after a cooldown has been resolved; it does not make subcommands inherit cooldowns. For a command with subcommands, the manager resolves cooldown data as `subcommand.cooldown ?? parent.cooldown`. Put the decorator on the parent when every subcommand should be gated, or put it on individual subcommands when only some should be gated:

```ts
@Declare({ name: 'daily', description: 'Daily rewards' })
@Cooldown.user(86_400_000, { default: 1 })
class DailyCommand extends Command { /* claim/status subcommands */ }
```

In that shape, `/daily claim` and `/daily status` both inherit the parent cooldown. If only `claim` should be limited, assign `cooldown` to that subcommand instead of the parent.

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

To share a custom resolver bucket with other commands, pass `group` through the fourth `extras` argument:

```ts
@Cooldown.custom(
	ctx => `${ctx.guildId}:${ctx.author.id}`,
	30_000,
	{ default: 2 },
	{ group: 'heavy' },
)
class HeavyCommand extends Command { /* ... */ }
```

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

