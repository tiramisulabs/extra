# @slipher/logger

Structured command, component, and modal logs for Seyfert. The plugin gives each interaction a request-scoped wide event and also lets normal level methods emit immediately.

## Install

```sh
pnpm add @slipher/logger
```

## Use With Seyfert

Install the plugin once in the client:

```ts
import { Client } from 'seyfert';
import { logger } from '@slipher/logger';

const client = new Client({
	plugins: [
		logger({
			name: 'slipher-bot',
			level: 'debug',
			bindings: { service: 'discord' },
		}),
	],
});
```

The plugin adds a wide event logger to every command, component, and modal context as `ctx.logger`. Seyfert lifecycle hooks close that wide event automatically:

- `onBeforeMiddlewares` logs that the command was received.
- `onBeforeOptions` logs option parsing.
- middleware, option, permission, and runtime failures emit an error or denied event immediately.
- `onAfterRun` emits one final success or error entry with `durationMs`.

Use `client.slipherLogger` when you want the root logger with a Slipher-specific type.

Seyfert internal logs are intercepted by default and routed through the configured adapter with `source: 'seyfert'`. Set `interceptInternal: false` only if you intentionally want Seyfert's pretty console output; doing so means internal gateway/API lines bypass your adapter redaction policy.

Until the upstream Seyfert hook-composition fix lands, some Seyfert default error hooks may still duplicate logs outside this package.

## Carry Context Through Middlewares

`ctx.logger.add()` enriches the final wide event. Level methods such as `info()` and `warn()` emit immediately as ordinary log entries. That split keeps normal logger behavior predictable while preserving one final wide event per interaction.

```ts
import { Command, Declare, Middlewares, createMiddleware, type CommandContext } from 'seyfert';

export const auditMiddleware = createMiddleware<{ requestId: string; plan: 'free' | 'pro' }, CommandContext>(
	async ({ context, next }) => {
		const audit = {
			requestId: crypto.randomUUID(),
			plan: await loadUserPlan(context.author.id),
		} as const;

		context.logger.add(audit);
		context.logger.debug('audit context loaded', context.logger.currentContext);

		return next(audit);
	},
);

declare module 'seyfert' {
	interface RegisteredMiddlewares {
		audit: typeof auditMiddleware;
	}
}

@Declare({
	name: 'deploy',
	description: 'Deploy the current project',
})
@Middlewares(['audit'])
export default class DeployCommand extends Command {
	async run(context: CommandContext<{}, 'audit'>) {
		context.logger.add({
			projectId: 'web',
			plan: context.metadata.audit.plan,
		});
		context.logger.info('deployment queued');

		await context.write({ content: 'Deployment queued.' });
	}
}
```

The command does not need to call `emit()` in the happy path. When the command returns, the plugin emits one wide event containing the auto-extracted Seyfert fields, the middleware context, the command context, the final outcome, and `durationMs`:

```ts
{
	message: 'command completed',
	kind: 'command',
	command: 'deploy',
	userId: '123',
	requestId: '7c5d...',
	plan: 'pro',
	projectId: 'web',
	outcome: 'success',
	durationMs: 42,
}
```

Immediate level entries are separate:

```ts
{
	time: '2026-05-29T10:00:00.000Z',
	level: 'info',
	message: 'deployment queued',
}
```

Use `ctx.logger.currentContext` when an immediate entry should include the accumulated wide-event context.

## Auto-extracted Context

By default, wide events include `kind`, `command` or `customId`, `guildId`, `channelId`, `userId`, and `interactionId`. Do not add these by hand; the plugin already includes them.

`username` and `locale` are not auto-extracted. Add them manually with `ctx.logger.add({ username, locale })` if they matter for a specific bot. `shardId` is off by default; opt in when running sharded deployments:

```ts
logger({
	context: {
		shardId: true,
		channelId: false,
	},
});
```

## Use The Current Logger

Use `useLogger()` when a service or helper needs the current interaction logger but should not receive the whole Seyfert context:

```ts
import { useLogger } from '@slipher/logger';

export async function findPlan(userId: string) {
	const log = useLogger();

	log.add({ userId });

	const plan = await database.plans.findByUser(userId);

	log.add({ plan: plan.name });
	log.info('plan loaded');

	return plan;
}
```

`useLogger()` reads the logger for the active Seyfert command, component, or modal scope. `add()` contributes to the same final wide event as `ctx.logger`; level methods emit immediately.

## Adapters

The default adapter writes one flat object to `console`. Use an adapter when you want entries in another logger or event stream. On field collisions, user data from `add()` or level-method data wins over envelope and binding fields.

```ts
import { createPinoLoggerAdapter, logger } from '@slipher/logger';
import pino from 'pino';

const root = pino();

export default logger({
	name: 'slipher-bot',
	adapter: createPinoLoggerAdapter(root),
});
```

For evlog, initialize evlog with the service envelope and pass evlog middleware options to `createEvlogAdapter()`:

```sh
pnpm add evlog
```

```ts
import { initLogger } from 'evlog';
import { createFsDrain } from 'evlog/fs';
import { createDrainPipeline } from 'evlog/pipeline';
import { createEvlogAdapter, logger } from '@slipher/logger';

initLogger({
	env: {
		service: 'slipher-bot',
		environment: process.env.NODE_ENV ?? 'development',
		version: process.env.npm_package_version,
	},
	silent: true,
});

const drain = createDrainPipeline({
	batch: { size: 50, intervalMs: 5_000 },
})(createFsDrain());

export default logger({
	name: 'slipher-bot',
	adapter: createEvlogAdapter({
		drain,
		redact: true,
	}),
});
```

Any evlog drain works here, including Axiom, OTLP, Sentry, fs, memory, or your own pipeline. `createEvlogAdapter()` loads `evlog/toolkit` lazily, so `evlog` is only required when this adapter is used. Set `silent: true` in `initLogger()` when drains own the output channel.

## Outside Seyfert

The core logger can be used without Seyfert when you need the same wide-event behavior in scripts, workers, or tests:

```ts
import { createLogger } from '@slipher/logger';

const root = createLogger({ name: 'worker', level: 'debug' });
const event = root.event({ job: 'sync-guild', guildId: '123' });

event.debug('loaded guild', event.currentContext);
event.info('synced commands');

await event.emit({ outcome: 'success', message: 'guild sync completed' });
```

## Development

```sh
pnpm --filter @slipher/logger test
pnpm --filter @slipher/logger build
```
