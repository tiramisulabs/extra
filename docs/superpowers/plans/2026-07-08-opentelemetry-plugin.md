# @slipher/opentelemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `@slipher/opentelemetry`, a Seyfert v5 plugin that auto-starts NodeSDK (Elysia-style), instruments interactions/events/REST/cache, exports Elysia-like helpers plus `client.trace`/`ctx.trace`, and records four core duration histograms.

**Architecture:** One monorepo package with `createPlugin({ name, client, ctx, options, register, setup, teardown })`. Internal modules own SDK lifecycle, trace helpers, metrics, attribute extraction, and four instrumentors toggled by `instrument.*` flags. Spans use `@opentelemetry/api`; the plugin owns `NodeSDK` only when no real tracer provider is registered.

**Tech Stack:** TypeScript (CJS emit like siblings), Seyfert v5 (`github:tiramisulabs/seyfert#main`), `@opentelemetry/api` (peer), `@opentelemetry/sdk-node` (dep), Vitest, Biome.

**Spec:** `docs/superpowers/specs/2026-07-08-opentelemetry-plugin-design.md`

---

## File map

| Path | Responsibility |
| --- | --- |
| `packages/opentelemetry/package.json` | Package metadata, deps, scripts |
| `packages/opentelemetry/tsconfig.json` | Build config (src → lib) |
| `packages/opentelemetry/src/index.ts` | Public exports |
| `packages/opentelemetry/src/options.ts` | Options types, defaults, flag resolution |
| `packages/opentelemetry/src/sdk.ts` | `shouldStartNodeSDK`, start/stop owned SDK |
| `packages/opentelemetry/src/trace-api.ts` | `getTracer`, `record`, `getCurrentSpan`, `setAttributes`, `getMeter` |
| `packages/opentelemetry/src/handle.ts` | `TraceHandle` for `client.trace` / `ctx.trace` |
| `packages/opentelemetry/src/metrics.ts` | Four histograms + record helpers |
| `packages/opentelemetry/src/attributes.ts` | Safe extraction of Discord context fields |
| `packages/opentelemetry/src/context-scope.ts` | Interaction root span via `contextScopes` |
| `packages/opentelemetry/src/instrument/interactions.ts` | Command/component/modal lifecycle children |
| `packages/opentelemetry/src/instrument/events.ts` | Gateway event root spans |
| `packages/opentelemetry/src/instrument/rest.ts` | Discord REST CLIENT spans |
| `packages/opentelemetry/src/instrument/cache.ts` | Cache adapter INTERNAL spans |
| `packages/opentelemetry/src/plugin.ts` | `opentelemetry()` factory |
| `packages/opentelemetry/src/seyfert.ts` | Module augmentation fallback |
| `packages/opentelemetry/test/*` | Vitest + typecheck |
| `packages/opentelemetry/README.md` | User docs |

---

### Task 1: Scaffold package

**Files:**
- Create: `packages/opentelemetry/package.json`
- Create: `packages/opentelemetry/tsconfig.json`
- Create: `packages/opentelemetry/src/index.ts`
- Create: `packages/opentelemetry/src/plugin.ts`
- Create: `packages/opentelemetry/test/vitest.config.mts`
- Create: `packages/opentelemetry/test/tsconfig.json`
- Create: `packages/opentelemetry/test/types.ts`
- Create: `packages/opentelemetry/test/scaffold.test.mts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@slipher/opentelemetry",
  "version": "0.1.0",
  "private": false,
  "license": "MIT",
  "publishConfig": {
    "access": "public"
  },
  "files": ["lib/**"],
  "main": "./lib/index.js",
  "module": "./lib/index.js",
  "types": "./lib/index.d.ts",
  "exports": {
    ".": {
      "types": "./lib/index.d.ts",
      "import": "./lib/index.js",
      "require": "./lib/index.js",
      "default": "./lib/index.js"
    },
    "./package.json": "./package.json"
  },
  "scripts": {
    "dev": "tsc --watch",
    "build": "tsc",
    "lint": "biome lint --write ./src ./test",
    "format": "biome format --write ./src ./test",
    "checkb": "biome check --write --no-errors-on-unmatched ./src ./test",
    "typecheck": "tsc --noEmit --project ./test/tsconfig.json",
    "test": "pnpm typecheck && vitest run --config ./test/vitest.config.mts ./test/",
    "prepublish": "pnpm build"
  },
  "dependencies": {
    "@opentelemetry/sdk-node": "^0.203.0"
  },
  "devDependencies": {
    "@opentelemetry/api": "^1.9.0",
    "@opentelemetry/sdk-metrics": "^2.0.0",
    "@opentelemetry/sdk-trace-base": "^2.0.0",
    "@types/node": "^25.0.10",
    "seyfert": "github:tiramisulabs/seyfert#main",
    "typescript": "^5.9.3"
  },
  "peerDependencies": {
    "@opentelemetry/api": "^1.9.0",
    "seyfert": ">=5.0.0-0"
  }
}
```

Pin OTel package major/minor to whatever resolves cleanly with `pnpm install` at implement time; keep `@opentelemetry/api` as peer.

- [ ] **Step 2: Create `tsconfig.json`**

Copy the logger package shape:

```json
{
  "compilerOptions": {
    "module": "CommonJS",
    "target": "ESNext",
    "lib": ["ESNext", "DOM"],
    "moduleResolution": "node",
    "declaration": true,
    "sourceMap": false,
    "strict": true,
    "esModuleInterop": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "preserveConstEnums": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "strictFunctionTypes": true,
    "noImplicitThis": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "skipLibCheck": true,
    "noErrorTruncation": true,
    "rootDir": "./src",
    "outDir": "./lib",
    "stripInternal": true
  },
  "exclude": ["**/lib", "**/test"]
}
```

- [ ] **Step 3: Create minimal plugin + index**

`src/plugin.ts`:

```ts
import { createPlugin, type SeyfertPlugin } from 'seyfert';
import type { OpenTelemetryPluginOptions } from './options';

export function opentelemetry(_options: OpenTelemetryPluginOptions = {}): SeyfertPlugin {
  return createPlugin({
    name: '@slipher/opentelemetry',
    setup() {},
    teardown() {},
  });
}
```

`src/options.ts` (stub for compile):

```ts
import type { ContextManager } from '@opentelemetry/api';
import type { NodeSDKConfiguration } from '@opentelemetry/sdk-node';

export interface InstrumentFlags {
  interactions?: boolean;
  events?: boolean;
  rest?: boolean;
  cache?: boolean;
}

export type TraceSource =
  | { kind: 'command' | 'component' | 'modal'; context: unknown }
  | { kind: 'event'; name: string; args: readonly unknown[] }
  | { kind: 'rest'; method: string; path: string }
  | { kind: 'cache'; op: string; resource: string };

export interface OpenTelemetryPluginOptions extends Partial<NodeSDKConfiguration> {
  serviceName?: string;
  instrument?: InstrumentFlags;
  checkIfShouldTrace?: (source: TraceSource) => boolean;
  contextManager?: ContextManager;
  cache?: {
    skipResources?: string[];
  };
}
```

