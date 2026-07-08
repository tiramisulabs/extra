import { ProxyTracerProvider, trace } from '@opentelemetry/api';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { assert, describe, test } from 'vitest';
import { resolvePluginOptions } from '../src/options';
import { shouldStartNodeSDK, startOwnedSdk } from '../src/sdk';

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

		const owned = startOwnedSdk(resolvePluginOptions({ serviceName: 'test-owned-sdk' }));
		assert.ok(owned);
		assert.ok(owned.sdk);
		assert.equal(typeof owned.shutdown, 'function');
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
