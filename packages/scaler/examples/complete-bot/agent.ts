import { readFileSync } from 'node:fs';
import { ScalerAgent } from '@slipher/scaler/agent';
import { Logger } from 'seyfert';

const logger = new Logger({ name: '[Scaler agent]' });
const agent = new ScalerAgent({
	hostId: required('HOST_ID'),
	host: process.env.SCALER_MASTER_HOST ?? '127.0.0.1',
	port: Number(process.env.SCALER_PORT ?? 8_765),
	authToken: required('SCALER_TOKEN'),
	capacity: { maxWorkers: Number(process.env.MAX_WORKERS ?? 4) },
	transport: {
		allowInsecureTransport: process.env.SCALER_ALLOW_INSECURE === 'true',
		tls: process.env.SCALER_TLS_CA
			? { ca: readFileSync(process.env.SCALER_TLS_CA), servername: process.env.SCALER_TLS_SERVERNAME }
			: undefined,
	},
});

agent.on('error', error => logger.error(error));
agent.on('state', state => logger.info(`${agent.descriptor.hostId}: ${state}`));
void agent.start().catch(error => logger.error(error));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.once(signal, () => void agent.stop().catch(error => logger.error(error)));
}

function required(name: string) {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}
