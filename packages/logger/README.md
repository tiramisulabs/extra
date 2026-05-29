# @slipher/logger

Small logger facade for Slipher infrastructure packages and Seyfert-adjacent code.

Use it when package code needs structured logs, redaction, child bindings, or adapter compatibility without forcing a specific logger dependency on consumers. It is not intended to replace Seyfert's client logger; pass Seyfert, Pino, evlog, console, or any other sink through an adapter when that is the runtime logger for the app.

## Install

```sh
pnpm add @slipher/logger
```

## Usage

```ts
import { createLogger } from '@slipher/logger';

const logger = createLogger({
	name: 'worker',
	level: 'info',
	redact: ['token', 'authorization'],
});

logger.info({ guildId }, 'sync started');
logger.error({ error }, 'sync failed');
```

## Child loggers

```ts
const shardLogger = logger.child({ shardId: 1 });

shardLogger.info({ guildId }, 'guild sync queued');
```

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
