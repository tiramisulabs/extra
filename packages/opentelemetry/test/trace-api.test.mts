import { SpanStatusCode } from '@opentelemetry/api';
import type { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { assert, describe, test } from 'vitest';
import { getCurrentSpan, getTracer, record, setAttributes } from '../src/trace-api';
import { installTestTracer } from './helpers/otel-test-provider.mts';

/**
 * Install BasicTracerProvider + InMemorySpanExporter for span collection.
 * Globals are sticky — this file may run after sdk tests; helper uses setDelegate.
 */
function withProvider(run: (exporter: InMemorySpanExporter) => Promise<void> | void) {
	const { exporter, shutdown } = installTestTracer();
	return Promise.resolve(run(exporter)).finally(() => shutdown());
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
			let thrown: unknown;
			try {
				record('work', () => {
					throw err;
				});
			} catch (e) {
				thrown = e;
			}
			assert.equal(thrown, err);
			const span = exporter.getFinishedSpans()[0];
			assert.ok(span);
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

describe('getTracer', () => {
	test('returns a tracer from the active provider', async () => {
		await withProvider(() => {
			const tracer = getTracer();
			assert.ok(tracer);
			assert.equal(typeof tracer.startSpan, 'function');
		});
	});
});
