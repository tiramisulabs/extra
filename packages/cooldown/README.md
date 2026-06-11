# @slipher/cooldown

Per-command cooldowns for Seyfert bots. Declare a cooldown with a decorator, let the optional middleware gate commands, or call the manager directly when you need custom behavior.

## Install

```sh
pnpm add @slipher/cooldown
```

Requires Seyfert v5.

## Setup

```ts
import { Client, definePlugins, type RegisterPlugins } from 'seyfert';
import { cooldown } from '@slipher/cooldown';

const plugins = definePlugins(
	cooldown({
		middleware: true,
	}),
);

const client = new Client({ plugins });

declare module 'seyfert' {
	interface Register extends RegisterPlugins<typeof plugins> {}
}
```

The plugin exposes one `CooldownManager` as `client.cooldown` and `ctx.cooldown`. Storage is backed by `client.cache`.

## Middleware First

The middleware is the simplest path for command cooldowns:

```ts
import { Command, type CommandContext, Declare } from 'seyfert';
import { Cooldown } from '@slipher/cooldown';

@Declare({ name: 'ping', description: 'Ping' })
@Cooldown.user(5_000)
export default class PingCommand extends Command {
	async run(ctx: CommandContext) {
		await ctx.write({ content: 'Pong!' });
	}
}
```

With `cooldown({ middleware: true })`, the plugin registers the default `cooldown` middleware at runtime and contributes its type through Seyfert's plugin registry. Use the default name when assigning it explicitly:

```ts
import { Middlewares } from 'seyfert';

@Middlewares(['cooldown'])
@Cooldown.user(5_000)
class PingCommand extends Command {}
```

When the middleware allows a command, it calls `next(result)`. With the default middleware name, commands can read the result from `ctx.metadata.cooldown`.

Customize denied messages with `middleware.message`:

```ts
const plugins = definePlugins(
	cooldown({
		middleware: {
			global: true,
			message: (result, ctx) => `${ctx.author.username}, try again in ${Math.ceil(result.remainingMs / 1000)}s.`,
		},
	}),
);
```

If you configure the middleware with an options object, the runtime middleware is still registered, but the plugin does not infer the middleware type automatically. Add the name to your app types:

```ts
import type { CooldownMiddlewares } from '@slipher/cooldown';

declare module 'seyfert' {
	interface RegisteredMiddlewares extends CooldownMiddlewares<'cooldown'> {}
}
```

```ts
const plugins = definePlugins(
	cooldown({
		middleware: { global: true },
	}),
);
```

Use the same helper for custom names:

```ts
declare module 'seyfert' {
	interface RegisteredMiddlewares extends CooldownMiddlewares<'commandCooldown'> {}
}

const plugins = definePlugins(
	cooldown({
		middleware: { name: 'commandCooldown' },
	}),
);
```

## Declaring Cooldowns

Use the shortcut that matches the bucket scope:

```ts
@Cooldown.user(5_000) // 1 use per user every 5s
@Cooldown.guild(60_000, { uses: 5 })
@Cooldown.channel(10_000)
@Cooldown.global(1_000)
@Cooldown.custom(ctx => `${ctx.guildId}:${ctx.author.id}`, 30_000, { group: 'heavy' })
```

Or use the raw decorator when all fields should be visible:

```ts
@Cooldown({
	type: 'user',
	interval: 5_000,
	uses: 3,
	group: 'moderation',
})
class BanCommand extends Command {}
```

`type` defaults to `user`. `uses` defaults to `1`. `group` makes multiple commands share the same bucket.

```ts
interface CooldownProps {
	type?: 'user' | 'guild' | 'channel' | 'global' | ((ctx: AnyContext) => string | undefined);
	interval: number;
	uses?: number;
	group?: string;
}
```

For `guild` and `channel` scopes, DMs fall back to `author.id` because Discord may not provide `guildId` or `channelId` for every interaction. Custom target resolvers can return `undefined` to skip cooldowns for that invocation.

Tiered limits such as premium users getting more uses are intentionally not part of the 1.0 surface. The likely future shape is additive: `uses?: number | ((ctx) => number)`.

## Manual Manager API

Inside a command, the zero-arg form resolves the active command, target, and guild from Seyfert's context scope:

```ts
const result = await ctx.cooldown.consume();

if (result && !result.allowed) {
	return ctx.write({
		content: `Try again in ${Math.ceil(result.remainingMs / 1000)}s.`,
	});
}
```

Use explicit options outside a command, in admin commands, or in tests:

```ts
await client.cooldown?.check({ name: 'ping', target: userId, guildId });
await client.cooldown?.consume({ name: 'ping', target: userId, guildId, cost: 2 });
await client.cooldown?.reset({ name: 'ping', target: userId, guildId });
```

`check` previews the result without mutating the bucket. `consume` decrements the bucket. `reset` deletes the bucket and returns `false` when the command has no cooldown.

Calling the zero-arg form outside a Seyfert handler throws. Use the explicit form there.

## CooldownResult

`check` and `consume` return `undefined` when the command resolves to no cooldown.

```ts
type CooldownResult =
	| {
			allowed: true;
			remainingMs: 0;
			retryAfter: Date;
			limit: number;
			remainingUses: number;
			key: string;
	  }
	| {
			allowed: false;
			remainingMs: number;
			retryAfter: Date;
			limit: number;
			remainingUses: number;
			key: string;
	  };
```

Asking for a `cost` higher than the bucket limit is a programmer error and throws `RangeError`.

## Shared Buckets

Commands that share a `group` share the same cache key. The key shape is `${group ?? resolvedCommandName}:${typeLabel}:${target}`.

```ts
@Cooldown.user(5_000, { group: 'moderation' })
class BanCommand extends Command {}

@Cooldown.user(5_000, { group: 'moderation' })
class KickCommand extends Command {}
```

A user that runs `/ban` cannot immediately run `/kick`; both commands consume `moderation:user:<userId>`.

`group` only changes the bucket namespace after a cooldown is resolved. It does not make subcommands inherit cooldowns. For subcommands, the manager uses `subcommand.cooldown ?? parent.cooldown`.

## Storage Atomicity

`consume` is atomic when the cache adapter explicitly opts in to `AtomicCooldownAdapter` with `supportsAtomicCooldowns: true` and a Redis-compatible `eval(script, keys, args)` method. Adapters that merely expose `eval` without the opt-in marker use the regular read-decide-write path.

The Redis script uses Redis `TIME` as its clock source and the resource key constants from this package. `ExpirableRedisAdapter` deliberately does not opt in because its TTL and relationship bookkeeping are adapter-specific.

Only `consume` uses the atomic path. `check` and `reset` remain regular cache operations, so use `consume` as the admission authority in multi-worker bots.
