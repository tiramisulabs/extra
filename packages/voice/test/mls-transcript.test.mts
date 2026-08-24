import { describe, expect, test } from 'vitest';
import { VoiceCryptoProvider } from '../src/crypto/provider';
import { decodeAuthenticatedContent } from '../src/mls/protocol';
import { updateTranscriptHashes } from '../src/mls/transcript';

describe('MLS transcript hashes', () => {
	test('matches the official MLS ciphersuite 2 transcript vector', () => {
		const provider = new VoiceCryptoProvider();
		const authenticatedContent = decodeAuthenticatedContent(
			hex(
				'00010567726f7570000000000000345601000000000003220220e740a6faf2db65f5853148d75d9a335d7c4b94ab106fe5f237bc34fdcfc74584004046304402206f5ac008efb1d7edc106a27b4f3b71aa34821ca679543fd8bde8d728517b53bc0220223fb7226cc477e31ea25910d712fc915ce3df9f0399e0e7615babd593e2cdbb20fc804973ae28d04b9f3b71930414e29aa508f0711df720519f230e43a534b714',
			),
		);
		const previousInterim = hex('de0a78a0008b6c5c921c910d68da44abe0e692e1eea7e9f8226219ca34560f0d');
		const confirmationKey = hex('6999e1655b7f4bdda3cf2991965d889a331b487526a9c99c19d1060e4d677996');

		const hashes = updateTranscriptHashes(provider, previousInterim, authenticatedContent, confirmationKey);

		expect(Buffer.from(hashes.confirmed).toString('hex')).toBe(
			'e50ae43acf8ba84f712d8f48fa6ccd4768e48fad9c95feaf3061c54fe87a2779',
		);
		expect(Buffer.from(hashes.interim).toString('hex')).toBe(
			'87829eecb1aadfa10cbe2630fcc7ae9769d7fb2520f27b44ef76341c43ad834b',
		);
	});

	test('rejects a modified confirmation tag', () => {
		const provider = new VoiceCryptoProvider();
		const authenticatedContent = decodeAuthenticatedContent(
			hex(
				'00010567726f7570000000000000345601000000000003220220e740a6faf2db65f5853148d75d9a335d7c4b94ab106fe5f237bc34fdcfc74584004046304402206f5ac008efb1d7edc106a27b4f3b71aa34821ca679543fd8bde8d728517b53bc0220223fb7226cc477e31ea25910d712fc915ce3df9f0399e0e7615babd593e2cdbb20fc804973ae28d04b9f3b71930414e29aa508f0711df720519f230e43a534b714',
			),
		);
		const confirmationTag = authenticatedContent.auth.confirmationTag?.slice();
		if (confirmationTag === undefined) throw new Error('The test vector must contain a confirmation tag.');
		confirmationTag[0] ^= 1;
		const modified = { ...authenticatedContent, auth: { ...authenticatedContent.auth, confirmationTag } };

		expect(() =>
			updateTranscriptHashes(
				provider,
				hex('de0a78a0008b6c5c921c910d68da44abe0e692e1eea7e9f8226219ca34560f0d'),
				modified,
				hex('6999e1655b7f4bdda3cf2991965d889a331b487526a9c99c19d1060e4d677996'),
			),
		).toThrow('confirmation tag');
	});
});

function hex(value: string): Uint8Array {
	return Uint8Array.from(Buffer.from(value, 'hex'));
}
