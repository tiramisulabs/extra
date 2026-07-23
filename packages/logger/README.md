# @slipher/logger

Request-scoped wide-event logging for Seyfert, with immediate level logs and pluggable output.

**[Read the complete Logger guide on seyfert.dev](https://seyfert.dev/docs/plugins/official/logger).**

## Install

```sh
pnpm add @slipher/logger
```

Requires Seyfert v5. Install `pino` or `evlog` only when using its adapter.

## Quick start

```ts
import { logger } from '@slipher/logger';
import { Client, Command, Declare, definePlugins, type CommandContext } from 'seyfert';

const plugins = definePlugins(logger({ name: 'my-bot' }));

declare module 'seyfert' {
	interface SeyfertRegistry {
		plugins: typeof plugins;
	}
}

export const client = new Client({ plugins });

@Declare({ name: 'ping', description: 'Ping' })
export default class PingCommand extends Command {
	async run(ctx: CommandContext) {
		ctx.logger.add({ feature: 'ping' });
		await ctx.write({ content: 'Pong!' });
	}
}
```

The default pretty renderer does not redact secrets. Configure redaction in the selected transport or collector before sending production logs outside the process.