`src/index.ts`:

```ts
import './seyfert';

export { opentelemetry } from './plugin';
export type {
  InstrumentFlags,
  OpenTelemetryPluginOptions,
  TraceSource,
} from './options';
```

`src/seyfert.ts`:

```ts
import type {} from 'seyfert';
import type { TraceHandle } from './handle';

declare module 'seyfert' {
  interface Client<Ready extends boolean = boolean> {
    trace?: TraceHandle;
  }

  interface HttpClient {
    trace?: TraceHandle;
  }

  interface WorkerClient<Ready extends boolean = boolean> {
    trace?: TraceHandle;
  }

  interface ExtendContext {
    trace?: TraceHandle;
  }

  interface UsingClient {
    trace?: TraceHandle;
  }
}
```

`src/handle.ts` stub:

```ts
import type { Attributes, Span } from '@opentelemetry/api';
import type { StartActiveSpan } from './trace-api';

export interface TraceHandle {
  readonly span: Span | undefined;
  setAttributes(attributes: Attributes): boolean;
  recordException(error: unknown): void;
  record: StartActiveSpan;
}
```

`src/trace-api.ts` stub:

```ts
import type { Span, SpanOptions, Context } from '@opentelemetry/api';

export type ActiveSpanArgs<F extends (span: Span) => unknown = (span: Span) => unknown> =
  | [name: string, fn: F]
  | [name: string, options: SpanOptions, fn: F]
  | [name: string, options: SpanOptions, context: Context, fn: F];

export type StartActiveSpan = (...args: ActiveSpanArgs) => unknown;
```

- [ ] **Step 4: Create test harness files**

`test/vitest.config.mts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    isolate: false,
  },
});
```

`test/tsconfig.json`:

```json
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "noEmit": true,
    "rootDir": ".."
  },
  "include": ["./types.ts"],
  "exclude": []
}
```

`test/types.ts`:

```ts
import { definePlugins, type RegisterPlugins } from 'seyfert';
import { opentelemetry } from '../src';

const plugins = definePlugins(opentelemetry({ serviceName: 'types-check' }));

declare module 'seyfert' {
  interface Register extends RegisterPlugins<typeof plugins> {}
}

export type _Plugins = typeof plugins;
```

`test/scaffold.test.mts`:

```ts
import { assert, describe, test } from 'vitest';
import { opentelemetry } from '../src';

describe('scaffold', () => {
  test('plugin name is stable', () => {
    const plugin = opentelemetry();
    assert.equal(plugin.name, '@slipher/opentelemetry');
  });
});
```

- [ ] **Step 5: Install and run tests**

```bash
pnpm install
pnpm --filter @slipher/opentelemetry test
```

Expected: typecheck + vitest PASS (one scaffold test).

If `NodeSDKConfiguration` import path differs in the resolved `@opentelemetry/sdk-node` version, adjust `options.ts` to:

```ts
type NodeSDKOptions = NonNullable<ConstructorParameters<typeof NodeSDK>[0]>;
```

- [ ] **Step 6: Commit**

```bash
git add packages/opentelemetry
git commit -m "feat(opentelemetry): scaffold @slipher/opentelemetry package"
```

---

### Task 2: Options resolution

**Files:**
- Modify: `packages/opentelemetry/src/options.ts`
- Create: `packages/opentelemetry/test/options.test.mts`

- [ ] **Step 1: Write failing tests**

```ts
import { assert, describe, test } from 'vitest';
import {
  DEFAULT_CACHE_SKIP_RESOURCES,
  DEFAULT_SERVICE_NAME,
  resolveInstrumentFlags,
  resolvePluginOptions,
} from '../src/options';

describe('resolveInstrumentFlags', () => {
  test('defaults all surfaces on', () => {
    assert.deepEqual(resolveInstrumentFlags(), {
      interactions: true,
      events: true,
      rest: true,
      cache: true,
    });
  });

  test('allows disabling one surface', () => {
    assert.equal(resolveInstrumentFlags({ cache: false }).cache, false);
    assert.equal(resolveInstrumentFlags({ cache: false }).rest, true);
  });
});

describe('resolvePluginOptions', () => {
  test('fills serviceName and skipResources defaults', () => {
    const resolved = resolvePluginOptions({});
    assert.equal(resolved.serviceName, DEFAULT_SERVICE_NAME);
    assert.deepEqual(resolved.cache.skipResources, [...DEFAULT_CACHE_SKIP_RESOURCES]);
    assert.equal(resolved.checkIfShouldTrace({ kind: 'event', name: 'x', args: [] }), true);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
pnpm --filter @slipher/opentelemetry exec vitest run --config ./test/vitest.config.mts ./test/options.test.mts
```

- [ ] **Step 3: Implement resolution in `options.ts`**

```ts
import type { ContextManager } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';

type NodeSDKOptions = NonNullable<ConstructorParameters<typeof NodeSDK>[0]>;

export const DEFAULT_SERVICE_NAME = 'seyfert';

/** High-churn cache resources skipped by default. */
export const DEFAULT_CACHE_SKIP_RESOURCES = ['presences', 'voiceStates'] as const;

export interface InstrumentFlags {
  interactions?: boolean;
  events?: boolean;
  rest?: boolean;
  cache?: boolean;
}

export interface ResolvedInstrumentFlags {
  interactions: boolean;
  events: boolean;
  rest: boolean;
  cache: boolean;
}

export type TraceSource =
  | { kind: 'command' | 'component' | 'modal'; context: unknown }
  | { kind: 'event'; name: string; args: readonly unknown[] }
  | { kind: 'rest'; method: string; path: string }
  | { kind: 'cache'; op: string; resource: string };

export interface OpenTelemetryPluginOptions extends Partial<NodeSDKOptions> {
  serviceName?: string;
  instrument?: InstrumentFlags;
  checkIfShouldTrace?: (source: TraceSource) => boolean;
  contextManager?: ContextManager;
  cache?: {
    skipResources?: string[];
  };
}

export interface ResolvedOpenTelemetryOptions {
  serviceName: string;
  instrument: ResolvedInstrumentFlags;
  checkIfShouldTrace: (source: TraceSource) => boolean;
  contextManager?: ContextManager;
  cache: { skipResources: ReadonlySet<string> };
  /** Remaining NodeSDK fields (spanProcessors, instrumentations, …) */
  sdk: Partial<NodeSDKOptions>;
}

export function resolveInstrumentFlags(flags: InstrumentFlags = {}): ResolvedInstrumentFlags {
  return {
    interactions: flags.interactions ?? true,
    events: flags.events ?? true,
    rest: flags.rest ?? true,
    cache: flags.cache ?? true,
  };
}

export function resolvePluginOptions(options: OpenTelemetryPluginOptions = {}): ResolvedOpenTelemetryOptions {
  const {
    serviceName = DEFAULT_SERVICE_NAME,
    instrument,
    checkIfShouldTrace = () => true,
    contextManager,
    cache,
    ...sdk
  } = options;

  const skip = cache?.skipResources ?? [...DEFAULT_CACHE_SKIP_RESOURCES];

  return {
    serviceName,
    instrument: resolveInstrumentFlags(instrument),
    checkIfShouldTrace,
    contextManager,
    cache: { skipResources: new Set(skip) },
    sdk,
  };
}
```

