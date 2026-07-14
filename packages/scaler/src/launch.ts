import type { BotConfig } from 'seyfert';
import type { RemoteWorkerLaunch, ResolvedShardTopology, SeyfertScalerOptions } from './types';

export interface CreateSeyfertLaunchOptions {
	config: Pick<BotConfig, 'token' | 'intents' | 'debug'>;
	topology: Pick<ResolvedShardTopology, 'info' | 'workers'>;
	workerPath: string;
	compress?: boolean;
	env?: Readonly<Record<string, unknown>>;
}

export function createSeyfertLaunch(options: CreateSeyfertLaunchOptions): SeyfertScalerOptions['createLaunch'] {
	return ({ worker }): RemoteWorkerLaunch => ({
		workerData: {
			token: options.config.token,
			intents: options.config.intents,
			path: options.workerPath,
			shards: Array.from({ length: worker.shardEnd - worker.shardStart }, (_, index) => worker.shardStart + index),
			totalShards: worker.totalShards,
			totalWorkers: options.topology.workers,
			workerId: worker.workerId,
			mode: 'clusters',
			debug: options.config.debug ?? false,
			workerProxy: false,
			info: {
				...options.topology.info,
				// WorkerClient reuses workerData.info when resuming shards, so IDENTIFY must keep the assigned total.
				shards: worker.totalShards,
			},
			compress: options.compress ?? false,
			resharding: false,
		},
		...(options.env ? { env: options.env } : {}),
	});
}
