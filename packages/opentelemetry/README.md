# @slipher/opentelemetry

OpenTelemetry traces and duration metrics for Seyfert interactions, events, REST, and cache operations.

**[Read the complete OpenTelemetry guide on seyfert.dev](https://seyfert.dev/docs/plugins/official/opentelemetry).**

## Install

```sh
pnpm add @slipher/opentelemetry @opentelemetry/api
pnpm add @opentelemetry/sdk-trace-node @opentelemetry/exporter-trace-otlp-proto
```

Requires Seyfert v5. Exporters, span processors, and metric readers are intentionally not bundled.

## Quick start

```ts
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { opentelemetry } from '@slipher/opentelemetry';
import { Client, definePlugins } from 'seyfert';

const plugins = definePlugins(
	opentelemetry({
		serviceName: 'my-bot',
		spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
	}),
);

declare module 'seyfert' {
	interface SeyfertRegistry {
		plugins: typeof plugins;
	}
}

export const client = new Client({ plugins });
```

Teardown is terminal for a plugin instance. Create a fresh plugin instance, processor, and exporter for every new client lifecycle.