- [ ] **Step 4: Re-run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/opentelemetry/src/options.ts packages/opentelemetry/test/options.test.mts
git commit -m "feat(opentelemetry): resolve instrument flags and plugin options"
```

---

### Task 3: SDK ownership

**Files:**
- Create: `packages/opentelemetry/src/sdk.ts`
- Create: `packages/opentelemetry/test/sdk.test.mts`
- Create: `packages/opentelemetry/test/helpers/otel-test-provider.mts` (shared test helper)

- [ ] **Step 1: Write test helper**

```ts
// test/helpers/otel-test-provider.mts
import { trace, metrics } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { MeterProvider, InMemoryMetricExporter, PeriodicExportingMetricReader, AggregationTemporality } from '@opentelemetry/sdk-metrics';

export function installTestTracer() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);
  return {
    exporter,
    provider,
    async shutdown() {
      await provider.shutdown();
      // reset is limited; tests should run with isolate:false carefully.
      // Prefer one provider per file and clear exporter between tests:
      exporter.reset();
    },
  };
}

export function installTestMeter() {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 100 });
  const provider = new MeterProvider({ readers: [reader] });
  metrics.setGlobalMeterProvider(provider);
  return { exporter, provider, reader };
}
```

Adjust imports to match the installed `@opentelemetry/sdk-trace-base` / `sdk-metrics` APIs (constructor shapes changed across majors — follow package typings).

- [ ] **Step 2: Write failing tests for `shouldStartNodeSDK`**

```ts
import { assert, describe, test } from 'vitest';
import { ProxyTracerProvider, trace } from '@opentelemetry/api';
import { shouldStartNodeSDK, startOwnedSdk, type OwnedSdk } from '../src/sdk';
import { installTestTracer } from './helpers/otel-test-provider.mts';

describe('shouldStartNodeSDK', () => {
  test('true under default proxy provider without delegate', () => {
    // When no global provider has been set, getTracerProvider is a ProxyTracerProvider.
    // Do not call installTestTracer first for this case — run in a dedicated file or order.
    assert.equal(shouldStartNodeSDK(trace.getTracerProvider()), true);
  });

  test('false when a real provider is installed', () => {
    const { provider, exporter } = installTestTracer();
    try {
      assert.equal(shouldStartNodeSDK(trace.getTracerProvider()), false);
    } finally {
      exporter.reset();
      void provider.shutdown();
    }
  });
});
```

Note: global OTel providers are process-wide. Prefer **one describe block order** or reset strategy documented in the helper. If `setGlobalTracerProvider` cannot reset to proxy, test `shouldStartNodeSDK` with constructed `ProxyTracerProvider` vs `BasicTracerProvider` instances **without** relying on globals:

```ts
assert.equal(shouldStartNodeSDK(new ProxyTracerProvider()), true);
assert.equal(shouldStartNodeSDK(new BasicTracerProvider()), false);
```

- [ ] **Step 3: Implement `sdk.ts`**

```ts
import {
  trace,
  type ContextManager,
  type TracerProvider,
  ProxyTracerProvider,
} from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import type { ResolvedOpenTelemetryOptions } from './options';

export function shouldStartNodeSDK(provider: TracerProvider): boolean {
  if (!(provider instanceof ProxyTracerProvider)) return false;
  // Elysia pattern: no real delegate registered yet
  return provider.getDelegateTracer('check') === undefined;
}

export interface OwnedSdk {
  sdk: NodeSDK;
  shutdown(): Promise<void>;
}

export function startOwnedSdk(resolved: ResolvedOpenTelemetryOptions): OwnedSdk | undefined {
  if (!shouldStartNodeSDK(trace.getTracerProvider())) return undefined;

  const sdk = new NodeSDK({
    ...resolved.sdk,
    serviceName: resolved.serviceName,
  });
  sdk.start();

  if (resolved.contextManager) {
    try {
      // Only set if no context manager is active (same spirit as Elysia)
      resolved.contextManager.enable();
      // @ts-expect-error private guard exists on some API builds
      if (!trace.getTracerProvider()) {
        /* no-op */
      }
    } catch {
      // ignore double-enable
    }
  }

  return {
    sdk,
    shutdown: () => sdk.shutdown(),
  };
}
```

Refine context-manager wiring against Elysia’s `otelContext.setGlobalContextManager` if needed:

```ts
import { context as otelContext } from '@opentelemetry/api';
// if no manager: contextManager.enable(); otelContext.setGlobalContextManager(contextManager)
```

- [ ] **Step 4: Tests PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/opentelemetry/src/sdk.ts packages/opentelemetry/test/sdk.test.mts packages/opentelemetry/test/helpers
git commit -m "feat(opentelemetry): Elysia-style NodeSDK ownership helpers"
```

---

### Task 4: Trace API helpers

**Files:**
- Modify: `packages/opentelemetry/src/trace-api.ts`
- Create: `packages/opentelemetry/test/trace-api.test.mts`
- Modify: `packages/opentelemetry/src/index.ts` (export helpers)

- [ ] **Step 1: Failing tests**

