# @slipher/opentelemetry

[OpenTelemetry](https://opentelemetry.io/) for [Seyfert](https://seyfert.dev) v5. Traces and metrics for interactions, gateway events, Discord REST and cache — plus gateway shard health, so a bot that goes quiet doesn't look healthy.

## Install

```bash
pnpm add @slipher/opentelemetry @opentelemetry/api
```

Exporters aren't bundled — install what you export to:

```bash
pnpm add @opentelemetry/sdk-trace-node @opentelemetry/exporter-trace-otlp-proto
```

Peers: `@opentelemetry/api` `^1.9.0`, `seyfert` `>=5.0.0`.

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

// Makes `client.trace` / `ctx.trace` resolve
declare module 'seyfert' {
  interface SeyfertRegistry {
    plugins: typeof plugins;
  }
}

await new Client({ plugins }).start();
```

That's it — no other wiring. The plugin starts a `NodeSDK` unless one is already registered, in which case it reuses it.

## Options

```ts
opentelemetry({
  serviceName: 'my-bot',
  traces: { cache: true },
  metrics: { gateway: false },
  checkIfShouldTrace(source) {
    return !(source.kind === 'event' && source.name === 'RAW');
  },
});
```

| Option | Default | |
| --- | --- | --- |
| `serviceName` | `'seyfert'` | Resource service name |
| `traces` | all on except `cache` | Spans per surface: `interactions`, `events`, `rest`, `cache` |
| `metrics` | all on | Same keys plus `gateway` |
| `checkIfShouldTrace` | always trace | Skip spans for a given source; metrics still recorded |
| `cache.skipResources` | `['presence', 'voice_state']` | Cache resources to ignore entirely |

Anything else you pass goes to the `NodeSDK` constructor (`spanProcessors`, `traceExporter`, `metricReader`, `instrumentations`, …) and applies only when this plugin owns the SDK.

Cache traces are off by default — one span per lookup is a lot of spans for very little. The metrics stay on, so you keep the latency numbers.

`checkIfShouldTrace` receives:

```ts
type TraceSource =
  | { kind: 'command' | 'component' | 'modal'; context: unknown }
  | { kind: 'event'; name: string; args: readonly unknown[] }
  | { kind: 'rest'; method: string; path: string }
  | { kind: 'cache'; op: string; resource: string };
```

## Adding your own spans

```ts
// Inside any handler
ctx.trace.setAttributes({ 'app.guild_locale': locale });

await ctx.trace.record('load-settings', async () => {
  // nested under the interaction span
});
```

`ctx.trace` and `client.trace` both expose `span`, `setAttributes`, `recordException` and `record`. The same helpers are importable standalone — `record`, `startSpan`, `startActiveSpan`, `getCurrentSpan`, `setAttributes`, `getTracer`, `getMeter` — and work whether or not the plugin owns the SDK.

`record` ends the span for you and marks it `ERROR` on throw. `startSpan` is manual — you end it.

## What you get

**Spans**

| Surface | Kind | Name |
| --- | --- | --- |
| Commands | `CONSUMER` | `command ban`, with `Options` / `Middlewares` / `middleware {name}` / `Run` children |
| Components & modals | `CONSUMER` | `component VoteButton` |
| Gateway events | `CONSUMER` | `event MESSAGE_CREATE` |
| Discord REST | `CLIENT` | `GET /guilds/{guild_id}/members/{user_id}` |
| Cache (opt-in) | `INTERNAL` | `cache get guild` |

Component and modal spans are named after the handler: its `customId` when that's a plain string, otherwise the class name. The runtime `custom_id` is a span attribute, never part of the name — a handler matching `/^vote:\d+$/` would otherwise produce a new span name per click.

To name one yourself:

```ts
export default class VoteButton extends ComponentCommand {
  spanName = 'vote'; // or (ctx) => `vote:${ctx.something}`
}
```

Spans carry the ids you'd expect (`seyfert.guild_id`, `seyfert.user_id`, `seyfert.command`, `seyfert.custom_id`, …), standard HTTP attributes on REST spans, and `discord.error.code` / `discord.ratelimit.bucket` when Discord provides them.

**When an interaction fails**, the root span says where and why:

| Attribute | |
| --- | --- |
| `seyfert.failure.phase` | `options`, `middlewares` or `run` |
| `error.type` | Seyfert error code, else the error class name |
| `seyfert.middleware.name` | which middleware denied it |
| `seyfert.middleware.scope` | `global` or `command` |

So "the command silently did nothing" resolves to "the `cooldown` global middleware denied it" without opening a single child span.

**Metrics**

| Instrument | Unit | |
| --- | --- | --- |
| `seyfert.interaction.duration` | s | Handler duration by kind, command and `seyfert.failure.phase` |
| `seyfert.event.duration` | s | Gateway handler duration by event name |
| `seyfert.rest.duration` | s | Discord call duration by method, route template and status |
| `seyfert.cache.operation.duration` | s | Adapter duration by op, resource and hit |
| `seyfert.gateway.shard.connected` | — | `1` / `0` per shard |
| `seyfert.gateway.shard.latency` | s | Heartbeat round-trip per shard, reported only while connected |

Reconnects don't need their own counter — Seyfert dispatches `SHARD_RECONNECT` as a normal event, so `seyfert.event.duration` already counts them.

## Preloading

If other instrumented libraries must see the SDK before your app imports them:

```ts
// instrumentation.ts
import { startOpenTelemetry } from '@slipher/opentelemetry';

startOpenTelemetry({ serviceName: 'my-bot' });
```

```bash
node --import ./dist/instrumentation.js dist/index.js
```

The plugin detects the existing provider and only installs instrumentation. Passing `spanProcessors` to the plugin has no effect in that case.

## Security

Never put on spans: request or response bodies, bot tokens, `Authorization` headers. Query strings are dropped and webhook/interaction tokens in URLs are replaced with `REDACTED`.

Guild, channel, user and custom ids **are** recorded as span attributes — they're what makes a trace useful. Metric dimensions stay low-cardinality. Use `checkIfShouldTrace` if some of them must not be recorded at all.
