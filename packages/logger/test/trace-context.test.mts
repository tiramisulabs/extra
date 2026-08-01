import { context, TraceFlags, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { afterAll, assert, beforeAll, describe, test } from 'vitest';
import { createLogger, type LogEntry, type LoggerAdapter } from '../src';

class RecordingAdapter implements LoggerAdapter {
	readonly entries: LogEntry[] = [];

	write(entry: LogEntry): void {
		this.entries.push(entry);
	}
}

const contextManager = new AsyncLocalStorageContextManager();

beforeAll(() => {
	context.disable();
	assert.equal(context.setGlobalContextManager(contextManager.enable()), true);
});

afterAll(() => {
	context.disable();
	contextManager.disable();
});

describe('OpenTelemetry log correlation', () => {
	test('adds the active trace and span IDs to the entry sent to every adapter', async () => {
		const renderer = new RecordingAdapter();
		const transport = new RecordingAdapter();
		const logger = createLogger({ renderer, transports: [transport] });
		const traceId = '0af7651916cd43dd8448eb211c80319c';
		const spanId = 'b7ad6b7169203331';
		const span = trace.wrapSpanContext({ traceId, spanId, traceFlags: TraceFlags.SAMPLED });

		await context.with(trace.setSpan(context.active(), span), async () => {
			await Promise.resolve();
			await logger.info({ jobId: 'job-1' }, 'processing job');
		});

		const expectedData = {
			jobId: 'job-1',
			trace_id: traceId,
			span_id: spanId,
		};
		assert.deepEqual(renderer.entries[0]?.data, expectedData);
		assert.deepEqual(transport.entries[0]?.data, expectedData);
	});

	test('does not correlate an invalid active span context', async () => {
		const renderer = new RecordingAdapter();
		const logger = createLogger({ renderer });
		const span = trace.wrapSpanContext({
			traceId: '00000000000000000000000000000000',
			spanId: '0000000000000000',
			traceFlags: TraceFlags.NONE,
		});

		await context.with(trace.setSpan(context.active(), span), () => logger.info({ jobId: 'job-2' }, 'processing job'));

		assert.deepEqual(renderer.entries[0]?.data, { jobId: 'job-2' });
	});
});
