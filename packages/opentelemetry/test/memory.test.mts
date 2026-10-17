import process from 'node:process';
import { metrics } from '@opentelemetry/api';
import {
	AggregationTemporality,
	DataPointType,
	InMemoryMetricExporter,
	MeterProvider,
	type MetricData,
	PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { Client, HttpClient } from 'seyfert';
import { afterEach, assert, beforeEach, describe, test, vi } from 'vitest';
import { opentelemetry } from '../src';
import { installTestTracer } from './helpers/otel-test-provider.mts';

const disabled = { interactions: false, events: false, rest: false, cache: false };
let reader: PeriodicExportingMetricReader;
let provider: MeterProvider;
let tracer: ReturnType<typeof installTestTracer>;
let client: Client;
let plugin: ReturnType<typeof opentelemetry>;

beforeEach(() => {
	metrics.disable();
	tracer = installTestTracer();
	reader = new PeriodicExportingMetricReader({
		exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
		exportIntervalMillis: 60_000,
	});
	provider = new MeterProvider({ readers: [reader] });
	metrics.setGlobalMeterProvider(provider);
	client = new Client();
	plugin = opentelemetry({ traces: disabled, metrics: { ...disabled, gateway: false } });
});

afterEach(async () => {
	await plugin.teardown?.(client);
	await client.close();
	await provider.shutdown();
	await tracer.shutdown();
	metrics.disable();
	vi.restoreAllMocks();
});

async function collectMetrics() {
	return (await reader.collect()).resourceMetrics.scopeMetrics.flatMap(scope => scope.metrics);
}

function valuesFor(data: MetricData[], name: string, attribute: string) {
	const metric = data.find(item => item.descriptor.name === name);
	if (metric?.dataPointType !== DataPointType.GAUGE) assert.fail(`Missing gauge: ${name}`);
	return Object.fromEntries(metric.dataPoints.map(point => [point.attributes[attribute], point.value]));
}

describe('memory diagnostics', () => {
	test('reports current memory and registrations through the plugin', async () => {
		const usage = vi.spyOn(process, 'memoryUsage').mockReturnValue({
			rss: 1000,
			heapUsed: 200,
			heapTotal: 300,
			external: 50,
			arrayBuffers: 0,
		});
		await plugin.setup?.(client);
		const collector = client.components.createComponentCollector('message', 'channel', undefined);
		for (let i = 0; i < 2; i++) {
			client.collectors.create({ event: 'raw', filter: () => false, run() {} });
		}
		client.components.modals.set('user', () => {});
		const initial = await collectMetrics();
		assert.deepEqual(valuesFor(initial, 'seyfert.process.memory.usage', 'seyfert.memory.type'), {
			rss: 1000,
			heapUsed: 200,
			heapTotal: 300,
			external: 50,
		});
		assert.equal(
			initial.find(metric => metric.descriptor.name === 'seyfert.process.memory.usage')?.descriptor.unit,
			'By',
		);
		assert.deepEqual(valuesFor(initial, 'seyfert.collector.active', 'seyfert.collector.type'), {
			component: 1,
			modal: 1,
			event: 2,
		});
		usage.mockReturnValue({ rss: 2000, heapUsed: 150, heapTotal: 300, external: 80, arrayBuffers: 0 });
		collector.stop();
		client.collectors.values.clear();
		client.components.modals.clear();
		const later = await collectMetrics();
		assert.deepEqual(valuesFor(later, 'seyfert.process.memory.usage', 'seyfert.memory.type'), {
			rss: 2000,
			heapUsed: 150,
			heapTotal: 300,
			external: 80,
		});
		assert.deepEqual(valuesFor(later, 'seyfert.collector.active', 'seyfert.collector.type'), {
			component: 0,
			modal: 0,
			event: 0,
		});
	});

	test('omits unavailable event collectors on an HTTP client', async () => {
		const http = new HttpClient();
		try {
			await plugin.setup?.(http);
			assert.deepEqual(valuesFor(await collectMetrics(), 'seyfert.collector.active', 'seyfert.collector.type'), {
				component: 0,
				modal: 0,
			});
		} finally {
			await plugin.teardown?.(http);
			await http.close();
		}
	});

	test('repeated setup leaves no observers after teardown on a host-owned meter', async () => {
		await plugin.setup?.(client);
		await plugin.setup?.(client);
		await plugin.teardown?.(client);
		assert.deepEqual(await collectMetrics(), []);
		assert.equal(metrics.getMeterProvider(), provider);
	});

	test.each([
		{ memory: false, collectors: true },
		{ memory: true, collectors: false },
	])('exports only the enabled diagnostics: %j', async flags => {
		plugin = opentelemetry({ traces: disabled, metrics: { ...disabled, gateway: false, ...flags } });
		await plugin.setup?.(client);
		const names = (await collectMetrics()).map(metric => metric.descriptor.name);
		assert.equal(names.includes('seyfert.process.memory.usage'), flags.memory);
		assert.equal(names.includes('seyfert.collector.active'), flags.collectors);
	});
});
