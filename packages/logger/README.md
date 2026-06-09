# @slipher/logger

Structured logging for [Seyfert](https://seyfert.dev) bots. Every command, component, and modal gets one request-scoped **wide event**; ordinary level methods still emit immediately. Output goes through a pluggable adapter (pretty console by default, or Pino / evlog).

## How it works

This plugin is built primarily around **wide events** — the idea (see [loggingsucks.com](https://loggingsucks.com/)) that instead of scattering many lines describing *what your code is doing*, you emit one rich, structured entry describing *what happened to this request*. You accumulate context as the work progresses and emit a single event at the end — with the outcome, the duration, and every field you attached — so an interaction becomes one queryable row instead of a pile of strings.

So the plugin gives every command, component, and modal one wide event as `ctx.logger`, emitted automatically when the interaction ends. Ordinary level methods (`ctx.logger.info(...)`, `warn`, …) are still there and emit an immediate entry on the spot, but the wide event is the main model.

## Install

```sh
pnpm add @slipher/logger
```

Requires Seyfert v5.

## Use with Seyfert

Install the plugin once on the client:

```ts
import { Client } from 'seyfert';
import { logger } from '@slipher/logger';

const loggerPlugin = logger({
	name: 'slipher-bot',
	level: 'debug',
});

const client = new Client({
	plugins: [loggerPlugin],
});

declare module 'seyfert' {
	interface Register {
		plugins: [typeof loggerPlugin];
	}
}
```

### Options

| Option | Type | Description |
| --- | --- | --- |
| `name` | `string` | A **binding** that labels every record. It does not rename the plugin (always `@slipher/logger`). |
| `level` | `LogLevel` | Minimum level to emit. `'trace' \| 'debug' \| 'info' \| 'warn' \| 'error' \| 'fatal' \| 'silent'`. Default `'info'`. |
| `bindings` | `Record<string, unknown>` | Static fields attached to every record. |
| `adapter` | `LoggerAdapter` | Where records go. Default: the pretty/JSON console adapter. |
| `context` | `AutoContextConfig` | Toggle which Seyfert fields are auto-extracted (see below). |

## Per-interaction wide events

The plugin attaches a `WideEventLogger` to every command, component, and modal context as `ctx.logger`, and drives its lifecycle for you:

- `onBeforeMiddlewares` / `onBeforeOptions` write immediate `debug` breadcrumbs.
- A middleware, option, permission, or runtime failure emits **one** wide event with `outcome: 'error'` (or `'denied'`) at the point it happens.
- A successful run emits **one** wide event with `outcome: 'success'` and `durationMs` when the command returns.

The result is one canonical entry per interaction.

### Carry context through middlewares

`ctx.logger.add()` enriches the final wide event. Level methods (`info`, `warn`, …) emit immediately. That split keeps normal logging predictable while still producing a single wide event per interaction.

```ts
import { Command, Declare, Middlewares, createMiddleware, type CommandContext } from 'seyfert';

export const auditMiddleware = createMiddleware<{ requestId: string; plan: 'free' | 'pro' }, CommandContext>(
	async ({ context, next }) => {
		const audit = {
			requestId: crypto.randomUUID(),
			plan: await loadUserPlan(context.author.id),
		} as const;

		context.logger.add(audit);
		return next(audit);
	},
);

declare module 'seyfert' {
	interface RegisteredMiddlewares {
		audit: typeof auditMiddleware;
	}
}

@Declare({ name: 'deploy', description: 'Deploy the current project' })
@Middlewares(['audit'])
export default class DeployCommand extends Command {
	async run(context: CommandContext<{}, 'audit'>) {
		context.logger.add({ projectId: 'web', plan: context.metadata.audit.plan });
		context.logger.info('deployment queued');

		await context.write({ content: 'Deployment queued.' });
	}
}
```

You never call `emit()` on the happy path. When the command returns, the plugin emits one wide event with the auto-extracted Seyfert fields, the middleware context, the command context, the outcome, and `durationMs`:

```ts
{
	message: 'command completed',
	kind: 'command',
	command: 'deploy',
	userId: '123',
	requestId: '7c5d…',
	plan: 'pro',
	projectId: 'web',
	outcome: 'success',
	durationMs: 42,
}
```

The immediate `info` is a separate entry:

```ts
{ level: 'info', message: 'deployment queued' }
```

### Auto-extracted context

Every wide event already includes `kind`, `command` or `customId`, `guildId`, `channelId`, `userId`, and `interactionId` — don't add those by hand. Everything domain-specific is up to you; attach it with `ctx.logger.add()` anywhere in the command:

```ts
context.logger.add({ targetId: target.id, reason, banned: true });
```

`shardId` is off by default. Toggle the auto-extracted set with the `context` option:

```ts
logger({ context: { shardId: true, channelId: false } });
```

## Accessing the logger

In a command/component/modal handler you already have `ctx.logger`. Everywhere else — helpers, services, event handlers, startup — use **`useLogger()`**. It always returns a usable logger; what it does depends on where you call it:

- **Inside an interaction scope** it returns that interaction's wide event — `add()` enriches the same final event as `ctx.logger`, and level methods (`info`/`warn`/…) emit immediately.
- **Outside any scope** it returns a fresh root-backed logger — level methods log immediately wherever you are, and you can build a one-off wide event by starting it, `add()`-ing context, then `emit()`-ing.

```ts
import { useLogger } from '@slipher/logger';

// immediate log, anywhere
useLogger().info('ready');

// a one-off wide event from, say, an interactionCreate handler
const event = useLogger();
event.add({ source: 'event', interactionId: interaction.id });
await event.emit({ message: 'interactionCreate received' });
```

(`useLogger()` throws only if the plugin hasn't been set up yet. Outside a scope each call returns a *fresh* event, so capture it in a variable — as above — when you intend to `add()` then `emit()`.)

Because `useLogger()` reads the active scope instead of taking a parameter, a helper deep in the call stack can enrich the interaction's wide event without being handed the context:

```ts
import { Command, Declare, type CommandContext } from 'seyfert';
import { useLogger } from '@slipher/logger';

async function loadProfile(userId: string) {
	const profile = await db.profiles.find(userId);
	useLogger().add({ plan: profile.plan, cached: profile.fromCache });
	return profile;
}

@Declare({ name: 'profile', description: 'Show your profile' })
export default class ProfileCommand extends Command {
	async run(context: CommandContext) {
		const profile = await loadProfile(context.author.id);
		await context.write({ content: `Plan: ${profile.plan}` });
	}
}
```

No `emit()` is called anywhere — when `run()` returns, the plugin emits one wide event that already carries the `plan` and `cached` fields added inside `loadProfile()`.

## Adapters

An adapter decides where records go. The default is the console adapter; swap it for Pino or evlog to feed an existing pipeline. Those two are optional peer dependencies — install the one you use (`pnpm add pino` or `pnpm add evlog`). On field collisions, data from `add()` and level methods wins over bindings.

> **Redaction belongs to the sink.** The console adapter does **not** redact. Configure redaction in your runtime/collector, in your Pino instance, or in evlog's `initLogger()`. evlog's built-in patterns (`creditCard`, `email`, `jwt`, …) do **not** cover Discord bot tokens — add a pattern for those.

### Console (default)

Pretty, colored, multi-line output in development; one JSON object per line when `NODE_ENV=production`.

```
19:00:00.123  INFO   [slipher-bot]  command completed
    command      ping
    guildId      884624547125547058
    durationMs   42ms
19:00:00.130  ERROR  [slipher-bot]  command failed
    command      ban
    SeyfertError: Missing Permissions
        at …
```

The level is colored, fields are aligned, and an `Error` field is rendered as a real stack trace (header in red, frames dimmed).

### Pino

```sh
pnpm add pino
```

```ts
import { Client } from 'seyfert';
import { createPinoAdapter, logger } from '@slipher/logger';
import pino from 'pino';

const sink = pino({ redact: ['token', 'headers.authorization'] });

const client = new Client({
	plugins: [logger({ name: 'slipher-bot', adapter: createPinoAdapter(sink) })],
});
```

`createPinoAdapter` wraps your own Pino instance, so any Pino transport or extension works — e.g. `pino-pretty` for friendlier dev output.

### evlog

evlog owns its global configuration — drains, redaction, sampling, the service envelope — set once with `initLogger()` in your entrypoint. `createEvlogAdapter()` takes no options; it only translates records into evlog calls.

```sh
pnpm add evlog
```

```ts
import { Client } from 'seyfert';
import { initLogger } from 'evlog';
import { createFsDrain } from 'evlog/fs';
import { createDrainPipeline } from 'evlog/pipeline';
import { createEvlogAdapter, logger } from '@slipher/logger';

const drain = createDrainPipeline({ batch: { size: 50, intervalMs: 5_000 } })(createFsDrain());

initLogger({
	env: {
		service: 'slipher-bot',
		environment: process.env.NODE_ENV ?? 'development',
		version: process.env.npm_package_version,
	},
	redact: {
		paths: ['token', 'headers.authorization'],
		patterns: [/Bot\s+[A-Za-z0-9._-]+/g], // built-ins don't cover Discord tokens
	},
	drain,
	silent: true,
});

const client = new Client({
	plugins: [logger({ name: 'slipher-bot', adapter: createEvlogAdapter() })],
});
```

Any evlog drain works — Axiom, OTLP, Sentry, fs, or your own pipeline.
