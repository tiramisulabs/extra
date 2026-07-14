process.send({
	type: 'ENV',
	workerId: Number(process.env.SEYFERT_WORKER_WORKERID),
	mode: process.env.SEYFERT_WORKER_MODE,
	shards: JSON.parse(process.env.SEYFERT_WORKER_SHARDS),
	totalShards: Number(process.env.SEYFERT_WORKER_TOTALSHARDS),
	controlPlaneTokenPresent: Object.hasOwn(process.env, 'SCALER_TOKEN'),
});

process.on('message', message => {
	if (message?.type === 'DISCONNECT_ALL_SHARDS_RESHARDING') {
		process.send({ type: 'DISCONNECTED_ALL_SHARDS_RESHARDING', workerId: 0 });
	}
});

process.once('SIGTERM', () => process.exit(0));
