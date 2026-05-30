# @slipher/logger

Structured command, component, and modal logs for Seyfert. The plugin keeps the whole interaction timeline in memory, lets middlewares and commands enrich the same log event, and emits one final entry when Seyfert finishes the run.

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

The plugin adds a wide event logger to every command, component, and modal context as `ctx.logger`. Seyfert lifecycle hooks close that event automatically:

- `onBeforeMiddlewares` records that the command was received.
- `onBeforeOptions` records option parsing.
- middleware, option, permission, and runtime failures emit an error or denied event immediately.
- `onAfterRun` emits one final success or error entry with `durationMs`.

It also installs the root logger on `client.logger`, `client.commands.logger`, `client.components.logger`, `client.events.logger`, `client.langs.logger`, and `client.cache.logger` for non-interaction logs. Use `client.slipherLogger` when you want the same root logger with a Slipher-specific type.

## Carry Context Through Middlewares

Everything that calls `ctx.logger.add()` or logs a breadcrumb contributes to the same final entry. That makes it useful for request-scoped context that is discovered before the command runs.

```ts
import { Command, Declare, Middlewares, createMiddleware, type CommandContext } from 'seyfert';

export const auditMiddleware = createMiddleware<{ requestId: string; plan: 'free' | 'pro' }, CommandContext>(
	async ({ context, next }) => {
		const audit = {
			requestId: crypto.randomUUID(),
			plan: await loadUserPlan(context.author.id),
		} as const;

		context.logger.add(audit);
		context.logger.debug('audit context loaded');

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

The command does not need to call `emit()` in the happy path. When the command returns, the plugin emits one entry containing the Seyfert fields, the middleware context, the command context, the final outcome, and the breadcrumbs:

```ts
{
	message: 'command completed',
	data: {
		kind: 'command',
		command: 'deploy',
		userId: '123',
		requestId: '7c5d...',
		plan: 'pro',
		projectId: 'web',
		outcome: 'success',
		durationMs: 42,
	},
	logs: [
		{ level: 'debug', message: 'command received' },
		{ level: 'debug', message: 'audit context loaded' },
		{ level: 'debug', message: 'command options parsing' },
		{ level: 'info', message: 'deployment queued' },
	],
}
```

## Adapters

The default adapter writes to `console`. Use an adapter when you want the final wide event in another logger or event stream.

```ts
import { createPinoLoggerAdapter, logger } from '@slipher/logger';
import pino from 'pino';

const root = pino();

export default logger({
	name: 'slipher-bot',
	adapter: createPinoLoggerAdapter(root),
});
```

`createEvlogLoggerAdapter()` is also available for event-log style sinks.

## Outside Seyfert

The core logger can be used without Seyfert when you need the same wide-event behavior in scripts, workers, or tests:

```ts
import { createLogger } from '@slipher/logger';

const root = createLogger({ name: 'worker', level: 'debug' });
const event = root.event({ job: 'sync-guild', guildId: '123' });

event.debug('loaded guild');
event.info('synced commands');

await event.emit({ outcome: 'success', message: 'guild sync completed' });
```

## Development

```sh
pnpm --filter @slipher/logger test
pnpm --filter @slipher/logger build
```
