# @slipher/opentelemetry

Full-surface [OpenTelemetry](https://opentelemetry.io/) for [Seyfert](https://seyfert.dev) v5: automatic traces and duration metrics for interactions, gateway events, Discord REST, and cache — with module helpers and a thin `client.trace` / `ctx.trace` API.

| Surface | Span kind | Traces | Metrics |
| --- | --- | --- | --- |
| Interactions (commands, components, modals) | `INTERNAL` root + lifecycle children | on | on |
| Gateway event handlers | `CONSUMER` root | on | on |
| Discord REST (Seyfert HTTP client) | `CLIENT` | on | on |
| Cache adapter operations | `INTERNAL` | off | on |

The plugin auto-starts a `NodeSDK` when no real tracer provider is registered yet. If you already preload an SDK, the plugin reuses that provider and only installs instrumentation.

`teardown` is terminal for a plugin instance because OpenTelemetry processors and exporters are shut down with the SDK. Create a fresh `opentelemetry(...)` instance (and fresh processor/exporter instances) for a new client lifecycle; calling `setup` again on a torn-down instance throws instead of silently dropping telemetry.

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

// Type the plugin map so `client.trace` / `ctx.trace` resolve correctly
declare module 'seyfert' {
  interface SeyfertRegistry {
    plugins: typeof plugins;
  }
}

const client = new Client({ plugins });

await client.start();
```

`OpenTelemetryPluginOptions` extends NodeSDK constructor options (`spanProcessors`, `traceExporter`, `metricReader`, `instrumentations`, …) plus plugin-specific fields below. Those SDK fields are applied only when this plugin owns the `NodeSDK`.

### Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `serviceName` | `string` | `'seyfert'` | Resource service name when the plugin owns the SDK |
| `traces` | `SignalFlags` | all on except `cache` | Toggle spans by surface |
| `metrics` | `SignalFlags` | all on | Toggle duration histograms by surface |
| `checkIfShouldTrace` | `(source: TraceSource) => boolean` | always `true` | Filter before starting a root span; metrics are unaffected |
| `contextManager` | `ContextManager` | — | Registered only if no global context manager is active |
| `cache.skipResources` | `string[]` | `['presence', 'voice_state']` | Cache resources neither traced nor measured |
| NodeSDK fields | `spanProcessors`, … | — | Passed through when the plugin starts the SDK |

Plugin identity and instrumentation scope are fixed to `@slipher/opentelemetry` version `1.0.0`; `serviceName` identifies the application resource and never replaces the scope.

## Signal flags

| Flag | Default | What it instruments |
| --- | --- | --- |
| `traces.interactions` / `metrics.interactions` | `true` / `true` | Commands, components, modals |
| `traces.events` / `metrics.events` | `true` / `true` | Gateway handlers via `client.events.runEvent` |
| `traces.rest` / `metrics.rest` | `true` / `true` | Outbound Discord HTTP requests via `api.rest.observe` |
| `traces.cache` / `metrics.cache` | `false` / `true` | Cache adapter methods; keep aggregate latency without adding a span per lookup |

```ts
opentelemetry({
  serviceName: 'my-bot',
  traces: {
    interactions: true,
    events: true,
    rest: true,
    cache: false,
  },
  metrics: {
    interactions: true,
    events: true,
    rest: true,
    cache: true,
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
| `getTracer()` | Tracer in the `@slipher/opentelemetry` instrumentation scope |
| `getMeter()` | Meter in the `@slipher/opentelemetry` instrumentation scope |
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
  instrumentInteractions(handlers: Iterable<object>, kind?: 'command' | 'component' | 'modal'): number;
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

Seyfert handlers registered after plugin setup can be instrumented explicitly. Command options and subcommands are traversed recursively:

```ts
client.trace.instrumentInteractions(lateCommands.values);
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

**Lifecycle children:** `Options` (commands), `Middlewares`, `middleware {registeredName}` for each executed middleware, and `Run`. Code executed by a middleware or handler remains inside its corresponding active child span.

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
| `http.request.method_original` | Original method when casing is normalized or the result is `_OTHER` |
| `server.address` | Discord API host |
| `server.port` | Discord API port |
| `url.full` | Absolute sanitized URL, with tokens and query omitted |
| `url.path` | URI path with Discord webhook/interaction tokens redacted and query omitted |
| `url.template` | Low-cardinality Discord route template (`/channels/:id/messages`) |
| `http.response.status_code` | Response status when known |
| `http.request.resend_count` | 502/503 resend count when Seyfert retries |
| `error.type` | HTTP status or exception type for failed client operations |
| `discord.error.code` | Discord error code when Seyfert provides a structured Discord error |

**Span name:** `{METHOD} {url.template}`; unknown methods use `HTTP {url.template}`. These are outbound HTTP `CLIENT` spans from the bot to Discord's API. HTTP 4xx/5xx and thrown client failures set span status `ERROR`. Discord failures also record an exception event with the safe response message and error code; the response body remains excluded. Seyfert 502/503 retries stay on one logical span and update `http.request.resend_count`.

### Cache

| Attribute | Description |
| --- | --- |
| `seyfert.cache.op` | Any Seyfert adapter data method (`get`, `scan`, `values`, relationships, bulk variants, …) |
| `seyfert.cache.resource` | Resource namespace derived from the key |
| `seyfert.cache.hit` | On `get`, whether the result was non-nullish |

**Span name:** `cache {op} {resource}` when cache traces are enabled. High-churn resources default-skipped: `presence`, `voice_state` (override with `cache.skipResources`).

### Metrics-only

| Attribute | Description |
| --- | --- |
| `seyfert.error` | `true` when the operation ended in error (histograms) |

## Metrics reference

Four duration histograms (unit `s`) in the package instrumentation scope. Instruments are created only for enabled `metrics.*` surfaces. Cache uses sub-millisecond buckets because adapter operations are much faster than handlers and HTTP requests.

| Instrument | Unit | Typical attributes |
| --- | --- | --- |
| `seyfert.interaction.duration` | s | interaction kind, command when known, shard, `seyfert.error` |
| `seyfert.event.duration` | s | `seyfert.event.name`, `seyfert.error` |
| `seyfert.rest.duration` | s | method, low-cardinality URL template, status, `seyfert.error` |
| `seyfert.cache.operation.duration` | s | op, resource, hit (when applicable), `seyfert.error` |

For custom metrics, use `getMeter()` and the global meter provider (works whether or not this plugin owns the SDK).

## Preload / external SDK

When instrumented libraries must see the SDK before application imports run, use `startOpenTelemetry` from a Node preload module:

```ts
// instrumentation.ts
import { startOpenTelemetry } from '@slipher/opentelemetry';

startOpenTelemetry({ serviceName: 'my-bot' });
```

```bash
node --import ./dist/instrumentation.js dist/index.js
```

The plugin detects this provider and reuses it. Calling `startOpenTelemetry` when another real provider is already registered returns `undefined` without replacing it.

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

Works alongside `@slipher/logger`: logs emitted inside an active span can carry its `trace_id` and `span_id` for correlation.

## Security

By default the plugin **never** puts on spans:

- Request or response **bodies**
- Bot **tokens**
- **Authorization** (or cookie) headers
- Other secrets from Discord HTTP traffic

REST query strings are omitted, Discord webhook/interaction tokens are replaced with `REDACTED`, and metric dimensions use low-cardinality route templates. User, guild, channel, interaction, and custom IDs remain span-only attributes. Use `checkIfShouldTrace` if certain paths or IDs must not appear in spans at all.

## Limitations

- **REST FIFO correlation:** Concurrent Discord REST calls that share the same `method + path` are correlated with a FIFO queue (Seyfert observer payloads cannot carry a request id). Completions are assumed to finish in request order for a given route; out-of-order completion for the same route can attach status/duration to the wrong span. Seyfert 502/503 retries are recognized through `_50xRetries` and remain on the original logical span. Distinct routes are unaffected.

## Inspiration

API shape and ownership ideas draw from the [Elysia OpenTelemetry plugin](https://elysiajs.com/plugins/opentelemetry).
