import { createServer } from 'node:net';
import nacl from 'tweetnacl';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { init, WebhookRequestType } from '../src';

const servers: ReturnType<typeof init>[] = [];

afterEach(async () => {
	await Promise.all(
		servers.map(
			server =>
				new Promise<void>(resolve => {
					server.close(() => resolve());
				}),
		),
	);
	servers.length = 0;
});

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.on('error', reject);
		server.listen(0, () => {
			const address = server.address();
			if (!address || typeof address === 'string') {
				server.close();
				reject(new TypeError('Unable to reserve a test port'));
				return;
			}
			const { port } = address;
			server.close(() => resolve(port));
		});
	});
}

function sign(body: string, secretKey: Uint8Array, timestamp = '1700000000') {
	const signature = nacl.sign.detached(Buffer.from(timestamp + body), secretKey);
	return {
		timestamp,
		ed25519: Buffer.from(signature).toString('hex'),
	};
}

async function startWebhook(callback = vi.fn()) {
	const keys = nacl.sign.keyPair();
	const port = await freePort();
	const server = init({
		path: '/discord',
		port,
		publicKey: Buffer.from(keys.publicKey).toString('hex'),
		callback,
	});
	servers.push(server);
	await new Promise(resolve => server.once('listening', resolve));
	return { callback, keys, url: `http://127.0.0.1:${port}/discord` };
}

describe('@slipher/webhooks', () => {
	test('rejects signed event payloads missing required base fields', async () => {
		const { callback, keys, url } = await startWebhook();
		const body = JSON.stringify({ type: WebhookRequestType.Event, event: {} });
		const signature = sign(body, keys.secretKey);

		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'x-signature-timestamp': signature.timestamp,
				'x-signature-ed25519': signature.ed25519,
			},
			body,
		});

		expect(response.status).toBe(400);
		expect(callback).not.toHaveBeenCalled();
	});

	test('rejects oversized webhook bodies before signature verification', async () => {
		const { callback, url } = await startWebhook();
		const body = 'x'.repeat(1024 * 1024 + 1);

		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'x-signature-timestamp': '1700000000',
				'x-signature-ed25519': '00',
			},
			body,
		});

		expect(response.status).toBe(413);
		expect(callback).not.toHaveBeenCalled();
	});
});
