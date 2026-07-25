import type { RawFile } from 'seyfert';
import { assert, describe, test } from 'vitest';
import { RequestDeduplicator, requestFingerprint } from '../src/deduplication';
import type { WireApiRequest } from '../src/protocol';

const request = {
	method: 'POST',
	url: '/channels/1/messages',
	requestId: 'request-1',
} satisfies WireApiRequest;

describe('request deduplication', () => {
	test('returns every claim outcome as a discriminated result', () => {
		const deduplicator = new RequestDeduplicator<string>(60_000, 1);
		const owner = deduplicator.claim('service', 'request-1', 'fingerprint');
		assert.equal(owner.kind, 'owner');
		if (owner.kind !== 'owner') assert.fail('Expected the first claim to own the request.');

		const duplicate = deduplicator.claim('service', 'request-1', 'fingerprint');
		assert.equal(duplicate.kind, 'duplicate');
		const conflict = deduplicator.claim('service', 'request-1', 'different');
		assert.deepEqual(conflict, {
			kind: 'conflict',
			message: 'requestId was already used with a different request fingerprint.',
		});
		const capacity = deduplicator.claim('service', 'request-2', 'other');
		assert.deepEqual(capacity, {
			kind: 'capacity',
			message: 'The deduplication registry is full of active requests.',
		});

		owner.abort('aborted');
		assert.equal(deduplicator.claim('service', 'request-2', 'other').kind, 'owner');
	});

	test('is stable across nested object key order', () => {
		const first = requestFingerprint(
			{ ...request, body: { content: 'same', nested: { first: 1, second: 2 } } },
			undefined,
			'token',
		);
		const second = requestFingerprint(
			{ ...request, body: { nested: { second: 2, first: 1 }, content: 'same' } },
			undefined,
			'token',
		);

		assert.equal(first, second);
	});

	test('frames file metadata and bytes without structural collisions', () => {
		const metadata = {
			key: 'second',
			filename: 'second.bin',
			contentType: 'application/octet-stream',
		};
		const firstFile: RawFile = {
			key: 'first',
			filename: 'first.bin',
			contentType: 'application/octet-stream',
			data: Buffer.from('first'),
		};
		const secondFile: RawFile = { ...metadata, data: Buffer.from('second') };
		const ambiguousBytes = Buffer.concat([
			Buffer.from('first\0file\0'),
			Buffer.from(JSON.stringify(metadata, Object.keys(metadata).sort())),
			Buffer.from('\0second'),
		]);

		const oneFile = requestFingerprint(request, [{ ...firstFile, data: ambiguousBytes }], 'token');
		const twoFiles = requestFingerprint(request, [firstFile, secondFile], 'token');

		assert.notEqual(oneFile, twoFiles);
	});
});