```ts
import { assert, describe, test } from 'vitest';
import { SpanStatusCode } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { trace } from '@opentelemetry/api';
import { getCurrentSpan, record, setAttributes, getTracer } from '../src/trace-api';

function withProvider(run: (exporter: InMemorySpanExporter) => Promise<void> | void) {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const previous = trace.getTracerProvider();
  trace.setGlobalTracerProvider(provider);
  return Promise.resolve(run(exporter)).finally(async () => {
    await provider.shutdown();
    // leave provider as-is if reset unsupported
    void previous;
  });
}

describe('record', () => {
  test('ends span on success', async () => {
    await withProvider(async exporter => {
      const value = await record('work', async span => {
        span.setAttribute('k', 1);
        return 42;
      });
      assert.equal(value, 42);
      const spans = exporter.getFinishedSpans();
      assert.equal(spans.length, 1);
      assert.equal(spans[0].name, 'work');
      assert.equal(spans[0].attributes.k, 1);
    });
  });

  test('records error status and rethrows', async () => {
    await withProvider(async exporter => {
      const err = new Error('boom');
      await assert.rejects(() =>
        record('work', () => {
          throw err;
        }),
      );
      const span = exporter.getFinishedSpans()[0];
      assert.equal(span.status.code, SpanStatusCode.ERROR);
    });
  });
});

describe('setAttributes / getCurrentSpan', () => {
  test('setAttributes returns false without active span', () => {
    assert.equal(setAttributes({ a: 1 }), false);
  });

  test('setAttributes applies inside record', async () => {
    await withProvider(async exporter => {
      await record('work', () => {
        assert.ok(getCurrentSpan());
        assert.equal(setAttributes({ a: 1 }), true);
      });
      assert.equal(exporter.getFinishedSpans()[0].attributes.a, 1);
    });
  });
});
```

- [ ] **Step 2: Implement `trace-api.ts`** (mirror Elysia)

```ts
import {
  trace,
  metrics,
  SpanStatusCode,
  type Attributes,
  type Context,
  type Span,
  type SpanOptions,
  type Tracer,
} from '@opentelemetry/api';

let activeServiceName = 'seyfert';

export function setTraceServiceName(name: string): void {
  activeServiceName = name;
}

export function getTracer(): Tracer {
  return trace.getTracer(activeServiceName);
}

export function getMeter() {
  return metrics.getMeter(activeServiceName);
}

export type ActiveSpanArgs<F extends (span: Span) => unknown = (span: Span) => unknown> =
  | [name: string, fn: F]
  | [name: string, options: SpanOptions, fn: F]
  | [name: string, options: SpanOptions, context: Context, fn: F];

export type StartActiveSpan = (...args: ActiveSpanArgs) => unknown;

function createActiveSpanHandler(fn: (span: Span) => unknown) {
  return function handler(span: Span) {
    try {
      const result = fn(span);
      if (result !== null && typeof result === 'object' && typeof (result as Promise<unknown>).then === 'function') {
        return Promise.resolve(result).then(
          value => {
            span.end();
            return value;
          },
          rejectResult => {
            const err = rejectResult instanceof Error ? rejectResult : new Error(String(rejectResult));
            span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
            span.recordException(err);
            span.end();
            throw rejectResult;
          },
        );
      }
      span.end();
      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.recordException(err);
      span.end();
      throw error;
    }
  };
}

export const startActiveSpan: StartActiveSpan = (...args: ActiveSpanArgs) => {
  const tracer = getTracer();
  switch (args.length) {
    case 2:
      return tracer.startActiveSpan(args[0], createActiveSpanHandler(args[1]));
    case 3:
      return tracer.startActiveSpan(args[0], args[1], createActiveSpanHandler(args[2]));
    case 4:
      return tracer.startActiveSpan(args[0], args[1], args[2], createActiveSpanHandler(args[3]));
  }
};

export const record = startActiveSpan;

export function startSpan(name: string, options?: SpanOptions, context?: Context): Span {
  return getTracer().startSpan(name, options, context);
}

export function getCurrentSpan(): Span | undefined {
  return trace.getActiveSpan();
}

export function setAttributes(attributes: Attributes): boolean {
  const span = getCurrentSpan();
  if (!span) return false;
  span.setAttributes(attributes);
  return true;
}
```

- [ ] **Step 3: Export from `index.ts`**

```ts
export {
  getTracer,
  getMeter,
  getCurrentSpan,
  setAttributes,
  startSpan,
  startActiveSpan,
  record,
} from './trace-api';
```

- [ ] **Step 4: Tests PASS + commit**

```bash
git commit -m "feat(opentelemetry): add Elysia-compatible trace helpers"
```

---

### Task 5: TraceHandle

**Files:**
- Modify: `packages/opentelemetry/src/handle.ts`
- Create: `packages/opentelemetry/test/handle.test.mts`

- [ ] **Step 1: Failing tests**

```ts
import { assert, describe, test } from 'vitest';
import { createTraceHandle } from '../src/handle';
import { record } from '../src/trace-api';
// use same withProvider helper as trace-api tests

describe('TraceHandle', () => {
  test('span is undefined outside active span', () => {
    const handle = createTraceHandle();
    assert.equal(handle.span, undefined);
    assert.equal(handle.setAttributes({ a: 1 }), false);
  });

  test('span reflects active span inside record', async () => {
    // install provider…
    const handle = createTraceHandle();
    await record('work', span => {
      assert.equal(handle.span, span);
      assert.equal(handle.setAttributes({ a: 1 }), true);
    });
  });
});
```

- [ ] **Step 2: Implement**

```ts
import type { Attributes, Span } from '@opentelemetry/api';
import { getCurrentSpan, record, type StartActiveSpan } from './trace-api';

export interface TraceHandle {
  readonly span: Span | undefined;
  setAttributes(attributes: Attributes): boolean;
  recordException(error: unknown): void;
  record: StartActiveSpan;
}

export function createTraceHandle(): TraceHandle {
  return {
    get span() {
      return getCurrentSpan();
    },
    setAttributes(attributes) {
      const span = getCurrentSpan();
      if (!span) return false;
      span.setAttributes(attributes);
      return true;
    },
    recordException(error) {
      const span = getCurrentSpan();
      if (!span) return;
      const err = error instanceof Error ? error : new Error(String(error));
      span.recordException(err);
    },
    record,
  };
}
```

- [ ] **Step 3: PASS + commit**

```bash
git commit -m "feat(opentelemetry): add TraceHandle for client/ctx.trace"
```

---

### Task 6: Core metrics

**Files:**
- Create: `packages/opentelemetry/src/metrics.ts`
- Create: `packages/opentelemetry/test/metrics.test.mts`

- [ ] **Step 1: Implement instruments**

