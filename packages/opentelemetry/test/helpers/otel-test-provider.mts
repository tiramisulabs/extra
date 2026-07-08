import { metrics, trace } from '@opentelemetry/api';
import {
	AggregationTemporality,
	InMemoryMetricExporter,
	MeterProvider,
	PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

/**
 * Install an in-memory tracer provider for tests.
 *
 * Global OTel providers are process-wide and sticky — prefer constructed
 * `ProxyTracerProvider` / `BasicTracerProvider` instances for ownership checks
 * when possible. Use this helper when spans must be collected.
 */
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
			exporter.reset();
			await provider.shutdown();
		},
	};
}

/**
 * Install an in-memory meter provider for tests.
 * Same sticky-global caveats as {@link installTestTracer}.
 */
export function installTestMeter() {
	const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
	const reader = new PeriodicExportingMetricReader({
		exporter,
		exportIntervalMillis: 100,
	});
	const provider = new MeterProvider({ readers: [reader] });
	metrics.setGlobalMeterProvider(provider);
	return { exporter, provider, reader };
}
