# @slipher/cooldown

Per-command cooldowns for Seyfert bots, with decorator, middleware, and manager APIs.

**[Read the complete Cooldown guide on seyfert.dev](https://seyfert.dev/docs/plugins/official/cooldown).**

## Install

```sh
pnpm add @slipher/cooldown
```

Requires Seyfert v5. Cooldown storage uses the cache adapter configured on the client.

## Quick start

```ts
import { Cooldown, cooldown } from '@slipher/cooldown';
import { Client, Command, Declare, definePlugins, type CommandContext } from 'seyfert';

const plugins = definePlugins(cooldown({ middleware: true }));

declare module 'seyfert' {
	interface SeyfertRegistry {
		plugins: typeof plugins;
	}
}

export const client = new Client({ plugins });

@Declare({ name: 'ping', description: 'Ping' })
@Cooldown.user(5_000)
export default class PingCommand extends Command {
	async run(ctx: CommandContext) {
		await ctx.write({ content: 'Pong!' });
	}
}
```

For bots sharing cooldown state across processes, use a cache adapter that explicitly implements `AtomicCooldownAdapter`. `@slipher/redis-adapter` provides that integration starting in v0.0.8; `ExpirableRedisAdapter` intentionally does not.
