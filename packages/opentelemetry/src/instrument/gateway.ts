import type { BatchObservableResult } from '@opentelemetry/api';
import { getMeter } from '../trace-api';
import type { InstrumentTarget } from './deps';

interface ShardLike {
	isOpen: boolean;
	latency: number;
}

interface ShardCollection {
	size: number;
	forEach(callback: (shard: ShardLike, shardId: number) => void): void;
}

function isShardCollection(value: unknown): value is ShardCollection {
	if (value === null || typeof value !== 'object') return false;
	const candidate = value as ShardCollection;
	return typeof candidate.forEach === 'function' && typeof candidate.size === 'number';
}

/** `Client` exposes shards as `gateway`, `WorkerClient` as `shards`; `HttpClient` has neither. */
function resolveShards(client: unknown): ShardCollection | undefined {
	if (client === null || typeof client !== 'object') return undefined;
	const candidate = client as { gateway?: unknown; shards?: unknown };
	if (isShardCollection(candidate.gateway)) return candidate.gateway;
	if (isShardCollection(candidate.shards)) return candidate.shards;
	return undefined;
}

export function instrumentGateway(target: InstrumentTarget): () => void {
	const meter = getMeter();
	const connected = meter.createObservableUpDownCounter('seyfert.gateway.shard.connected', {
		description: 'Whether each gateway shard currently holds an open websocket',
	});
	const latency = meter.createObservableGauge('seyfert.gateway.shard.latency', {
		unit: 's',
		description: 'Gateway heartbeat round-trip time per shard',
	});

	const observe = (result: BatchObservableResult): void => {
		try {
			// Resolved per collection, not at setup: `Client.start()` assigns `gateway`
			// only after `BaseClient.start()` has already run plugin setup.
			const shards = resolveShards(target.client);
			if (!shards) return;

			shards.forEach((shard, shardId) => {
				const attributes = { 'seyfert.shard_id': shardId };
				const open = shard?.isOpen === true;
				result.observe(connected, open ? 1 : 0, attributes);
				// Shards report Infinity until the first heartbeat ack; no point beats a wrong one.
				if (open && Number.isFinite(shard.latency)) {
					result.observe(latency, shard.latency / 1000, attributes);
				}
			});
		} catch {
			// never throw from instrumentation
		}
	};

	meter.addBatchObservableCallback(observe, [connected, latency]);
	return () => meter.removeBatchObservableCallback(observe, [connected, latency]);
}
