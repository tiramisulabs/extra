import { assert, describe, test } from 'vitest';
import { parseWebhookPayload, WebhookRequestType } from '../src';

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
});
