import { assert, describe, test } from 'vitest';
import { parseJsonObject, parseMultipartBody } from '../src/parsing';

function bytes(value: string) {
	return new TextEncoder().encode(value).buffer;
}

describe('@slipher/proxy request parsing', () => {
	test('parseJsonObject accepts only JSON objects', () => {
		assert.deepEqual(parseJsonObject('{"content":"hello"}'), { ok: true, value: { content: 'hello' } });
		assert.deepEqual(parseJsonObject('[]'), { ok: false, status: 400, message: 'Expected a JSON object body.' });
		assert.deepEqual(parseJsonObject('{'), { ok: false, status: 400, message: 'Malformed JSON body.' });
	});

	test('parseMultipartBody parses payload_json and falls back unnamed file names', () => {
		const parsed = parseMultipartBody([
			{ name: 'payload_json', data: bytes('{"content":"hello"}') },
			{ name: 'upload', data: bytes('a') },
			{ name: '', filename: 'named.txt', data: bytes('b') },
			{ name: '', data: bytes('c') },
		]);

		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;
		assert.deepEqual(parsed.body, { content: 'hello' });
		assert.deepEqual(
			parsed.files.map(file => file.filename),
			['upload', 'named.txt', 'file-3'],
		);
	});

	test('parseMultipartBody rejects malformed payload_json', () => {
		assert.deepEqual(parseMultipartBody([{ name: 'payload_json', data: bytes('{') }]), {
			ok: false,
			status: 400,
			message: 'Malformed JSON body.',
		});
	});
});
