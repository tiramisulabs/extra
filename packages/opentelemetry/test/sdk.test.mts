import { type Context, type ContextManager, ProxyTracerProvider, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { assert, describe, test } from 'vitest';
import { resolvePluginOptions } from '../src/options';
import { shouldStartNodeSDK, startOwnedSdk } from '../src/sdk';

class CountingContextManager implements ContextManager {
	enableCalls = 0;
	private current: Context = ROOT_CONTEXT;

	active(): Context {
		return this.current;
	}

	with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
		context: Context,
		fn: F,
		thisArg?: ThisParameterType<F>,
		...args: A
	): ReturnType<F> {
		const previous = this.current;
		this.current = context;
		try {
			return fn.call(thisArg, ...args);
		} finally {
			this.current = previous;
		}
	}

	bind<T>(_context: Context, target: T): T {
		return target;
	}

	enable(): this {
		this.enableCalls += 1;
		return this;
	}

	disable(): this {
		this.current = ROOT_CONTEXT;
		return this;
	}
}

describe('shouldStartNodeSDK', () => {
	test('true for ProxyTracerProvider without a real delegate', () => {
		const provider = new ProxyTracerProvider();
		assert.equal(provider.getDelegateTracer('check'), undefined);
		assert.equal(shouldStartNodeSDK(provider), true);
	});

	test('false for ProxyTracerProvider with a delegate set', () => {
		const provider = new ProxyTracerProvider();
		provider.setDelegate(new BasicTracerProvider());
		assert.ok(provider.getDelegateTracer('check'));
		assert.equal(shouldStartNodeSDK(provider), false);
	});

	test('false for a real BasicTracerProvider', () => {
		assert.equal(shouldStartNodeSDK(new BasicTracerProvider()), false);
	});
});

describe('startOwnedSdk', () => {
	// Globals are sticky: success path first while the process proxy is clean,
	// then register a real provider and assert we refuse to start again.
	test('starts NodeSDK when the global provider is still a bare proxy', async () => {
		const globalProvider = trace.getTracerProvider();
		if (!shouldStartNodeSDK(globalProvider)) {
			assert.fail(
				'Global tracer provider is not a bare ProxyTracerProvider; startOwnedSdk success path could not run. Run sdk tests first/in isolation.',
			);
		}

		const contextManager = new CountingContextManager();
		const exporter = new InMemorySpanExporter();
		const owned = startOwnedSdk(
			resolvePluginOptions({
				contextManager,
				serviceName: 'test-owned-sdk',
				spanProcessors: [new SimpleSpanProcessor(exporter)],
			}),
		);
		assert.ok(owned);
		assert.ok(owned.sdk);
		assert.equal(typeof owned.shutdown, 'function');
		assert.ok(contextManager.enableCalls > 0);
		await owned.shutdown();
	});

	test('returns undefined when a real provider is already registered', () => {
		const provider = new BasicTracerProvider();
		trace.setGlobalTracerProvider(provider);
		try {
			assert.equal(shouldStartNodeSDK(trace.getTracerProvider()), false);
			assert.equal(startOwnedSdk(resolvePluginOptions({})), undefined);
		} finally {
			void provider.shutdown();
		}
	});
});
