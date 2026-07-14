import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { bearerToken, connectWebSocket, WebSocketTransportServer } from '../src/transport';

const key = readFileSync(new URL('./fixtures/tls-key.txt', import.meta.url));
const cert = readFileSync(new URL('./fixtures/tls-cert.txt', import.meta.url));
const servers: WebSocketTransportServer[] = [];

afterEach(async () => {
	for (const server of servers.splice(0).reverse()) await server.close();
});

describe('WebSocket transport', () => {
	it('authenticates a wss loopback upgrade and rejects an incorrect token', async () => {
		const server = new WebSocketTransportServer({
			host: '127.0.0.1',
			port: 0,
			tls: { key, cert },
			authenticate: request =>
				request.headers['x-scaler-host-id'] === 'host-a' && bearerToken(request) === 'correct-token',
		});
		servers.push(server);
		const address = (await server.listen()) as AddressInfo;

		const accepted = new Promise<void>(resolve => server.once('connection', () => resolve()));
		const connection = await connectWebSocket({
			host: '127.0.0.1',
			port: address.port,
			hostId: 'host-a',
			authToken: 'correct-token',
			tls: { rejectUnauthorized: false },
		});
		await accepted;
		connection.terminate();

		await expect(
			connectWebSocket({
				host: '127.0.0.1',
				port: address.port,
				hostId: 'host-a',
				authToken: 'wrong-token',
				tls: { rejectUnauthorized: false },
			}),
		).rejects.toThrow(/401/);
	});
});
