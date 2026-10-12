import { createMockBot } from '@slipher/testing';
import { assert, describe, test } from 'vitest';
import { opentelemetry } from '../src';
import { installTestTracer } from './helpers/otel-test-provider.mts';

describe('opentelemetry plugin wiring', () => {
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

	test('repeated setup produces one span and teardown restores the original adapter', async () => {
		const otel = installTestTracer();
		const value = { id: '1' };
		const store = new Map<string, unknown>([['user.1', value]]);
		const adapter = {
			get(key: string) {
				return store.get(key) ?? null;
			},
		};
		const originalGet = adapter.get;
		const client = { cache: { adapter }, events: {} };
		const plugin = opentelemetry({
			serviceName: 'plugin-idempotent-test',
			traces: { interactions: false, events: false, rest: false, cache: true },
			metrics: { interactions: false, events: false, rest: false, cache: false },
		});
		try {
			await plugin.setup?.(client as never);
			await plugin.setup?.(client as never);
			assert.equal(adapter.get('user.1'), value);
			const spans = otel.exporter.getFinishedSpans();
			assert.equal(spans.length, 1);
			assert.equal(spans[0].name, 'cache get user');
			await plugin.teardown?.({} as never);
			assert.equal(adapter.get, originalGet);
			assert.equal(adapter.get('user.1'), value);
			assert.equal(otel.exporter.getFinishedSpans().length, 1);
		} finally {
			await plugin.teardown?.({} as never);
			await otel.shutdown();
		}
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
