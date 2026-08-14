import { metrics } from '@opentelemetry/api';
import { DataPointType, type MetricData, type MetricReader, type ScopeMetrics } from '@opentelemetry/sdk-metrics';
import { assert, describe, test } from 'vitest';
import { instrumentGateway } from '../src/instrument/gateway';
import { installTestMeter } from './helpers/otel-test-provider.mts';

/** The global meter provider is one-shot, so each case needs a fresh registration. */
async function withMeter(run: (reader: MetricReader) => Promise<void>): Promise<void> {
	metrics.disable();
	const { reader, provider } = installTestMeter();
	try {
		await run(reader);
	} finally {
		await provider.shutdown();
		metrics.disable();
	}
}

function findMetric(scopeMetrics: ScopeMetrics | undefined, name: string): MetricData | undefined {
	return scopeMetrics?.metrics.find(metric => metric.descriptor.name === name);
}

function pointsOf(scopeMetrics: ScopeMetrics | undefined, name: string): [unknown, unknown][] {
	const metric = findMetric(scopeMetrics, name);
	return (metric?.dataPoints ?? []).map(point => [point.attributes['seyfert.shard_id'], point.value]);
}

/** The SDK drops instruments that observed nothing, so absent and empty are the same result. */
function dataPointCount(scopeMetrics: ScopeMetrics | undefined, name: string): number {
	return findMetric(scopeMetrics, name)?.dataPoints.length ?? 0;
}

describe('instrumentGateway', () => {
	test('no shard source → no data points, no throw', async () => {
		await withMeter(async reader => {
			const cleanup = instrumentGateway({ client: { rest: {} }, api: undefined });
			assert.doesNotThrow(cleanup);

			const { resourceMetrics } = await reader.collect();
			assert.equal(dataPointCount(resourceMetrics.scopeMetrics[0], 'seyfert.gateway.shard.connected'), 0);
		});
	});

	// Seyfert assigns `client.gateway` inside `Client.start()`, after `BaseClient.start()`
	// has already run plugin setup — so the shard source must be resolved per collection.
	test('picks up a shard source that appears after setup', async () => {
		await withMeter(async reader => {
			const client: { gateway?: Map<number, { isOpen: boolean; latency: number }> } = {};
			const cleanup = instrumentGateway({ client, api: undefined });

			const before = await reader.collect();
			assert.equal(dataPointCount(before.resourceMetrics.scopeMetrics[0], 'seyfert.gateway.shard.connected'), 0);

			client.gateway = new Map([[0, { isOpen: true, latency: 25 }]]);

			const after = await reader.collect();
			assert.deepEqual(pointsOf(after.resourceMetrics.scopeMetrics[0], 'seyfert.gateway.shard.connected'), [[0, 1]]);

			cleanup();
		});
	});

	test('reports connected per shard and omits latency for shards that are not open', async () => {
		await withMeter(async reader => {
			const client = {
				gateway: new Map([
					[0, { isOpen: true, latency: 42 }],
					[1, { isOpen: false, latency: Number.POSITIVE_INFINITY }],
				]),
			};
			const cleanup = instrumentGateway({ client, api: undefined });

			const { resourceMetrics } = await reader.collect();
			const scopeMetrics = resourceMetrics.scopeMetrics[0];
			assert.equal(scopeMetrics.scope.name, '@slipher/opentelemetry');

			const connected = findMetric(scopeMetrics, 'seyfert.gateway.shard.connected');
			assert.ok(connected);
			assert.equal(connected.dataPointType, DataPointType.SUM);
			assert.deepEqual(pointsOf(scopeMetrics, 'seyfert.gateway.shard.connected'), [
				[0, 1],
				[1, 0],
			]);

			// Shard 1 is down: no data point at all beats a flat zero that reads as healthy.
			assert.deepEqual(pointsOf(scopeMetrics, 'seyfert.gateway.shard.latency'), [[0, 0.042]]);

			cleanup();
		});
	});

	test('omits latency while a shard is open but has no heartbeat ack yet', async () => {
		await withMeter(async reader => {
			const client = { shards: new Map([[3, { isOpen: true, latency: Number.POSITIVE_INFINITY }]]) };
			const cleanup = instrumentGateway({ client, api: undefined });

			const { resourceMetrics } = await reader.collect();
			const scopeMetrics = resourceMetrics.scopeMetrics[0];

			assert.deepEqual(pointsOf(scopeMetrics, 'seyfert.gateway.shard.connected'), [[3, 1]]);
			assert.equal(dataPointCount(scopeMetrics, 'seyfert.gateway.shard.latency'), 0);

			cleanup();
		});
	});

	test('cleanup removes the observable callback', async () => {
		await withMeter(async reader => {
			const client = { gateway: new Map([[0, { isOpen: true, latency: 10 }]]) };
			instrumentGateway({ client, api: undefined })();

			const { resourceMetrics } = await reader.collect();
			assert.equal(dataPointCount(resourceMetrics.scopeMetrics[0], 'seyfert.gateway.shard.connected'), 0);
		});
	});

	test('a throwing shard collection never breaks collection', async () => {
		await withMeter(async reader => {
			const client = {
				gateway: {
					size: 1,
					forEach() {
						throw new Error('shard boom');
					},
				},
			};
			const cleanup = instrumentGateway({ client, api: undefined });

			const { resourceMetrics } = await reader.collect();
			assert.equal(dataPointCount(resourceMetrics.scopeMetrics[0], 'seyfert.gateway.shard.connected'), 0);

			cleanup();
		});
	});
});
