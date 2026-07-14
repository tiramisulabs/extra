import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLogicalWorkers, resolveShardTopology, ScalerMaster, SeyfertScaler } from '@slipher/scaler/master';
import { ApiHandler, Logger, type WorkerData } from 'seyfert';

const logger = new Logger({ name: '[Scaler master]' });

async function main() {
	const token = required('BOT_TOKEN');
	const workerPath = resolve(__dirname, 'worker.js');
	const api = new ApiHandler({ token });
	const topology = await resolveShardTopology({
		getGatewayBot: () => api.proxy.gateway.bot.get(),
		shardsPerWorker: Number(process.env.SHARDS_PER_WORKER ?? 4),
		...(process.env.TOTAL_SHARDS ? { totalShards: Number(process.env.TOTAL_SHARDS) } : {}),
	});

	const master = new ScalerMaster({
		authToken: required('SCALER_TOKEN'),
		host: process.env.SCALER_MASTER_HOST ?? '127.0.0.1',
		port: Number(process.env.SCALER_PORT ?? 8_765),
		transport: {
			allowInsecureTransport: process.env.SCALER_ALLOW_INSECURE === 'true',
			tls:
				process.env.SCALER_TLS_KEY && process.env.SCALER_TLS_CERT
					? { key: readFileSync(process.env.SCALER_TLS_KEY), cert: readFileSync(process.env.SCALER_TLS_CERT) }
					: undefined,
		},
	});

	const scaler = new SeyfertScaler({
		master,
		workers: createLogicalWorkers(topology),
		autoRePlaceOnHostLoss: process.env.SCALER_AUTO_REPLACE === 'true',
		createLaunch({ worker }) {
			const workerData: WorkerData = {
				intents: 1,
				token,
				path: workerPath,
				shards: Array.from({ length: worker.shardEnd - worker.shardStart }, (_, index) => worker.shardStart + index),
				totalShards: worker.totalShards,
				totalWorkers: topology.workers,
				mode: 'clusters',
				workerId: worker.workerId,
				debug: false,
				workerProxy: false,
				info: topology.info,
				compress: false,
				resharding: false,
			};
			return { workerData, env: { BOT_TOKEN: token } };
		},
	});

	master.on('error', error => logger.error(error));
	scaler.on('error', error => logger.error(error));
	scaler.on('downtime', (workerId, error) => logger.warn(`Worker ${workerId}: ${error.message}`));
	scaler.on('assignment', assignment => logger.info(JSON.stringify(assignment)));
	for (const signal of ['SIGINT', 'SIGTERM'] as const) {
		process.once(signal, () => void scaler.stop().catch(error => logger.error(error)));
	}
	await scaler.start();
}

void main().catch(error => {
	logger.error(error);
	process.exitCode = 1;
});

function required(name: string) {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}
