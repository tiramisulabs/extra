# @slipher/opentelemetry — Design Spec

**Date:** 2026-07-08  
**Status:** Approved for implementation planning  
**Package:** `@slipher/opentelemetry`  
**Inspiration:** [Elysia OpenTelemetry plugin](https://elysiajs.com/plugins/opentelemetry)  
**Contract:** Seyfert v5 `createPlugin` / `definePlugins` / `RegisterPlugins` (same family as `@slipher/logger`, `@slipher/cooldown`, `@slipher/queues`)

---

## 1. Goal

Ship a Seyfert v5 plugin that gives Discord bots first-class OpenTelemetry **traces** and **core metrics**, covering the full bot surface:

| Surface | Span kind | Default |
| --- | --- | --- |
| Interactions (commands, components, modals) | `INTERNAL` root + lifecycle children | on |
| Gateway event handlers | `INTERNAL` root | on |
| Discord REST (Seyfert API client) | `CLIENT` | on |
| Cache adapter ops | `INTERNAL` | on |

Users get Elysia-like helpers plus a thin `client.trace` / `ctx.trace` API, with optional per-surface flags (the composability of a multi-instrumentor design without splitting packages).

---

## 2. Non-goals (v1)

- Capturing request/response **bodies**, bot tokens, or Authorization headers on spans.
- Replacing `@slipher/logger` (orthogonal: logs vs traces; may co-exist).
- Custom application metrics API beyond `getMeter()` re-export / thin access (core histograms only as built-ins).
- Distributed context extraction from Discord gateway payloads (no standard carrier). Optional later for HTTP webhook adapters only.
- Auto-starting every Node auto-instrumentation package by default (users may pass `instrumentations` into NodeSDK options).
- Graphite/CI/publish pipeline changes beyond adding the package to the monorepo workspace.

---

## 3. Public API

### 3.1 Install

```ts
import { Client, definePlugins, type RegisterPlugins } from 'seyfert';
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

declare module 'seyfert' {
  interface Register extends RegisterPlugins<typeof plugins> {}
}
```

### 3.2 Factory and options

```ts
function opentelemetry(options?: OpenTelemetryPluginOptions): SeyfertPlugin
```

`OpenTelemetryPluginOptions` extends NodeSDK constructor options (same pattern as Elysia) plus:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `serviceName` | `string` | `'seyfert'` | Tracer/meter name and resource service name when plugin owns SDK |
| `instrument` | `InstrumentFlags` | all `true` | Toggle surfaces without removing the plugin |
| `checkIfShouldTrace` | `(source: TraceSource) => boolean` | always true | Sampling / filter hook before starting a root span |
| `contextManager` | `ContextManager` | — | Optional global context manager if none set |
| `cache.skipResources` | `string[]` | high-churn defaults (e.g. presence-related) | Resources never traced |
| NodeSDK fields | `spanProcessors`, `traceExporter`, `metricReaders`, `instrumentations`, … | — | Passed through when the plugin starts the SDK |

```ts
interface InstrumentFlags {
  interactions?: boolean; // default true
  events?: boolean;       // default true
  rest?: boolean;         // default true
  cache?: boolean;        // default true
}
```

`TraceSource` is a small discriminated union used by `checkIfShouldTrace`:

```ts
type TraceSource =
  | { kind: 'command' | 'component' | 'modal'; context: unknown }
  | { kind: 'event'; name: string; args: readonly unknown[] }
  | { kind: 'rest'; method: string; path: string }
  | { kind: 'cache'; op: string; resource: string };
```

### 3.3 Module helpers (Elysia-compatible names)

| Export | Behavior |
| --- | --- |
| `getTracer()` | Tracer for `serviceName` (default plugin name scope) |
| `startSpan` / `startActiveSpan` / `record` | Active span helpers; `record` aliases `startActiveSpan` with auto end + error status |
| `getCurrentSpan()` | Active span or `undefined` |
| `setAttributes(attrs)` | Sets on current span; returns whether applied |
| `getMeter()` | Meter for core/custom metrics |

These read the global OTel API, so they work under the plugin-owned SDK **or** an external/preload provider.

### 3.4 Thin handle: `client.trace` / `ctx.trace`

Installed via plugin `client` + `ctx` maps (and module augmentation for consumers that do not use `RegisterPlugins`):

```ts
interface TraceHandle {
  readonly span: Span | undefined;
  setAttributes(attributes: Attributes): boolean;
  recordException(error: unknown): void;
  /** Child active span; same overloads spirit as startActiveSpan */
  record: StartActiveSpan;
}
```

- Outside a scope, `span` is `undefined`; `setAttributes` / `recordException` no-op (return false / void).
- `record` still creates spans via the tracer (does not require a parent).

### 3.5 Package identity

- **npm name:** `@slipher/opentelemetry`
- **plugin `name`:** `@slipher/opentelemetry` (stable; not overwritten by `serviceName`)
- **license / publish:** same as sibling packages (MIT, public)

---

## 4. Plugin lifecycle

Pattern mirrors `@slipher/logger` / `@slipher/cooldown` / `@slipher/queues`:

```ts
return createPlugin({
  name: '@slipher/opentelemetry',
  client: { trace: () => handle },
  ctx: { trace: () => handleFromActiveContext() },
  options() {
    return { contextScopes: instrument.interactions ? [otelContextScope] : [] };
  },
  register(api) { /* interaction defaults when instrument.interactions */ },
  setup(client) { /* SDK, REST wrap, cache wrap, events wrap, install handle */ },
  teardown(client) { /* unwrap, restore, sdk.shutdown if owned */ },
});
```

### 4.1 SDK ownership (Elysia-style)

1. Read `trace.getTracerProvider()`.
2. If provider is still the no-op / proxy without a real delegate (`shouldStartNodeSDK` equivalent), construct `NodeSDK` with plugin options and `sdk.start()`. Mark `ownedSdk = true`.
3. Otherwise: **do not** start a second SDK; use the existing provider (preload / host).
4. On `teardown`: if `ownedSdk`, call `sdk.shutdown()`; always unwrap REST/cache/events regardless of ownership.

### 4.2 Context scope

When `instrument.interactions` is on, register a `contextScopes` entry that:

1. Optionally calls `checkIfShouldTrace`.
2. Starts a root active span for the interaction.
3. Runs the pipeline inside `otelContext.with(spanContext, run)`.
4. Ends the root span on completion / error (status + `recordException`).

This keeps REST/cache child spans nested under the interaction when those ops run in the same async chain.

### 4.3 Teardown guarantees

- Restore original REST request method / cache adapter methods even if `shutdown()` rejects.
- Clear `client.trace` installation the same way queues/logger restore properties.
- Idempotent setup/teardown (safe if called twice).

---

## 5. Instrumentation details

### 5.1 Interactions (`instrument.interactions`)

**Mechanism:** `api.commands.defaults`, `api.components.defaults`, `api.modals.defaults` (same hooks as logger), plus `contextScopes` for the root span.

**Root span**

- Name: `command {fullCommandName}` | `component {customId}` | `modal {customId}` (truncate customId if needed).
- Kind: `INTERNAL`.
- Attributes (when available):
  - `seyfert.interaction.kind` = `command` \| `component` \| `modal`
  - `seyfert.command` / `seyfert.custom_id`
  - `seyfert.guild_id`, `seyfert.channel_id`, `seyfert.user_id`, `seyfert.interaction_id`
  - `seyfert.shard_id` when present on the context (no separate config flag in v1)

**Child spans** (lifecycle)

| Child name | Hook |
| --- | --- |
| `Middlewares` | around middleware phase |
| `Options` | command options parsing (commands only) |
| `Run` | main handler |
| `Error` | only when an error path is taken (or record on root only — **prefer attributes on root + child that failed**) |

Implementation note: prefer starting short-lived children in `onBefore*` / ending in matching after hooks rather than deep monkey-patches of the command runner.

**Errors:** `SpanStatusCode.ERROR`, `recordException`, end root.

**Skip:** if `checkIfShouldTrace` returns false, no root span and no forced children (helpers still work if user creates spans manually).

### 5.2 Gateway events (`instrument.events`)

**Mechanism:** in `setup`, wrap the single path Seyfert uses to invoke registered gateway listeners (prefer a public/stable hook if one exists on v5; otherwise patch the client events dispatcher and restore on teardown). Target: every user event handler runs under one root span.

**Root span**

- Name: `event {eventName}`
- Kind: `INTERNAL`
- Attributes: `seyfert.event.name`, optional `seyfert.shard_id`

**Errors:** same as interactions.

**Noise:** users filter with `checkIfShouldTrace({ kind: 'event', name, args })` or `instrument: { events: false }`.

### 5.3 REST (`instrument.rest`)

**Mechanism:** wrap the single outbound Discord HTTP entrypoint on the Seyfert client (the method all route helpers ultimately call). Prefer the lowest stable layer so route-specific helpers are covered once. Store the original function; restore on teardown. If Seyfert exposes a request middleware/hook in v5, prefer that over monkey-patching.

**Span**

- Name: `HTTP {METHOD}` or `discord.api {METHOD} {routeTemplate}` when a route template is available.
- Kind: `CLIENT`
- Attributes:
  - `http.request.method`
  - `url.path` or `http.route` (templated path if known, never raw tokens)
  - `http.response.status_code`
  - `server.address` = Discord API host when known
  - `seyfert.rest.bucket` / rate-limit headers **only if already exposed by Seyfert without parsing sensitive data** (optional enhancement if cheap)

**Errors / non-2xx:** set error status for network failures and 5xx; 4xx recorded as attributes without necessarily ERROR status (align with common HTTP semantic conventions: 4xx often unset or error only for 5xx — **v1: ERROR on throw or status >= 500**).

**Security:** never set attributes from Authorization, cookie, or body.

### 5.4 Cache (`instrument.cache`)

**Mechanism:** wrap adapter methods used by Seyfert cache (`get` / `set` / `remove` / bulk variants as applicable on the adapter interface). Prefer wrapping the adapter instance(s) attached to `client.cache` at setup.

**Span**

- Name: `cache {op} {resource}`
- Kind: `INTERNAL`
- Attributes:
  - `seyfert.cache.op` = `get` \| `set` \| `remove` \| …
  - `seyfert.cache.resource` = resource name
  - `seyfert.cache.hit` = boolean when op is get and result known

**Skip list:** `cache.skipResources` defaults exclude high-churn resources (at minimum presence-like resources if present in Seyfert’s resource set). Empty keys / missing resources still allowed.

**Errors:** record exception on thrown adapter errors.

---

## 6. Metrics (core)

Create instruments on the meter named `serviceName` during setup (whether or not the plugin owns the SDK — meters use the global meter provider).

| Instrument | Type | Unit | Attributes |
| --- | --- | --- | --- |
| `seyfert.interaction.duration` | Histogram | s | `seyfert.interaction.kind`, command/custom_id, error flag |
| `seyfert.event.duration` | Histogram | s | `seyfert.event.name`, error flag |
| `seyfert.rest.duration` | Histogram | s | method, route/status, error flag |
| `seyfert.cache.operation.duration` | Histogram | s | op, resource, hit (when applicable) |

Bucket boundaries: follow Elysia-style explicit boundaries suitable for bot latencies (sub-ms to tens of seconds), e.g. similar to `http.server.request.duration` advice in Elysia.

Record duration when the corresponding root/op span ends. If `instrument.*` is false, do not create or record that instrument’s measurements (lazy create only for enabled surfaces).

No separate “custom metrics builder” API in v1 beyond `getMeter()`.

---

## 7. Error handling principles

- Instrumentation must **never** throw into user command/event code. Wrap instrumentor bodies in try/catch; swallow internal errors (optional debug via existing Seyfert logger if available).
- User errors always rethrow after span annotation.
- `record()` helper ends the span and rethrows on rejection/throw (Elysia behavior).
- Teardown is best-effort and exception-safe (`try/finally`).

---

## 8. Package layout

```
packages/opentelemetry/
  package.json
  tsconfig.json
  README.md
  src/
    index.ts              # public exports
    plugin.ts             # createPlugin factory
    options.ts            # types, defaults, resolveInstrumentFlags
    sdk.ts                # shouldStartNodeSDK, start/stop
    trace-api.ts          # getTracer, record, getCurrentSpan, setAttributes, getMeter
    handle.ts             # TraceHandle implementation
    context-scope.ts      # interaction contextScopes bridge
    attributes.ts         # extract guild/user/command fields safely
    metrics.ts            # core histograms
    instrument/
      interactions.ts
      events.ts
      rest.ts
      cache.ts
    seyfert.ts            # module augmentation fallback types
  test/
    plugin.test.mts
    interactions.test.mts
    events.test.mts
    rest.test.mts
    cache.test.mts
    trace-api.test.mts
    types.ts
    tsconfig.json
    vitest.config.mts
```

### 8.1 Dependencies

**peerDependencies**

- `seyfert`: `>=5.0.0-0` (dev: `github:tiramisulabs/seyfert#main` while v5 unreleased, matching logger PR)
- `@opentelemetry/api`: compatible range (peer so one API instance is shared)

**dependencies** (runtime, needed for auto NodeSDK)

- `@opentelemetry/sdk-node` (or equivalent split packages if tree-shaking requires — prefer `sdk-node` like Elysia for DX)

**devDependencies**

- exporters/processors only as needed for tests/docs examples
- `vitest`, `typescript`, `@types/node`, workspace patterns from siblings

Do **not** hard-depend on a specific OTLP exporter; users pass `spanProcessors` / exporters themselves (Elysia docs pattern).

### 8.2 Workspace

- Add `packages/opentelemetry` via existing `packages/*` workspace glob.
- Scripts: `build`, `test`, `lint`, `format`, `checkb` aligned with `@slipher/logger` / cooldown.

---

## 9. Testing strategy

| Area | Assertions |
| --- | --- |
| SDK ownership | Starts NodeSDK under proxy provider; skips when real provider present |
| Interactions | Root + child spans, attributes, error status, metrics sample |
| Events | Root span per handler, teardown unwrap |
| REST | CLIENT span, status codes, no auth leakage, restore on teardown |
| Cache | hit attribute, skipResources, restore methods |
| Flags | Each `instrument.*: false` disables that surface only |
| Helpers | `record` ends span; error path sets status |
| `checkIfShouldTrace` | false → no root span |
| Types | `ctx.trace` / `client.trace` available under `RegisterPlugins` |

Use in-memory span exporter / metric reader from OpenTelemetry SDK testing utilities. Prefer not requiring a live Discord connection.

---

## 10. README outline

1. What it does (full-surface OTel for Seyfert).
2. Install + minimal OTLP example.
3. `instrument` flags.
4. `client.trace` / `ctx.trace` + helpers.
5. Attribute reference table.
6. Metrics reference.
7. Coexistence with preload SDK and with `@slipher/logger`.
8. Security notes (no bodies/tokens).

---

## 11. Implementation phases (for planning skill)

1. **Scaffold** package, tsconfig, vitest, empty plugin with name + setup/teardown no-ops.
2. **SDK + trace-api + TraceHandle** with unit tests.
3. **Interactions** instrumentor + context scope + metrics.
4. **Events** instrumentor.
5. **REST** wrap.
6. **Cache** wrap + skip list.
7. **Integration tests** + README.
8. **Typecheck** against Seyfert v5 plugin types.

Phases 3–6 are independently testable; 2 is a hard dependency for all.

---

## 12. Open points resolved in design review

| Question | Decision |
| --- | --- |
| Surface area | Full (interactions + events + REST + cache) |
| SDK | Elysia-style auto NodeSDK if no real provider |
| REST/cache approach | Wrap Seyfert layers (not HTTP auto-instrumentation only) |
| Public surface | Helpers + `ctx.trace` / `client.trace` |
| Signals | Traces + 4 core duration histograms |
| Package shape | Monolithic plugin + internal modules + `instrument` flags |
| Package name | `@slipher/opentelemetry` |

---

## 13. Success criteria

- Drop-in `definePlugins(opentelemetry({ spanProcessors: [...] }))` produces exportable traces for a command that hits REST and cache.
- Disabling any `instrument` flag removes only that surface.
- Plugin teardown restores client behavior and flushes owned SDK.
- No secrets in span attributes in default configuration.
- API feel matches Elysia helpers + slipher plugin conventions.
`}