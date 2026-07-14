import type { RESTGetAPIGatewayBotResult } from 'seyfert';
import type { LogicalWorker, ResolvedShardTopology } from './types';

export interface CreateLogicalWorkersOptions {
	totalShards: number;
	shardsPerWorker: number;
	shardStart?: number;
	/** Exclusive boundary. Defaults to totalShards. */
	shardEnd?: number;
}

export interface ResolveShardTopologyOptions extends Omit<CreateLogicalWorkersOptions, 'totalShards'> {
	totalShards?: number;
	getGatewayBot(): Promise<RESTGetAPIGatewayBotResult>;
}

export function createLogicalWorkers(options: CreateLogicalWorkersOptions): LogicalWorker[] {
	positiveInteger(options.totalShards, 'totalShards');
	positiveInteger(options.shardsPerWorker, 'shardsPerWorker');
	const shardStart = options.shardStart ?? 0;
	const shardEnd = options.shardEnd ?? options.totalShards;
	nonNegativeInteger(shardStart, 'shardStart');
	positiveInteger(shardEnd, 'shardEnd');
	if (shardStart >= shardEnd) throw new RangeError('shardStart must be lower than shardEnd');
	if (shardEnd > options.totalShards) throw new RangeError('shardEnd cannot exceed totalShards');

	const workers: LogicalWorker[] = [];
	for (let start = shardStart, workerId = 0; start < shardEnd; start += options.shardsPerWorker, workerId++) {
		workers.push({
			workerId,
			shardStart: start,
			shardEnd: Math.min(start + options.shardsPerWorker, shardEnd),
			totalShards: options.totalShards,
		});
	}
	return workers;
}

/** Resolves Discord's recommended shard count without constructing a WorkerManager. */
export async function resolveShardTopology(options: ResolveShardTopologyOptions): Promise<ResolvedShardTopology> {
	const info = await options.getGatewayBot();
	const totalShards = options.totalShards ?? info.shards;
	const shardStart = options.shardStart ?? 0;
	const shardEnd = options.shardEnd ?? totalShards;
	const logicalWorkers = createLogicalWorkers({
		totalShards,
		shardsPerWorker: options.shardsPerWorker,
		shardStart,
		shardEnd,
	});
	return {
		info,
		totalShards,
		shardStart,
		shardEnd,
		shardsPerWorker: options.shardsPerWorker,
		workers: logicalWorkers.length,
	};
}

function positiveInteger(value: number, name: string) {
	if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
}

function nonNegativeInteger(value: number, name: string) {
	if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
}
