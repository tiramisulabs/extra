import {
	type Context,
	type ContextManager,
	ROOT_CONTEXT,
	context,
	metrics,
	ProxyTracerProvider,
	trace,
} from '@opentelemetry/api';
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
 * Sync stack context manager so `trace.getActiveSpan()` works under
 * `startActiveSpan` / `record` without `@opentelemetry/context-async-hooks`.
 * Sufficient for unit tests that do not hop async boundaries mid-span.
 */
class StackContextManager implements ContextManager {
	private _current: Context = ROOT_CONTEXT;

	active(): Context {
		return this._current;
	}

	with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
		ctx: Context,
		fn: F,
		thisArg?: ThisParameterType<F>,
		...args: A
	): ReturnType<F> {
		const previous = this._current;
		this._current = ctx;
		try {
			return fn.call(thisArg, ...args);
		} finally {
			this._current = previous;
		}
	}

	bind<T>(_context: Context, target: T): T {
		return target;
	}

	enable(): this {
		return this;
	}

	disable(): this {
		this._current = ROOT_CONTEXT;
		return this;
	}
}

let contextManagerInstalled = false;

/** Install a real context manager once so active spans are visible. */
export function ensureTestContextManager(): void {
	if (contextManagerInstalled) return;
	try {
		// @ts-expect-error private method — same pattern as production sdk helper
		const current = context._getContextManager?.() as
			| { constructor?: { name?: string } }
			| undefined;
		const noneSet =
			current === undefined || current.constructor?.name === 'NoopContextManager';
		if (!noneSet) {
			contextManagerInstalled = true;
			return;
		}
		const manager = new StackContextManager();
		manager.enable();
		context.setGlobalContextManager(manager);
		contextManagerInstalled = true;
	} catch {
		// already registered
		contextManagerInstalled = true;
	}
}

/**
 * Install an in-memory tracer provider for tests.
 *
 * Global OTel providers are process-wide and sticky. Prefer
 * `ProxyTracerProvider.setDelegate` so later suites can still swap exporters
 * without relying on the one-shot `setGlobalTracerProvider`.
 */
export function installTestTracer() {
	ensureTestContextManager();

	const exporter = new InMemorySpanExporter();
	const provider = new BasicTracerProvider({
		spanProcessors: [new SimpleSpanProcessor(exporter)],
	});

	const globalProvider = trace.getTracerProvider();
	if (globalProvider instanceof ProxyTracerProvider) {
		globalProvider.setDelegate(provider);
	} else {
		trace.setGlobalTracerProvider(provider);
	}

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