```ts
import type { Attributes } from '@opentelemetry/api';
import type { Histogram } from '@opentelemetry/api';
import { getMeter } from './trace-api';
import type { ResolvedInstrumentFlags } from './options';

const DURATION_BOUNDARIES = [
  0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10, 30, 60,
];

export interface CoreMetrics {
  recordInteraction(durationSeconds: number, attributes: Attributes): void;
  recordEvent(durationSeconds: number, attributes: Attributes): void;
  recordRest(durationSeconds: number, attributes: Attributes): void;
  recordCache(durationSeconds: number, attributes: Attributes): void;
}

export function createCoreMetrics(serviceName: string, instrument: ResolvedInstrumentFlags): CoreMetrics {
  const meter = getMeter(); // ensure setTraceServiceName called first in plugin setup
  void serviceName;

  const interaction = instrument.interactions
    ? meter.createHistogram('seyfert.interaction.duration', {
        unit: 's',
        description: 'Duration of Seyfert interaction handlers',
        advice: { explicitBucketBoundaries: DURATION_BOUNDARIES },
      })
    : undefined;

  const event = instrument.events
    ? meter.createHistogram('seyfert.event.duration', {
        unit: 's',
        description: 'Duration of Seyfert gateway event handlers',
        advice: { explicitBucketBoundaries: DURATION_BOUNDARIES },
      })
    : undefined;

  const rest = instrument.rest
    ? meter.createHistogram('seyfert.rest.duration', {
        unit: 's',
        description: 'Duration of Discord REST calls',
        advice: { explicitBucketBoundaries: DURATION_BOUNDARIES },
      })
    : undefined;

  const cache = instrument.cache
    ? meter.createHistogram('seyfert.cache.operation.duration', {
        unit: 's',
        description: 'Duration of Seyfert cache operations',
        advice: { explicitBucketBoundaries: DURATION_BOUNDARIES },
      })
    : undefined;

  const record = (histogram: Histogram | undefined, value: number, attributes: Attributes) => {
    histogram?.record(value, attributes);
  };

  return {
    recordInteraction: (v, a) => record(interaction, v, a),
    recordEvent: (v, a) => record(event, v, a),
    recordRest: (v, a) => record(rest, v, a),
    recordCache: (v, a) => record(cache, v, a),
  };
}

export function durationSecondsSince(startMs: number): number {
  return (performance.now() - startMs) / 1000;
}
```

If `advice.explicitBucketBoundaries` is unsupported in the installed API version, omit `advice` and keep unit/description only.

- [ ] **Step 2: Unit test that calling record methods does not throw when instruments disabled**

```ts
const metrics = createCoreMetrics('test', {
  interactions: false,
  events: false,
  rest: false,
  cache: false,
});
metrics.recordInteraction(0.01, {});
// no throw
```

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(opentelemetry): add core duration histograms"
```

---

### Task 7: Attribute extraction

**Files:**
- Create: `packages/opentelemetry/src/attributes.ts`
- Create: `packages/opentelemetry/test/attributes.test.mts`

- [ ] **Step 1: Tests**

```ts
import { assert, describe, test } from 'vitest';
import { extractInteractionAttributes, interactionSpanName } from '../src/attributes';

describe('extractInteractionAttributes', () => {
  test('pulls command fields', () => {
    const attrs = extractInteractionAttributes('command', {
      fullCommandName: 'admin ban',
      guildId: 'g1',
      channelId: 'c1',
      author: { id: 'u1' },
      interaction: { id: 'i1' },
      shardId: 2,
    });
    assert.equal(attrs['seyfert.interaction.kind'], 'command');
    assert.equal(attrs['seyfert.command'], 'admin ban');
    assert.equal(attrs['seyfert.guild_id'], 'g1');
    assert.equal(attrs['seyfert.user_id'], 'u1');
    assert.equal(attrs['seyfert.shard_id'], 2);
  });
});

describe('interactionSpanName', () => {
  test('formats command name', () => {
    assert.equal(interactionSpanName('command', { fullCommandName: 'ping' }), 'command ping');
  });

  test('truncates long customId', () => {
    const id = 'x'.repeat(200);
    const name = interactionSpanName('component', { customId: id });
    assert.ok(name.length < 120);
  });
});
```

- [ ] **Step 2: Implement safe extraction** (no secrets; only known Discord ids)

```ts
import type { Attributes } from '@opentelemetry/api';

export type InteractionKind = 'command' | 'component' | 'modal';

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

const CUSTOM_ID_MAX = 64;

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

export function extractInteractionAttributes(kind: InteractionKind, context: unknown): Attributes {
  const source = asRecord(context);
  const interaction = asRecord(source.interaction ?? source);
  const member = asRecord(source.member ?? interaction.member);
  const author = asRecord(source.author ?? source.user ?? interaction.user ?? member.user);

  const attrs: Attributes = {
    'seyfert.interaction.kind': kind,
  };

  const command = getString(source.fullCommandName ?? source.commandName ?? asRecord(source.command).name);
  if (command) attrs['seyfert.command'] = command;

  const customId = getString(source.customId ?? interaction.customId);
  if (customId) attrs['seyfert.custom_id'] = truncate(customId, CUSTOM_ID_MAX);

  const guildId = getString(source.guildId ?? interaction.guildId);
  if (guildId) attrs['seyfert.guild_id'] = guildId;

  const channelId = getString(source.channelId ?? interaction.channelId);
  if (channelId) attrs['seyfert.channel_id'] = channelId;

  const userId = getString(author.id);
  if (userId) attrs['seyfert.user_id'] = userId;

  const interactionId = getString(source.interactionId ?? interaction.id ?? source.id);
  if (interactionId) attrs['seyfert.interaction_id'] = interactionId;

  const shardId = getNumber(source.shardId ?? interaction.shardId);
  if (shardId !== undefined) attrs['seyfert.shard_id'] = shardId;

  return attrs;
}

export function interactionSpanName(kind: InteractionKind, context: unknown): string {
  const source = asRecord(context);
  if (kind === 'command') {
    const command = getString(source.fullCommandName ?? source.commandName) ?? 'unknown';
    return `command ${command}`;
  }
  const customId = getString(source.customId ?? asRecord(source.interaction).customId) ?? 'unknown';
  return `${kind} ${truncate(customId, CUSTOM_ID_MAX)}`;
}
```

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(opentelemetry): safe interaction attribute extraction"
```

---

### Task 8: Plugin wiring (setup/teardown + handle install)

**Files:**
- Modify: `packages/opentelemetry/src/plugin.ts`
- Create: `packages/opentelemetry/test/plugin.test.mts`

- [ ] **Step 1: Wire factory**

