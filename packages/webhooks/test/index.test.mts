import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { assert, describe, test } from 'vitest';
import { init, MAX_WEBHOOK_BODY_BYTES, parseWebhookPayload, WebhookRequestType } from '../src';

describe('@slipher/webhooks payload parsing', () => {
	test('parseWebhookPayload accepts JSON objects', () => {
		assert.deepEqual(parseWebhookPayload('{"type":0,"version":1,"application_id":"app"}'), {
			ok: true,
			body: {
				type: WebhookRequestType.PING,
				version: 1,
				application_id: 'app',
			},
		});
	});

	test('parseWebhookPayload rejects malformed or non-object JSON', () => {
		assert.deepEqual(parseWebhookPayload('{'), { ok: false, status: 400, message: 'Malformed JSON body.' });
		assert.deepEqual(parseWebhookPayload('[]'), { ok: false, status: 400, message: 'Expected a JSON object body.' });
	});

	test('init rejects bodies larger than the webhook size limit', async () => {
		let server!: Server;
		await new Promise<void>(resolve => {
			server = init({
				path: '/webhook',
				port: 0,
				publicKey: '0'.repeat(64),
				callback: () => undefined,
				listen: resolve,
			});
		});

		try {
			const address = server.address();
			assert.notEqual(address, null);
			assert.notEqual(typeof address, 'string');
			const response = await fetch(`http://127.0.0.1:${(address as AddressInfo).port}/webhook`, {
				method: 'POST',
				body: 'x'.repeat(MAX_WEBHOOK_BODY_BYTES + 1),
			});
			assert.equal(response.status, 413);
		} finally {
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});
});
