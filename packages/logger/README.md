# @slipher/logger

Structured logging primitives and a Seyfert plugin for command, component, and modal execution logs.

## Install

```sh
pnpm add @slipher/logger
```

## Standalone Usage

```ts
import { createLogger } from '@slipher/logger';

const logger = createLogger({
	name: 'bot',
	level: 'debug',
	bindings: { shard: 0 },
});

logger.info({ guildId: '123' }, 'bot started');
```

Use `event()` when a single operation needs multiple breadcrumbs and a final outcome:

```ts
const event = logger.event({ command: 'ping', guildId: '123' });

event.debug('command received');
event.info('command completed');
await event.emit({ outcome: 'success', message: 'command finished' });
```

## Seyfert Plugin

```ts
import { Client } from 'seyfert';
import { logger } from '@slipher/logger';

const client = new Client({
	plugins: [
		logger({
			name: 'slipher-bot',
			level: 'info',
		}),
	],
});
```

The plugin exposes `ctx.logger` for commands, components, and modals, and also installs `client.logger`.

## Adapters

Use the console adapter by default, or bridge to another logger:

```ts
import { createPinoLoggerAdapter, logger } from '@slipher/logger';
import pino from 'pino';

const root = pino();

export default logger({
	adapter: createPinoLoggerAdapter(root),
});
```

`createEvlogLoggerAdapter()` is available for event-log style sinks.

## Implementation Notes

- Log records are sanitized so circular objects do not crash serialization.
- Command defaults record options parsing, middleware failures, permission failures, runtime errors, and final outcome.
- `flush()` delegates to the configured adapter when it supports flushing.

## Development

```sh
pnpm --filter @slipher/logger test
pnpm --filter @slipher/logger build
```
