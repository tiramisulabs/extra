# @slipher/logger

Seyfert-first structured logger for bots that need richer command, component, modal, event, queue, and shard logs than the default console output.

Use it to replace `client.logger`, wire Seyfert command defaults, add a global command logging middleware, redact Discord secrets, and forward normalized entries into Pino, evlog, console, or any custom sink.

Status: beta/draft. The package is usable, but public API details may change before a stable release.

## Install

```sh
pnpm add @slipher/logger
```

## Usage

```ts
import { commandLogger, createSeyfertLogger, createSeyfertLoggerDefaults } from '@slipher/logger';

const logger = createSeyfertLogger({
	client,
	name: 'Hiraku',
	level: 'info',
});

client.setServices({
	middlewares: {
		logger: commandLogger(logger),
	},
});

client.options.commands.defaults = {
	...client.options.commands.defaults,
	...createSeyfertLoggerDefaults(logger).commands,
};
```

`createSeyfertLogger({ client })` replaces `client.logger` and the logger references held by Seyfert handlers such as commands, components, events, langs, and cache.

## Child loggers

```ts
const shardLogger = logger.child({ shardId: 1 });

shardLogger.info({ guildId }, 'guild sync queued');
```

## Context

`commandLogger` and the default hooks extract Seyfert context when available:

- `command`
- `guildId`
- `channelId`
- `shardId`
- `userId`
- `username`
- `interactionId`
- `locale`

## Adapters

Adapters receive normalized `LogEntry` objects.

```ts
import type { LoggerAdapter, LogEntry } from '@slipher/logger';

const adapter: LoggerAdapter = {
	write(entry: LogEntry) {
		pinoInstance[entry.level]({ ...entry.bindings, ...entry.data }, entry.message);
	},
	flush() {
		pinoInstance.flush();
	},
};
```

Optional compatibility should be provided by passing already-created logger instances into adapter factories. Do not wrap optional imports in `try/catch`; put Pino or evlog-specific helpers in separate optional packages if needed later.
