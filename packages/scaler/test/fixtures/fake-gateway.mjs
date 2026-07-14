import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { WebSocketServer } from 'ws';

export async function startFakeGateway() {
	const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
	await once(server, 'listening');

	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Fake gateway did not bind a TCP port');

	let nextConnectionId = 0;
	const identifies = [];
	const closes = [];

	server.on('connection', socket => {
		const connectionId = nextConnectionId++;
		socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }));

		socket.on('message', data => {
			const payload = JSON.parse(data.toString());
			if (payload.op === 1) {
				socket.send(JSON.stringify({ op: 11, d: null }));
				return;
			}
			if (payload.op !== 2) return;

			const [shardId, totalShards] = payload.d.shard;
			identifies.push({ connectionId, shardId, totalShards, at: performance.now() });
			socket.send(
				JSON.stringify({
					op: 0,
					t: 'READY',
					s: 1,
					d: {
						v: 10,
						user: {
							id: '123456789012345678',
							username: 'scaler-e2e',
							discriminator: '0000',
							avatar: null,
							bot: true,
						},
						application: { id: '123456789012345678', flags: 0 },
						guilds: [],
						session_id: `session-${connectionId}`,
						resume_gateway_url: `ws://127.0.0.1:${address.port}`,
					},
				}),
			);
		});

		socket.once('close', () => {
			closes.push({ connectionId, at: performance.now() });
		});
	});

	return {
		url: `ws://127.0.0.1:${address.port}`,
		identifies,
		closes,
		activeConnectionCount() {
			return server.clients.size;
		},
		async close() {
			for (const socket of server.clients) socket.terminate();
			await new Promise((resolve, reject) => {
				server.close(error => (error ? reject(error) : resolve()));
			});
		},
	};
}
