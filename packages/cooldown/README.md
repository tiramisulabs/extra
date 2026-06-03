# @slipher/cooldown

Per-command cooldowns for Seyfert bots. The package gives you a Seyfert plugin, a `CooldownManager` on `ctx.cooldown` and `client.cooldown`, a `@Cooldown` class decorator and a `cooldown` field on every `Command`, `SubCommand`, `ContextMenuCommand` and `EntryPointCommand`.

## Install

```sh
pnpm add @slipher/cooldown
```

## Use With Seyfert

Register the plugin on the client. The plugin attaches the manager to the client, exposes it on every interaction context, and uses `client.cache` as its storage backend.

```ts
import { Client } from 'seyfert';
import { cooldown } from '@slipher/cooldown';

const client = new Client({
	plugins: [cooldown()],
});
```

Declare a cooldown on a command with the `@Cooldown` decorator:

```ts
import { Command, CommandContext, Declare } from 'seyfert';
import { Cooldown, CooldownType } from '@slipher/cooldown';

@Declare({ name: 'ping', description: 'Ping' })
@Cooldown({
	type: CooldownType.User,
	interval: 5_000,
	uses: { default: 1 },
})
export default class PingCommand extends Command {
	async run(ctx: CommandContext) {
		const remaining = ctx.cooldown.context(ctx);

		if (typeof remaining === 'number') {
			return ctx.write({
				content: `Wait ${Math.ceil(remaining / 1000)}s before reusing this command.`,
			});
		}

		await ctx.write({ content: 'Pong!' });
	}
}
```

`ctx.cooldown.context(ctx)` resolves the active command, picks the correct target (user, guild, or channel) and either consumes a token or returns the milliseconds left before the next allowed use.

## Configure Per Command

`CooldownProps` controls how the bucket behaves:

```ts
interface CooldownProps {
	type: 'user' | 'guild' | 'channel';
	interval: number; // ms before the bucket refills
	uses: { default: number };
}
```

You can also assign the field directly without the decorator:

```ts
export default class PingCommand extends Command {
	cooldown = {
		type: 'user',
		interval: 5_000,
		uses: { default: 1 },
	} satisfies CooldownProps;
}
```

Subcommands inherit their parent's cooldown automatically when they do not declare their own.

## Manager API

Once the plugin runs, `ctx.cooldown` and `client.cooldown` expose the same `CooldownManager`. The most useful methods:

```ts
ctx.cooldown.has({ name: 'ping', target: ctx.author.id });
ctx.cooldown.use({ name: 'ping', target: ctx.author.id });
ctx.cooldown.refill('ping', ctx.author.id);
ctx.cooldown.context(ctx);
```

- `has` checks whether the bucket is empty and seeds it if it does not exist yet.
- `use` consumes a token. Returns `true` when the call is allowed, or the milliseconds left otherwise.
- `refill` resets the bucket for a target.
- `context` is the high-level helper for command runners.

Command names resolve through Seyfert's `HandleCommand.resolveCommandFromContent`, with `getCommandFromContent` as a fallback, so aliases, grouped subcommands and shortcut handlers all map to the same canonical key.

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
