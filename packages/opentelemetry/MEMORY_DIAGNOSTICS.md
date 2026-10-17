# Memory diagnostics

`metrics.memory` and `metrics.collectors` default to `true`. Set either to `false`
to disable its observations. They do not create spans or change tracing flags.

| Metric | Unit | Attribute | Values |
| --- | --- | --- | --- |
| `seyfert.process.memory.usage` | `By` | `seyfert.memory.type` | `rss`, `heapUsed`, `heapTotal`, `external` |
| `seyfert.collector.active` | `{registration}` | `seyfert.collector.type` | `component`, `event`, `modal` |

Memory values come from `process.memoryUsage()` on Node or Bun. They include the
application, dependencies, and runtime; the `seyfert` prefix identifies the
instrumentation, not the owner of those allocations. `external` is the runtime's
external-memory measurement, not all native memory. These values overlap; do not
add them together.

Collector values count current component registrations, gateway/custom-event
registrations, and modal callbacks. An absent surface is omitted, so an HTTP
client has no `event` point. Counts measure registrations, not retained bytes.
Application-specific stores require application-specific metrics through
`getMeter()` or another existing metrics exporter.

Observation runs when the SDK collects metrics, without a separate timer, forced
GC, or heap snapshots. Repeated setup replaces the callbacks; teardown removes
them. A host-owned SDK may retain the last collected numeric data points after
callbacks are removed.

## Export the measurements

A trace exporter does not export metrics. Install a metric reader on whichever
SDK owns the process's OpenTelemetry providers:

```sh
pnpm add @opentelemetry/sdk-metrics @opentelemetry/exporter-metrics-otlp-proto
```

```ts
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { opentelemetry } from '@slipher/opentelemetry';

const telemetry = opentelemetry({
	serviceName: 'my-bot',
	metrics: { memory: true, collectors: true },
	metricReader: new PeriodicExportingMetricReader({
		exporter: new OTLPMetricExporter(),
		exportIntervalMillis: 30_000,
	}),
});
```

Use the normal plugin registration for `telemetry`. The exporter uses the OTLP
environment configuration. If Sentry, a preload, or another host already owns
the tracer provider, configure the metric reader on that host SDK; the plugin
does not start a second SDK. Plot one process/replica at a time. In worker threads,
RSS covers the whole process while heap measurements describe the current thread.

## Attribute growth to an owner

First distinguish rising JavaScript heap from rising RSS with a stable heap.
Growing collector counts are a lead to inspect, not proof that Seyfert owns the
memory increase. Likewise, memory increasing during a handler does not establish
which allocation survived GC or which reference retains it.

For JavaScript retention, take two or three heap snapshots from the same process
after warm-up, with comparable workload and elapsed time. Node and Bun support
`writeHeapSnapshot()` from `node:v8`; use an existing debugger or a temporary
diagnostic action to call it manually:

```ts
import { writeHeapSnapshot } from 'node:v8';

writeHeapSnapshot(`heap-${process.pid}-${Date.now()}.heapsnapshot`);
```

Snapshot capture pauses execution and can require substantial extra memory. Use
a replica with headroom. Snapshots contain application data and may include
credentials, so keep them private.

Load the snapshots into Chrome DevTools' Memory panel and compare the newer one
with the baseline. Inspect growing object groups and their **Retainers** paths
to find the live references and retaining containers. Check the container's
cleanup/expiry contract before classifying retention as a leak. Allocation
profiling can help locate where objects were created; a snapshot does not always
include that allocation stack.

A stable JavaScript heap with growing RSS calls for checking other worker heaps,
buffers, native dependencies, runtime allocators, and memory retained by the
allocator. JavaScript snapshots cannot account for every native allocation.
Use native/runtime profiling and controlled dependency or runtime comparisons to
attribute that part. The metrics alone cannot identify a leaking library.

References: [Node heap snapshots](https://nodejs.org/learn/diagnostics/memory/using-heap-snapshot),
[Bun memory diagnostics](https://bun.com/blog/debugging-memory-leaks).
