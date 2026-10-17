import process from 'node:process';
import { metrics } from '@opentelemetry/api';
import { DataPointType, type MetricData, type MetricReader } from '@opentelemetry/sdk-metrics';
import { createMockBot } from '@slipher/testing';
import { Client, HttpClient } from 'seyfert';
import { afterEach, assert, beforeEach, describe, test, vi } from 'vitest';
import { opentelemetry } from '../src';
import { instrumentCollectors } from '../src/instrument/collectors';
import { instrumentMemory } from '../src/instrument/memory';
import { installTestMeter, installTestTracer } from './helpers/otel-test-provider.mts';

let reader: MetricReader;
let provider: ReturnType<typeof installTestMeter>['provider'];

beforeEach(() => {
	metrics.disable();
	({ reader, provider } = installTestMeter());
});

afterEach(async () => {
	await provider.shutdown();
	metrics.disable();
	vi.restoreAllMocks();
});

async function collectMetrics() {
	return (await reader.collect()).resourceMetrics.scopeMetrics.flatMap(scope => scope.metrics);
}

function valuesFor(data: MetricData[], name: string, attribute: string) {
	const metric = data.find(item => item.descriptor.name === name);
	if (metric?.dataPointType !== DataPointType.GAUGE) return {};
	return Object.fromEntries(metric.dataPoints.map(point => [point.attributes[attribute], point.value]));
}

describe('memory diagnostics', () => {
	test('samples current process memory and stops reading it after cleanup', async () => {
		let usage = { rss: 1000, heapUsed: 200, heapTotal: 300, external: 50, arrayBuffers: 0 };
		const read = vi.spyOn(process, 'memoryUsage').mockImplementation(() => usage);
		const cleanup = instrumentMemory();
		try {
			assert.deepEqual(valuesFor(await collectMetrics(), 'seyfert.process.memory.usage', 'seyfert.memory.type'), {
				rss: 1000,
				heapUsed: 200,
				heapTotal: 300,
				external: 50,
			});
			usage = { rss: 2000, heapUsed: 150, heapTotal: 300, external: 80, arrayBuffers: 0 };
			assert.deepEqual(valuesFor(await collectMetrics(), 'seyfert.process.memory.usage', 'seyfert.memory.type'), {
				rss: 2000,
				heapUsed: 150,
				heapTotal: 300,
				external: 80,
			});
			assert.equal(read.mock.calls.length, 2);
			cleanup();
			await collectMetrics();
			assert.equal(read.mock.calls.length, 2);
		} finally {
			cleanup();
		}
	});

	test('omits memory data when the runtime cannot read it', async () => {
		vi.spyOn(process, 'memoryUsage').mockImplementation(() => {
			throw new Error('unavailable');
		});
		const cleanup = instrumentMemory();
		try {
			assert.deepEqual(valuesFor(await collectMetrics(), 'seyfert.process.memory.usage', 'seyfert.memory.type'), {});
		} finally {
			cleanup();
		}
	});

	test('counts current registrations as handlers are removed', async () => {
		const client = new Client();
		const readSize = vi.spyOn(client.components.values, 'size', 'get');
		const cleanup = instrumentCollectors({ client, api: undefined });
		try {
			const collector = client.components.createComponentCollector('message', 'channel', undefined);
			for (let i = 0; i < 2; i++) {
				client.collectors.create({ event: 'raw', filter: () => false, run() {} });
			}
			client.components.modals.set('user', () => {});
			assert.deepEqual(valuesFor(await collectMetrics(), 'seyfert.collector.active', 'seyfert.collector.type'), {
				component: 1,
				modal: 1,
				event: 2,
			});
			collector.stop();
			client.collectors.values.clear();
			client.components.modals.clear();
			assert.deepEqual(valuesFor(await collectMetrics(), 'seyfert.collector.active', 'seyfert.collector.type'), {
				component: 0,
				modal: 0,
				event: 0,
			});
			cleanup();
			const calls = readSize.mock.calls.length;
			await collectMetrics();
			assert.equal(readSize.mock.calls.length, calls);
		} finally {
			cleanup();
			client.components.modals.clear();
			await client.close();
		}
	});

	test('does not report absent gateway collectors on an HTTP client', async () => {
		const client = new HttpClient();
		const cleanup = instrumentCollectors({ client, api: undefined });
		try {
			assert.deepEqual(valuesFor(await collectMetrics(), 'seyfert.collector.active', 'seyfert.collector.type'), {
				component: 0,
				modal: 0,
			});
		} finally {
			cleanup();
			await client.close();
		}
	});

	test('repeated plugin setup and close remove callbacks on a host-owned meter', async () => {
		const tracer = installTestTracer();
		const read = vi
			.spyOn(process, 'memoryUsage')
			.mockReturnValue({ rss: 1000, heapUsed: 200, heapTotal: 300, external: 50, arrayBuffers: 0 });
		const plugin = opentelemetry({
			traces: { interactions: false, events: false, rest: false, cache: false },
			metrics: { interactions: false, events: false, rest: false, cache: false, gateway: false },
		});
		const bot = await createMockBot({ plugins: [plugin] });
		try {
			await plugin.setup?.(bot.client);
			const data = await collectMetrics();
			assert.equal(read.mock.calls.length, 1);
			assert.deepEqual(valuesFor(data, 'seyfert.collector.active', 'seyfert.collector.type'), {
				component: 0,
				modal: 0,
				event: 0,
			});
			await bot.close();
			await collectMetrics();
			assert.equal(read.mock.calls.length, 1);
		} finally {
			await bot.close();
			await tracer.shutdown();
		}
	});

	test('disabled diagnostics register no process or collector observations', async () => {
		const tracer = installTestTracer();
		const read = vi.spyOn(process, 'memoryUsage');
		const bot = await createMockBot({
			plugins: [
				opentelemetry({
					traces: { interactions: false, events: false, rest: false, cache: false },
					metrics: {
						interactions: false,
						events: false,
						rest: false,
						cache: false,
						gateway: false,
						memory: false,
						collectors: false,
					},
				}),
			],
		});
		try {
			assert.deepEqual(await collectMetrics(), []);
			assert.equal(read.mock.calls.length, 0);
		} finally {
			await bot.close();
			await tracer.shutdown();
		}
	});
});
