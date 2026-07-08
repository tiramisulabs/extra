import type { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { assert, describe, test } from 'vitest';
import { createTraceHandle } from '../src/handle';
import { record } from '../src/trace-api';
import { installTestTracer } from './helpers/otel-test-provider.mts';

/**
 * Install BasicTracerProvider + InMemorySpanExporter for span collection.
 * Globals are sticky — this file may run after sdk tests; helper uses setDelegate.
 */
function withProvider(run: (exporter: InMemorySpanExporter) => Promise<void> | void) {
	const { exporter, shutdown } = installTestTracer();
	return Promise.resolve(run(exporter)).finally(() => shutdown());
}

describe('TraceHandle', () => {
	test('span is undefined outside active span', () => {
		const handle = createTraceHandle();
		assert.equal(handle.span, undefined);
		assert.equal(handle.setAttributes({ a: 1 }), false);
	});

	test('setAttributes returns false outside active span', () => {
		const handle = createTraceHandle();
		assert.equal(handle.setAttributes({ a: 1 }), false);
	});

	test('span reflects active span inside record and setAttributes works', async () => {
		await withProvider(async exporter => {
			const handle = createTraceHandle();
			await record('work', span => {
				assert.equal(handle.span, span);
				assert.equal(handle.setAttributes({ a: 1 }), true);
			});
			assert.equal(exporter.getFinishedSpans()[0].attributes.a, 1);
		});
	});

	test('recordException no-ops outside active span', () => {
		const handle = createTraceHandle();
		handle.recordException(new Error('outside'));
	});

	test('recordException records on active span', async () => {
		await withProvider(async exporter => {
			const handle = createTraceHandle();
			const err = new Error('handled');
			await record('work', () => {
				handle.recordException(err);
			});
			const span = exporter.getFinishedSpans()[0];
			assert.ok(span);
			assert.ok(span.events.some(e => e.name === 'exception'));
		});
	});

	test('handle.record creates child spans', async () => {
		await withProvider(async exporter => {
			const handle = createTraceHandle();
			await handle.record('child', () => {
				assert.ok(handle.span);
			});
			assert.equal(exporter.getFinishedSpans().length, 1);
			assert.equal(exporter.getFinishedSpans()[0].name, 'child');
		});
	});
});
