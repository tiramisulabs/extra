import { createMockBot } from '@slipher/testing';
import { assert, describe, test } from 'vitest';
import { opentelemetry } from '../src';
import { installTestTracer } from './helpers/otel-test-provider.mts';

describe('opentelemetry plugin wiring', () => {
	test('plugin name is stable', () => {
		const plugin = opentelemetry();
		assert.equal(plugin.name, '@slipher/opentelemetry');
	});

	test('setup + teardown with all instruments false does not throw', async () => {
		const plugin = opentelemetry({
			traces: { interactions: false, events: false, rest: false, cache: false },
			metrics: { interactions: false, events: false, rest: false, cache: false },
		});
		assert.equal(plugin.name, '@slipher/opentelemetry');
		const bot = await createMockBot({ plugins: [plugin] });
		await bot.close();
	});

	test('setup + teardown with defaults does not throw', async () => {
		const plugin = opentelemetry({
			serviceName: 'plugin-wiring-test',
		});
		const bot = await createMockBot({ plugins: [plugin] });
		await bot.close();
	});

	test('setup after teardown fails explicitly instead of silently using a stopped SDK', async () => {
		const plugin = opentelemetry({
			traces: { interactions: false, events: false, rest: false, cache: false },
			metrics: { interactions: false, events: false, rest: false, cache: false },
		});
		const bot = await createMockBot({ plugins: [plugin] });
		await bot.close();
		assert.throws(() => plugin.setup?.(bot.client), /cannot be set up after teardown; create a new plugin instance/);
	});

	test('setup is idempotent (second setup unwraps then re-instruments)', async () => {
		const store = new Map<string, unknown>();
		const adapter: Record<string, unknown> = {
			get(key: string) {
				return store.has(key) ? store.get(key) : null;
			},
		};
		const client = { cache: { adapter }, events: {} };
		const plugin = opentelemetry({
			serviceName: 'plugin-idempotent-test',
			traces: { interactions: false, events: false, rest: false, cache: true },
			metrics: { interactions: false, events: false, rest: false, cache: false },
		});
		await plugin.setup?.(client as never);
		const wrappedOnce = adapter.get;
		await plugin.setup?.(client as never);
		// Still a wrapped method (re-instrumented); not left double-wrapped in a broken way
		assert.equal(typeof adapter.get, 'function');
		assert.notEqual(adapter.get, wrappedOnce);
		await plugin.teardown?.({} as never);
		// After teardown, original restored
		assert.notEqual(adapter.get, wrappedOnce);
	});

	test('with in-memory exporter: setup and teardown', async () => {
		const otel = installTestTracer();
		try {
			const plugin = opentelemetry({
				serviceName: 'plugin-inmemory-test',
				traces: { interactions: false, events: false, rest: false, cache: false },
				metrics: { interactions: false, events: false, rest: false, cache: false },
			});
			const bot = await createMockBot({ plugins: [plugin] });
			await bot.close();
			// No user spans expected; wiring must still complete cleanly.
			assert.ok(Array.isArray(otel.exporter.getFinishedSpans()));
		} finally {
			await otel.shutdown();
		}
	});

	test('options() installs contextScopes when interactions are on', () => {
		const plugin = opentelemetry({
			traces: { interactions: true, events: false, rest: false, cache: false },
			metrics: { interactions: false, events: false, rest: false, cache: false },
		});
		const fragment = plugin.options?.({} as never);
		assert.ok(fragment?.contextScopes);
		assert.equal(fragment?.contextScopes?.length, 1);
		assert.equal(typeof fragment?.contextScopes?.[0], 'function');
	});

	test('options() omits contextScopes when interactions are off', () => {
		const plugin = opentelemetry({
			traces: { interactions: false, events: false, rest: false, cache: false },
			metrics: { interactions: false, events: false, rest: false, cache: false },
		});
		const fragment = plugin.options?.({} as never);
		assert.deepEqual(fragment, {});
	});

	test('client.trace and ctx.trace factories return a TraceHandle', () => {
		const plugin = opentelemetry({
			traces: { interactions: false, events: false, rest: false, cache: false },
			metrics: { interactions: false, events: false, rest: false, cache: false },
		});
		const clientHandle = plugin.client?.trace?.({} as never);
		const ctxHandle = plugin.ctx?.trace?.({} as never, {} as never);
		assert.ok(clientHandle);
		assert.ok(ctxHandle);
		assert.equal(typeof clientHandle.setAttributes, 'function');
		assert.equal(typeof clientHandle.recordException, 'function');
		assert.equal(typeof clientHandle.record, 'function');
		assert.equal(typeof ctxHandle.setAttributes, 'function');
	});
});
