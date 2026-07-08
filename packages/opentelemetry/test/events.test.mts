import { SpanStatusCode } from '@opentelemetry/api';
import type { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { assert, describe, test } from 'vitest';
import { type EventsApi, instrumentEvents } from '../src/instrument/events';
import { setTraceServiceName } from '../src/trace-api';
import { installTestTracer } from './helpers/otel-test-provider.mts';

function withProvider(run: (exporter: InMemorySpanExporter) => Promise<void> | void) {
	const { exporter, shutdown } = installTestTracer();
	setTraceServiceName('events-test');
	return Promise.resolve(run(exporter)).finally(() => shutdown());
}

function fakeClient(runEvent?: (name: string, ...args: unknown[]) => unknown) {
	const calls: string[] = [];
	const client = {
		events: {
			runEvent(name: string, ...args: unknown[]): unknown {
				calls.push(name);
				if (runEvent) return runEvent(name, ...args);
				return 'ok';
			},
		},
	};
	return { client, calls };
}

function fakeEventApi() {
	let errorHandler: ((error: unknown, name: string) => unknown) | undefined;
	let disposed = false;
	const api: EventsApi = {
		events: {
			onError(handler) {
				errorHandler = handler;
				return () => {
					disposed = true;
					errorHandler = undefined;
				};
			},
		},
	};
	return {
		api,
		emitError: (error: unknown, name: string) => errorHandler?.(error, name),
		isDisposed: () => disposed,
	};
}

describe('instrumentEvents (gateway runEvent)', () => {
	test('fake path produces span event messageCreate', async () => {
		await withProvider(async exporter => {
			const { client, calls } = fakeClient();
			const cleanup = instrumentEvents(client, {
				checkIfShouldTrace: () => true,
				getMetrics: () => undefined,
			});

			const result = await client.events.runEvent('messageCreate', client, { content: 'hi' }, 0);

			assert.equal(result, 'ok');
			assert.deepEqual(calls, ['messageCreate']);
			const spans = exporter.getFinishedSpans();
			assert.equal(spans.length, 1);
			assert.equal(spans[0].name, 'event messageCreate');
			assert.equal(spans[0].attributes['seyfert.event.name'], 'messageCreate');
			assert.equal(spans[0].attributes['seyfert.shard_id'], 0);
			assert.equal(spans[0].status.code, SpanStatusCode.UNSET);

			cleanup();
		});
	});

	test('cleanup restores / no new spans after cleanup', async () => {
		await withProvider(async exporter => {
			const { client } = fakeClient();
			const cleanup = instrumentEvents(client, {
				checkIfShouldTrace: () => true,
				getMetrics: () => undefined,
			});

			await client.events.runEvent('messageCreate', client, {}, 1);
			assert.equal(exporter.getFinishedSpans().length, 1);

			cleanup();
			await client.events.runEvent('messageCreate', client, {}, 1);
			assert.equal(exporter.getFinishedSpans().length, 1);
		});
	});

	test('checkIfShouldTrace false → no span', async () => {
		await withProvider(async exporter => {
			const { client, calls } = fakeClient();
			const cleanup = instrumentEvents(client, {
				checkIfShouldTrace: () => false,
				getMetrics: () => undefined,
			});

			const result = await client.events.runEvent('messageCreate', client, {}, 0);
			assert.equal(result, 'ok');
			assert.deepEqual(calls, ['messageCreate']);
			assert.equal(exporter.getFinishedSpans().length, 0);

			cleanup();
		});
	});

	test('ERROR status on throw and user error is rethrown', async () => {
		await withProvider(async exporter => {
			const { client } = fakeClient(() => {
				throw new Error('handler boom');
			});
			const cleanup = instrumentEvents(client, {
				checkIfShouldTrace: () => true,
				getMetrics: () => undefined,
			});

			assert.throws(() => client.events.runEvent('messageCreate', client, {}, 0), /handler boom/);

			const spans = exporter.getFinishedSpans();
			assert.equal(spans.length, 1);
			assert.equal(spans[0].name, 'event messageCreate');
			assert.equal(spans[0].status.code, SpanStatusCode.ERROR);
			assert.ok(spans[0].events.some(e => e.name === 'exception'));

			cleanup();
		});
	});

	test('async rejection sets ERROR status', async () => {
		await withProvider(async exporter => {
			const { client } = fakeClient(async () => {
				throw new Error('async boom');
			});
			const cleanup = instrumentEvents(client, {
				checkIfShouldTrace: () => true,
				getMetrics: () => undefined,
			});

			let thrown: unknown;
			try {
				await client.events.runEvent('guildCreate', client, {}, 2);
			} catch (error) {
				thrown = error;
			}
			assert.ok(thrown instanceof Error);
			assert.match((thrown as Error).message, /async boom/);

			const spans = exporter.getFinishedSpans();
			assert.equal(spans.length, 1);
			assert.equal(spans[0].status.code, SpanStatusCode.ERROR);
			assert.equal(spans[0].attributes['seyfert.shard_id'], 2);

			cleanup();
		});
	});

	test('Seyfert-reported handler errors mark resolved runEvent spans as failed', async () => {
		await withProvider(async exporter => {
			const reported = new Error('reported boom');
			const recorded: Array<{ duration: number; attrs: Record<string, unknown> }> = [];
			const eventApi = fakeEventApi();
			const { client } = fakeClient(async name => {
				await eventApi.emitError(reported, name);
				return undefined;
			});
			const cleanup = instrumentEvents(
				client,
				{
					checkIfShouldTrace: () => true,
					getMetrics: () => ({
						recordInteraction() {},
						recordEvent(durationSeconds, attributes) {
							recorded.push({
								duration: durationSeconds,
								attrs: attributes as Record<string, unknown>,
							});
						},
						recordRest() {},
						recordCache() {},
					}),
				},
				eventApi.api,
			);

			await client.events.runEvent('messageCreate', client, {}, 0);

			const spans = exporter.getFinishedSpans();
			assert.equal(spans.length, 1);
			assert.equal(spans[0].status.code, SpanStatusCode.ERROR);
			assert.ok(spans[0].events.some(e => e.name === 'exception'));
			assert.equal(recorded.length, 1);
			assert.equal(recorded[0].attrs['seyfert.error'], true);

			cleanup();
			assert.equal(eventApi.isDisposed(), true);
		});
	});

	test('missing events.runEvent → no-op disposer', async () => {
		await withProvider(async exporter => {
			const cleanup = instrumentEvents(
				{},
				{
					checkIfShouldTrace: () => true,
					getMetrics: () => undefined,
				},
			);
			assert.equal(typeof cleanup, 'function');
			cleanup();
			assert.equal(exporter.getFinishedSpans().length, 0);
		});
	});

	test('records event metrics when provided', async () => {
		await withProvider(async exporter => {
			const recorded: Array<{ duration: number; attrs: Record<string, unknown> }> = [];
			const { client } = fakeClient();
			const cleanup = instrumentEvents(client, {
				checkIfShouldTrace: () => true,
				getMetrics: () => ({
					recordInteraction() {},
					recordEvent(durationSeconds, attributes) {
						recorded.push({
							duration: durationSeconds,
							attrs: attributes as Record<string, unknown>,
						});
					},
					recordRest() {},
					recordCache() {},
				}),
			});

			await client.events.runEvent('ready', client, {}, -1);
			assert.equal(recorded.length, 1);
			assert.ok(recorded[0].duration >= 0);
			assert.equal(recorded[0].attrs['seyfert.event.name'], 'ready');
			assert.equal(recorded[0].attrs['seyfert.error'], false);
			assert.equal(exporter.getFinishedSpans().length, 1);

			cleanup();
		});
	});
});