```ts
import { createPlugin, type SeyfertPlugin } from 'seyfert';
import { resolvePluginOptions, type OpenTelemetryPluginOptions } from './options';
import { startOwnedSdk, type OwnedSdk } from './sdk';
import { setTraceServiceName } from './trace-api';
import { createTraceHandle, type TraceHandle } from './handle';
import { createCoreMetrics, type CoreMetrics } from './metrics';
import { createInteractionContextScope } from './context-scope';
import { registerInteractionInstrumentation } from './instrument/interactions';
import { instrumentEvents } from './instrument/events';
import { instrumentRest } from './instrument/rest';
import { instrumentCache } from './instrument/cache';

export interface OpenTelemetryPlugin extends SeyfertPlugin {
  name: '@slipher/opentelemetry';
}

export function opentelemetry(options: OpenTelemetryPluginOptions = {}): OpenTelemetryPlugin {
  const resolved = resolvePluginOptions(options);
  const handle = createTraceHandle();
  let owned: OwnedSdk | undefined;
  let metrics: CoreMetrics | undefined;
  const cleanups: Array<() => void> = [];

  return createPlugin({
    name: '@slipher/opentelemetry',
    client: {
      trace: () => handle,
    },
    ctx: {
      trace: () => handle,
    },
    options() {
      if (!resolved.instrument.interactions) return {};
      return {
        contextScopes: [
          createInteractionContextScope({
            serviceName: resolved.serviceName,
            checkIfShouldTrace: resolved.checkIfShouldTrace,
            getMetrics: () => metrics,
          }),
        ],
      };
    },
    register(api) {
      if (!resolved.instrument.interactions) return;
      registerInteractionInstrumentation(api, {
        checkIfShouldTrace: resolved.checkIfShouldTrace,
      });
    },
    setup(client) {
      setTraceServiceName(resolved.serviceName);
      owned = startOwnedSdk(resolved);
      metrics = createCoreMetrics(resolved.serviceName, resolved.instrument);

      if (resolved.instrument.events) {
        cleanups.push(instrumentEvents(client, { checkIfShouldTrace: resolved.checkIfShouldTrace, getMetrics: () => metrics }));
      }
      if (resolved.instrument.rest) {
        cleanups.push(instrumentRest(client, { checkIfShouldTrace: resolved.checkIfShouldTrace, getMetrics: () => metrics }));
      }
      if (resolved.instrument.cache) {
        cleanups.push(
          instrumentCache(client, {
            checkIfShouldTrace: resolved.checkIfShouldTrace,
            skipResources: resolved.cache.skipResources,
            getMetrics: () => metrics,
          }),
        );
      }
    },
    async teardown() {
      try {
        for (const cleanup of cleanups.splice(0).reverse()) {
          try {
            cleanup();
          } catch {
            // never throw from instrumentation cleanup
          }
        }
        if (owned) await owned.shutdown();
      } finally {
        owned = undefined;
        metrics = undefined;
      }
    },
  }) as OpenTelemetryPlugin;
}
```

Until instrument modules exist, use no-op stubs that return `() => {}` so the plugin compiles and tests can assert setup/teardown.

- [ ] **Step 2: Test plugin name, setup starts without throw, teardown without throw**

