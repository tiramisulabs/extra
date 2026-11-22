# @slipher/opentelemetry

OpenTelemetry traces and duration metrics for Seyfert interactions, events, REST, cache operations, gateway health, process memory, and active collectors.

**[Read the complete OpenTelemetry guide on seyfert.dev](https://seyfert.dev/docs/plugins/official/opentelemetry).**

## Install

```sh
pnpm add @slipher/opentelemetry @opentelemetry/api
```

Requires Seyfert v5. The SDK supports OTLP export through standard OpenTelemetry environment variables.

## Quick start

Point the plugin at an OTLP collector that accepts traces and metrics:

```sh
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_METRICS_EXPORTER=otlp
```

```ts
import { opentelemetry } from '@slipher/opentelemetry';
import { Client, definePlugins } from 'seyfert';

const plugins = definePlugins(opentelemetry({ serviceName: 'my-bot' }));

declare module 'seyfert' {
	interface SeyfertRegistry {
		plugins: typeof plugins;
	}
}

export const client = new Client({ plugins });
```

## Middleware spans

Interaction tracing wraps each middleware in a `middleware <name>` span, but only for
middlewares the bot registers itself through `client.setServices({ middlewares })`.

Middlewares contributed by other plugins (for example `@slipher/cooldown` with
`middleware: true`) are left untouched. Seyfert reinstalls plugin middlewares on every
`client.start()` and contribution refresh, and compares them by function identity, so
replacing one with a tracing wrapper makes the owning plugin re-add it and fail with
`Middleware "<name>" is already registered.`.

Plugin middlewares create no automatic `middleware <name>` span. Any spans they create
inherit the active span, usually the interaction root. When an instrumented bot
middleware calls `next()`, the rest of that chain continues under the `Middlewares`
phase span. The phase span measures the middleware chain regardless of span parenting.

Teardown is terminal for a plugin instance. Create a fresh plugin instance, processor, and exporter for every new client lifecycle.
