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

Teardown is terminal for a plugin instance. Create a fresh plugin instance, processor, and exporter for every new client lifecycle.