```ts
const plugin = opentelemetry({
  instrument: { interactions: false, events: false, rest: false, cache: false },
  // pass spanProcessors: [] or noop to avoid real export
});
assert.equal(plugin.name, '@slipher/opentelemetry');
await plugin.setup?.({} as never);
await plugin.teardown?.({} as never);
```

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(opentelemetry): wire createPlugin lifecycle and TraceHandle"
```

---

### Task 9: Interaction context scope + lifecycle children

**Files:**
- Create: `packages/opentelemetry/src/context-scope.ts`
- Create: `packages/opentelemetry/src/instrument/interactions.ts`
- Create: `packages/opentelemetry/test/interactions.test.mts`

- [ ] **Step 1: Context scope — start root span, run, end, metrics**

```ts
// context-scope.ts
import { context as otelContext, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { ContextScope } from 'seyfert';
import type { TraceSource } from './options';
import { getTracer } from './trace-api';
import { extractInteractionAttributes, interactionSpanName, type InteractionKind } from './attributes';
import { durationSecondsSince, type CoreMetrics } from './metrics';

export interface InteractionScopeDeps {
  serviceName: string;
  checkIfShouldTrace: (source: TraceSource) => boolean;
  getMetrics: () => CoreMetrics | undefined;
}

function detectKind(context: unknown): InteractionKind {
  const source = context as Record<string, unknown>;
  if (source.customId && source.values !== undefined) return 'component';
  if (source.customId) {
    // components and modals both have customId; prefer modal if interaction type says so when available
    return 'component';
  }
  return 'command';
}

export function createInteractionContextScope(deps: InteractionScopeDeps): ContextScope {
  return (context, run) => {
    const kind = detectKind(context);
    const source: TraceSource = { kind, context };
    if (!deps.checkIfShouldTrace(source)) return run();

    const tracer = getTracer();
    const name = interactionSpanName(kind, context);
    const attributes = extractInteractionAttributes(kind, context);
    const start = performance.now();

    return tracer.startActiveSpan(name, { kind: SpanKind.INTERNAL, attributes }, span => {
      const finish = (error?: unknown) => {
        if (error !== undefined) {
          const err = error instanceof Error ? error : new Error(String(error));
          span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
          span.recordException(err);
        }
        deps.getMetrics()?.recordInteraction(durationSecondsSince(start), {
          ...attributes,
          'seyfert.error': error !== undefined,
        });
        span.end();
      };

      try {
        const result = run();
        if (result !== null && typeof result === 'object' && typeof (result as Promise<unknown>).then === 'function') {
          return Promise.resolve(result).then(
            value => {
              finish();
              return value;
            },
            error => {
              finish(error);
              throw error;
            },
          );
        }
        finish();
        return result;
      } catch (error) {
        finish(error);
        throw error;
      }
    });
  };
}
```

Improve `detectKind` using whatever fields Seyfert contexts expose (command class vs component vs modal). Prefer explicit markers from context type if available (`context.command`, `context.interaction.type`).

- [ ] **Step 2: Lifecycle defaults**

Follow logger’s `register(api)` pattern:

```ts
// instrument/interactions.ts
export function registerInteractionInstrumentation(
  api: {
    commands: { defaults: (hooks: object, opts?: object) => void };
    components: { defaults: (hooks: object, opts?: object) => void };
    modals: { defaults: (hooks: object, opts?: object) => void };
  },
  deps: { checkIfShouldTrace: (source: TraceSource) => boolean },
): void {
  api.commands.defaults(createCommandHooks(deps));
  api.components.defaults(createComponentHooks('component', deps));
  api.modals.defaults(createComponentHooks('modal', deps));
}
```

Child spans strategy (minimal viable):

- `onBeforeMiddlewares`: `startSpan('Middlewares')` stored on a WeakMap keyed by context
- `onAfterRun` / error hooks: end child if open; annotate root via `getCurrentSpan()`

Because root span is owned by `contextScopes`, children must use `tracer.startSpan` / `startActiveSpan` under the active context. Prefer:

```ts
onBeforeMiddlewares(ctx) {
  const span = getTracer().startSpan('Middlewares');
  childSpans.set(ctx, span);
},
// when middlewares finish — if Seyfert has onAfterMiddlewares use it; else end Middlewares at onBeforeOptions / onBeforeRun
```

Inspect Seyfert v5 `SeyfertCommandDefaults` types in `node_modules/seyfert` after install and map to real hooks. **Do not invent hooks that do not exist** — if only `onBeforeMiddlewares` + `onAfterRun` exist, open `Run` at first before-run hook and end on `onAfterRun`.

- [ ] **Step 3: Tests**

- Drive `contextScopes[0](fakeContext, () => 'ok')` with in-memory exporter → one finished span named `command ping`.
- Error path sets `SpanStatusCode.ERROR`.
- `checkIfShouldTrace: () => false` → zero spans.
- `register` installs defaults object with expected keys.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(opentelemetry): instrument interactions with root spans and lifecycle hooks"
```

---

### Task 10: Gateway events instrumentor

**Files:**
- Create: `packages/opentelemetry/src/instrument/events.ts`
- Create: `packages/opentelemetry/test/events.test.mts`

- [ ] **Step 1: Discover Seyfert events invocation point**

After `pnpm install`, inspect:

```bash
# from packages/opentelemetry
rg -n "emit|execute|runEvent|handleEvent" node_modules/seyfert/lib --glob "*.d.ts" | head
```

Prefer a single function wrap on `client.events` (or equivalent). Store original; restore in cleanup.

- [ ] **Step 2: Implement wrap**

```ts
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { TraceSource } from '../options';
import { getTracer } from '../trace-api';
import { durationSecondsSince, type CoreMetrics } from '../metrics';

export interface EventsInstrumentDeps {
  checkIfShouldTrace: (source: TraceSource) => boolean;
  getMetrics: () => CoreMetrics | undefined;
}

export function instrumentEvents(client: unknown, deps: EventsInstrumentDeps): () => void {
  const c = client as {
    events?: {
      run?: (name: string, ...args: unknown[]) => unknown;
      // adjust to actual API
    };
  };

  const events = c.events;
  if (!events || typeof events.run !== 'function') return () => {};

  const original = events.run.bind(events);
  events.run = (name: string, ...args: unknown[]) => {
    const source: TraceSource = { kind: 'event', name, args };
    if (!deps.checkIfShouldTrace(source)) return original(name, ...args);

    const start = performance.now();
    return getTracer().startActiveSpan(
      `event ${name}`,
      { kind: SpanKind.INTERNAL, attributes: { 'seyfert.event.name': name } },
      span => {
        const finish = (error?: unknown) => {
          if (error !== undefined) {
            const err = error instanceof Error ? error : new Error(String(error));
            span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
            span.recordException(err);
          }
          deps.getMetrics()?.recordEvent(durationSecondsSince(start), {
            'seyfert.event.name': name,
            'seyfert.error': error !== undefined,
          });
          span.end();
        };
        try {
          const result = original(name, ...args);
          if (result !== null && typeof result === 'object' && typeof (result as Promise<unknown>).then === 'function') {
            return Promise.resolve(result).then(
              v => {
                finish();
                return v;
              },
              e => {
                finish(e);
                throw e;
              },
            );
          }
          finish();
          return result;
        } catch (e) {
          finish(e);
          throw e;
        }
      },
    );
  };

  return () => {
    events.run = original;
  };
}
```

Replace `events.run` with the real method name found in Step 1. If the API is `execute(handler, ...)` or listener wrapper, adapt but keep one cleanup restore.

- [ ] **Step 3: Unit test with fake client**

```ts
const calls: string[] = [];
const client = {
  events: {
    run(name: string) {
      calls.push(name);
      return 'ok';
    },
  },
};
const cleanup = instrumentEvents(client, {
  checkIfShouldTrace: () => true,
  getMetrics: () => undefined,
});
// with provider installed:
await client.events.run('messageCreate');
// assert span name event messageCreate
cleanup();
await client.events.run('messageCreate');
// no new spans after cleanup
```

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(opentelemetry): instrument gateway event handlers"
```

---

### Task 11: REST instrumentor

**Files:**
- Create: `packages/opentelemetry/src/instrument/rest.ts`
- Create: `packages/opentelemetry/test/rest.test.mts`

- [ ] **Step 1: Discover REST entrypoint**

```bash
rg -n "request|proxyRequest|makeRequest" node_modules/seyfert/lib/api --glob "*.d.ts" | head
```

Wrap the lowest common outbound method (often something like `api.request` / `rest.request`).

- [ ] **Step 2: Implement**

```ts
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { TraceSource } from '../options';
import { getTracer } from '../trace-api';
import { durationSecondsSince, type CoreMetrics } from '../metrics';

export interface RestInstrumentDeps {
  checkIfShouldTrace: (source: TraceSource) => boolean;
  getMetrics: () => CoreMetrics | undefined;
}

type RestRequest = (method: string, path: string, ...rest: unknown[]) => Promise<unknown> | unknown;

export function instrumentRest(client: unknown, deps: RestInstrumentDeps): () => void {
  // Adjust property path to real Seyfert client shape, e.g. client.rest.request or client.proxy
  const c = client as { rest?: { request?: RestRequest } };
  const rest = c.rest;
  if (!rest || typeof rest.request !== 'function') return () => {};

  const original = rest.request.bind(rest) as RestRequest;

  rest.request = async (method: string, path: string, ...args: unknown[]) => {
    const source: TraceSource = { kind: 'rest', method, path };
    if (!deps.checkIfShouldTrace(source)) return original(method, path, ...args);

    const start = performance.now();
    const span = getTracer().startSpan(`HTTP ${method}`, {
      kind: SpanKind.CLIENT,
      attributes: {
        'http.request.method': method,
        'url.path': path,
        'server.address': 'discord.com',
      },
    });

    try {
      const result = await original(method, path, ...args);
      const status = extractStatus(result);
      if (status !== undefined) span.setAttribute('http.response.status_code', status);
      if (status !== undefined && status >= 500) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${status}` });
      }
      deps.getMetrics()?.recordRest(durationSecondsSince(start), {
        'http.request.method': method,
        'url.path': path,
        'http.response.status_code': status,
        'seyfert.error': status !== undefined && status >= 500,
      });
      span.end();
      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.recordException(err);
      deps.getMetrics()?.recordRest(durationSecondsSince(start), {
        'http.request.method': method,
        'url.path': path,
        'seyfert.error': true,
      });
      span.end();
      throw error;
    }
  };

  return () => {
    rest.request = original;
  };
}

function extractStatus(result: unknown): number | undefined {
  if (result && typeof result === 'object' && 'status' in result && typeof (result as { status: unknown }).status === 'number') {
    return (result as { status: number }).status;
  }
  return undefined;
}
```

**Security:** never copy headers from args into attributes.

- [ ] **Step 3: Tests**

- Fake `client.rest.request` resolves → CLIENT span + method/path attrs.
- Rejects → ERROR status + rethrow.
- Cleanup restores original function identity.
- Assert attributes object keys never include `authorization`.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(opentelemetry): instrument Seyfert REST client"
```

---

### Task 12: Cache instrumentor

**Files:**
- Create: `packages/opentelemetry/src/instrument/cache.ts`
- Create: `packages/opentelemetry/test/cache.test.mts`

- [ ] **Step 1: Discover adapter interface**

```bash
rg -n "interface.*Adapter|get\(|set\(|remove\(" node_modules/seyfert/lib/cache --glob "*.d.ts" | head
```

- [ ] **Step 2: Implement adapter method wraps**

```ts
export function instrumentCache(
  client: unknown,
  deps: {
    checkIfShouldTrace: (source: TraceSource) => boolean;
    skipResources: ReadonlySet<string>;
    getMetrics: () => CoreMetrics | undefined;
  },
): () => void {
  const c = client as { cache?: { adapter?: Record<string, unknown> } };
  const adapter = c.cache?.adapter;
  if (!adapter) return () => {};

  const methods = ['get', 'set', 'remove', 'patch', 'getToRelationship', 'bulkGet'] as const;
  const originals = new Map<string, (...args: unknown[]) => unknown>();

  for (const method of methods) {
    const fn = adapter[method];
    if (typeof fn !== 'function') continue;
    const original = (fn as (...args: unknown[]) => unknown).bind(adapter);
    originals.set(method, original);

    adapter[method] = (...args: unknown[]) => {
      const resource = typeof args[0] === 'string' ? args[0] : 'unknown';
      if (deps.skipResources.has(resource)) return original(...args);

      const source: TraceSource = { kind: 'cache', op: method, resource };
      if (!deps.checkIfShouldTrace(source)) return original(...args);

      const start = performance.now();
      return getTracer().startActiveSpan(
        `cache ${method} ${resource}`,
        {
          kind: SpanKind.INTERNAL,
          attributes: {
            'seyfert.cache.op': method,
            'seyfert.cache.resource': resource,
          },
        },
        span => {
          try {
            const result = original(...args);
            const finish = (value: unknown, error?: unknown) => {
              if (method === 'get' && error === undefined) {
                span.setAttribute('seyfert.cache.hit', value !== undefined && value !== null);
              }
              if (error !== undefined) {
                const err = error instanceof Error ? error : new Error(String(error));
                span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
                span.recordException(err);
              }
              deps.getMetrics()?.recordCache(durationSecondsSince(start), {
                'seyfert.cache.op': method,
                'seyfert.cache.resource': resource,
                'seyfert.error': error !== undefined,
              });
              span.end();
            };

            if (result !== null && typeof result === 'object' && typeof (result as Promise<unknown>).then === 'function') {
              return Promise.resolve(result).then(
                v => {
                  finish(v);
                  return v;
                },
                e => {
                  finish(undefined, e);
                  throw e;
                },
              );
            }
            finish(result);
            return result;
          } catch (e) {
            // handled above paths; defensive
            span.recordException(e as Error);
            span.end();
            throw e;
          }
        },
      );
    };
  }

  return () => {
    for (const [method, original] of originals) {
      adapter[method] = original;
    }
  };
}
```

Align method list with real adapter. Skip resources via `deps.skipResources`.

- [ ] **Step 3: Tests**

- `get` hit/miss sets `seyfert.cache.hit`.
- Resource in skip list → no span.
- Teardown restores methods.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(opentelemetry): instrument Seyfert cache adapter"
```

---

### Task 13: Instrument flags integration tests

**Files:**
- Create: `packages/opentelemetry/test/flags.test.mts`

- [ ] **Step 1: For each flag, assert disabled surface produces no spans**

```ts
describe('instrument flags', () => {
  test('rest:false does not wrap rest', async () => {
    const plugin = opentelemetry({
      instrument: { rest: false, interactions: false, events: false, cache: false },
    });
    const client = { rest: { request: async () => ({ status: 200 }) } };
    await plugin.setup?.(client as never);
    // rest.request should be original identity if we stash it — or spy call count on tracer
    await plugin.teardown?.(client as never);
  });
});
```

Also assert combinations: only `interactions: true` still registers `contextScopes`.

- [ ] **Step 2: Commit**

```bash
git commit -m "test(opentelemetry): cover instrument flag isolation"
```

---

### Task 14: README + final typecheck

**Files:**
- Create: `packages/opentelemetry/README.md`
- Modify: `packages/opentelemetry/src/index.ts` (ensure all public exports)
- Modify: `packages/opentelemetry/test/types.ts` if needed

- [ ] **Step 1: Write README** covering:

1. Install (`pnpm add @slipher/opentelemetry @opentelemetry/api` + exporter packages)
2. `definePlugins(opentelemetry({ serviceName, spanProcessors }))` example
3. `instrument` flags table
4. Helpers + `ctx.trace` usage
5. Attribute + metrics tables
6. Preload SDK coexistence
7. Security (no bodies/tokens)

- [ ] **Step 2: Full package verification**

```bash
pnpm --filter @slipher/opentelemetry checkb
pnpm --filter @slipher/opentelemetry test
pnpm --filter @slipher/opentelemetry build
```

Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add packages/opentelemetry
git commit -m "docs(opentelemetry): add README and finalize public exports"
```

---

## Self-review (plan vs spec)

| Spec section | Task(s) |
| --- | --- |
| Package `@slipher/opentelemetry` | 1 |
| Options + instrument flags | 2, 13 |
| Auto NodeSDK / ownership | 3, 8 |
| Helpers Elysia-compatible | 4 |
| `client.trace` / `ctx.trace` | 5, 8 |
| Interactions + contextScopes | 9 |
| Events | 10 |
| REST wrap + security | 11 |
| Cache wrap + skip list | 12 |
| Core metrics histograms | 6, 9–12 |
| Teardown restore | 8, 10–12 |
| README | 14 |
| Module augmentation | 1 (`seyfert.ts`) |
| Non-goals (no bodies/tokens) | 11 attributes only method/path/status |

**Type names locked:** `OpenTelemetryPluginOptions`, `InstrumentFlags`, `TraceSource`, `TraceHandle`, `opentelemetry()`, `record`, `getCurrentSpan`, `setAttributes`, `getTracer`, `getMeter`, metric names `seyfert.interaction.duration` | `seyfert.event.duration` | `seyfert.rest.duration` | `seyfert.cache.operation.duration`.

**Implementation note:** Tasks 10–12 include a discover step against installed Seyfert v5 typings; method names in the plan are provisional and must be replaced with the real API before tests land—do not ship spans on a no-op path that never fires.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-08-opentelemetry-plugin.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration  
2. **Inline Execution** — execute tasks in this session with executing-plans and checkpoints  

Which approach?
