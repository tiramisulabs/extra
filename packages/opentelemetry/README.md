# @slipher/opentelemetry

Full-surface [OpenTelemetry](https://opentelemetry.io/) for [Seyfert](https://seyfert.dev) v5: automatic traces and duration metrics for interactions, gateway events, Discord REST, and cache — with module helpers and a thin `client.trace` / `ctx.trace` API.

| Surface | Span kind | Default |
| --- | --- | --- |
| Interactions (commands, components, modals) | `INTERNAL` root + lifecycle children | on |
| Gateway event handlers | `INTERNAL` root | on |
| Discord REST (Seyfert API client) | `CLIENT` | on |
| Cache adapter operations | `INTERNAL` | on |

The plugin auto-starts a `NodeSDK` when no real tracer provider is registered yet. If you already preload an SDK, the plugin reuses that provider and only installs instrumentation.

## Install

```bash
pnpm add @slipher/opentelemetry @opentelemetry/api
```

Exporters and processors are **not** bundled. Install what you export to, for example:

```bash
pnpm add @opentelemetry/sdk-trace-node @opentelemetry/exporter-trace-otlp-proto
# optional metrics
pnpm add @opentelemetry/sdk-metrics @opentelemetry/exporter-metrics-otlp-proto
```

**Peers:** `@opentelemetry/api` `^1.9.0`, `seyfert` `>=5.0.0-0`.

## Quick start

```ts
import { Client, definePlugins } from 'seyfert';
import { opentelemetry } from '@slipher/opentelemetry';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';

const plugins = definePlugins(
  opentelemetry({
    serviceName: 'my-bot',
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
  }),
);

const client = new Client({ plugins });

// Type the plugin map so `client.trace` / `ctx.trace` resolve correctly
declare module 'seyfert' {
  interface SeyfertRegistry {
    plugins: typeof plugins;
  }
}

await client.start();
```

`OpenTelemetryPluginOptions` extends NodeSDK constructor options (`spanProcessors`, `traceExporter`, `metricReaders`, `instrumentations`, …) plus plugin-specific fields below. Those SDK fields are applied only when this plugin owns the `NodeSDK`.

### Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `serviceName` | `string` | `'seyfert'` | Tracer/meter name; resource service name when the plugin owns the SDK |
| `instrument` | `InstrumentFlags` | all `true` | Toggle each surface without removing the plugin |
| `checkIfShouldTrace` | `(source: TraceSource) => boolean` | always `true` | Filter before starting a root span |
| `contextManager` | `ContextManager` | — | Registered only if no global context manager is active |
| `cache.skipResources` | `string[]` | `['presence', 'voice_state']` | Cache resources never traced |
| NodeSDK fields | `spanProcessors`, … | — | Passed through when the plugin starts the SDK |

Plugin identity (`name: '@slipher/opentelemetry'`) is stable and is **not** overwritten by `serviceName`.

## Instrument flags

| Flag | Default | What it instruments |
| --- | --- | --- |
| `instrument.interactions` | `true` | Commands, components, modals — root span via `contextScopes` + lifecycle children (`Options`, `Middlewares`, `Run`) |
| `instrument.events` | `true` | Gateway handlers via `client.events.runEvent` (`event {name}`) |
| `instrument.rest` | `true` | Discord REST via `api.rest.observe` (`HTTP {METHOD}`, span kind `CLIENT`) |
| `instrument.cache` | `true` | Cache adapter methods (`cache {op} {resource}`) |

```ts
opentelemetry({
  serviceName: 'my-bot',
  instrument: {
    interactions: true,
    events: true,
    rest: true,
    cache: false, // disable cache spans/metrics only
  },
  checkIfShouldTrace(source) {
    if (source.kind === 'event' && source.name === 'RAW') return false;
    return true;
  },
});
```

`TraceSource` is a discriminated union:

```ts
type TraceSource =
  | { kind: 'command' | 'component' | 'modal'; context: unknown }
  | { kind: 'event'; name: string; args: readonly unknown[] }
  | { kind: 'rest'; method: string; path: string }
  | { kind: 'cache'; op: string; resource: string };
```

## Helpers

Module-level helpers use the global OpenTelemetry API (work with a plugin-owned SDK **or** a preload/host provider):

| Export | Behavior |
| --- | --- |
| `getTracer()` | Tracer for the active `serviceName` |
| `getMeter()` | Meter for the active `serviceName` (custom metrics) |
| `record` / `startActiveSpan` | Active span; auto-`end`; on throw/reject sets `ERROR` + `recordException` and rethrows |
| `startSpan` | Manual span (you must end it) |
| `getCurrentSpan()` | Active span or `undefined` |
| `setAttributes(attrs)` | Sets attributes on the current span; returns whether applied |

```ts
import { record, setAttributes, getCurrentSpan } from '@slipher/opentelemetry';

await record('fetch-user-profile', async (span) => {
  span.setAttribute('app.step', 'profile');
  // …
});

setAttributes({ 'app.feature': 'welcome' });
getCurrentSpan()?.addEvent('cache-miss');
```

### `client.trace` / `ctx.trace`

Installed via the plugin `client` and `ctx` maps:

```ts
interface TraceHandle {
  readonly span: Span | undefined;
  setAttributes(attributes: Attributes): boolean;
  recordException(error: unknown): void;
  record: typeof record; // child active span
}
```

```ts
// In a command handler
ctx.trace.setAttributes({ 'app.guild_locale': locale });
await ctx.trace.record('load-settings', async () => {
  // nested under the interaction root when in the same async chain
});

// Outside an active span, span is undefined; setAttributes returns false
client.trace.span; // Span | undefined
```

Also exported: `createTraceHandle` and type `TraceHandle` if you need a handle in custom code.

## Attribute reference

Attributes are set only when values are available. Sensitive data is never captured (see [Security](#security)).

### Interactions

| Attribute | Description |
| --- | --- |
| `seyfert.interaction.kind` | `command` \| `component` \| `modal` |
| `seyfert.command` | Full command name when known |
| `seyfert.custom_id` | Component/modal custom id (truncated to 64 chars) |
| `seyfert.guild_id` | Guild id |
| `seyfert.channel_id` | Channel id |
| `seyfert.user_id` | Invoking user id |
| `seyfert.interaction_id` | Interaction id |
| `seyfert.shard_id` | Shard id when present |

**Root span names:** `command {name}`, `component {customId}`, `modal {customId}`.

**Lifecycle children:** `Options` (commands), `Middlewares`, `Run`.

### Gateway events

| Attribute | Description |
| --- | --- |
| `seyfert.event.name` | Event name (`MESSAGE_CREATE`, …) |
| `seyfert.shard_id` | Shard id when present |

**Span name:** `event {name}`.

### REST

| Attribute | Description |
| --- | --- |
| `http.request.method` | HTTP method |
| `url.path` | Request path/url from Seyfert (no auth headers/bodies) |
| `http.response.status_code` | Response status when known |

**Span name:** `HTTP {METHOD}`. Status `>= 500` or thrown failures set span status `ERROR`; 4xx is recorded as attributes without forcing ERROR.

### Cache

| Attribute | Description |
| --- | --- |
| `seyfert.cache.op` | Adapter method (`get`, `set`, `remove`, `patch`, bulk variants, …) |
| `seyfert.cache.resource` | Resource namespace derived from the key |
| `seyfert.cache.hit` | On `get`, whether the result was non-nullish |

**Span name:** `cache {op} {resource}`. High-churn resources default-skipped: `presence`, `voice_state` (override with `cache.skipResources`).

### Metrics-only

| Attribute | Description |
| --- | --- |
| `seyfert.error` | `true` when the operation ended in error (histograms) |

## Metrics reference

Four duration histograms (unit `s`) on the meter named `serviceName`. Instruments are created only for enabled `instrument.*` surfaces.

| Instrument | Unit | Typical attributes |
| --- | --- | --- |
| `seyfert.interaction.duration` | s | interaction kind, command/custom_id, `seyfert.error` |
| `seyfert.event.duration` | s | `seyfert.event.name`, `seyfert.error` |
| `seyfert.rest.duration` | s | method, path, status, `seyfert.error` |
| `seyfert.cache.operation.duration` | s | op, resource, hit (when applicable), `seyfert.error` |

For custom metrics, use `getMeter()` and the global meter provider (works whether or not this plugin owns the SDK).

## Preload / external SDK

If a real tracer provider is already registered (preload script, host process, tests):

1. The plugin **does not** call `NodeSDK.start()`.
2. Instrumentation and helpers still run against the global API.
3. `teardown` still unwraps REST/cache/events; it only calls `sdk.shutdown()` when this plugin started the SDK.

```ts
// host already started NodeSDK / registered a provider
const plugins = definePlugins(
  opentelemetry({
    serviceName: 'my-bot',
    // spanProcessors here are ignored when the plugin does not own the SDK
  }),
);
```

Works alongside `@slipher/logger` and other plugins: logs and traces are orthogonal.

## Security

By default the plugin **never** puts on spans:

- Request or response **bodies**
- Bot **tokens**
- **Authorization** (or cookie) headers
- Other secrets from Discord HTTP traffic

Only structural metadata (methods, paths, ids, status codes, resource names) is recorded. Prefer `checkIfShouldTrace` if certain paths or custom ids must not appear at all.

## Limitations

- **REST FIFO correlation:** Concurrent Discord REST calls that share the same `method + path` are correlated with a FIFO queue (Seyfert observer payloads cannot carry a request id). Completions are assumed to finish in request order for a given route; out-of-order completion for the same route can attach status/duration to the wrong span. Distinct routes are unaffected.

## Inspiration

API shape and ownership ideas draw from the [Elysia OpenTelemetry plugin](https://elysiajs.com/plugins/opentelemetry).
