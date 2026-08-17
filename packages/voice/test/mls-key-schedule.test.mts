import { describe, expect, test } from 'vitest';
import { VoiceCryptoProvider } from '../src/crypto/provider';
import { deriveP256KeyPair } from '../src/mls/crypto';
import { deriveEpochSecrets, exportMlsSecret, type MlsEpochSecrets } from '../src/mls/key-schedule';

const provider = new VoiceCryptoProvider();

describe('MLS key schedule', () => {
	test('matches the official ciphersuite 2 epoch vector', () => {
		const epoch = deriveEpochSecrets(
			provider,
			hex('a897b53575b4dd35fed4466e4e714bfa949eaa72e616a9c68a47b39cb7a60d2e'),
			hex('a22606222e350fd7f0937168fe7548fb06626ab143cba7611d641693b1447509'),
			hex(
				'0001000220a897b53575b4dd35fed4466e4e714bfa949eaa72e616a9c68a47b39cb7a60d2e0000000000000000209769e302a99c457350a8e636009b12a2fee068664004606d6318eb3a1977d818205e57c9364dc71f0f71b19ffe561ab77257c490708a47e29f8f73f2b318201d2f00',
			),
			hex('e871b247379522395689182736cb3d1e7b108d6ae934b802223975de8dc3f80b'),
		);
		expectSecrets(epoch, {
			joinerSecret: 'b3e94856e4ac46ce5a92176b7a1d97e1b8c5e4d50aff1bb25c7387b756dafd52',
			welcomeSecret: '159dc69117edda2a8d7f01f7b3ee9252a576e38e3524ebf8dbd59efa39ef3332',
			initSecret: '8669c65d78b3f0ffea3d0e5d2205eb799ec39b97dada7624af0ccc3fa65bcd60',
			senderDataSecret: 'a19b19d68dd5b2744bdd38e9576d8b68e7592395dcd9a19f8853d831cbb783bd',
			encryptionSecret: 'de53a6bb794b7652cb69589cfae9007a8f6f50347d91821a02c02c94b8d502e9',
			exporterSecret: '37b4777fbfa0bb7b83d5a4e52d1d249000564918b96436704595c36b57c1e366',
			externalSecret: '1f0124fdbb08c0d72123838e3731ab6953a53d565496f523bb3a4e539c949aac',
			confirmationKey: '9d8dd78766b9391995f0cd122bff536c01e056ae3c29fbd8dca3a128f1a097ba',
			membershipKey: '136eed7ac9f27002cbb4bc47d91676341df8c8eaa8349828dd51d22d5ffb3f43',
			resumptionPsk: '99444cb54d7e6d7da939124f5a666bac5a878eb756405a437893914b33353504',
			epochAuthenticator: '6bb5c0d569550a2c7e1917b0ebeef193b703281fc5eaa3392b3125c8e394f69d',
		});
	});

	test('matches the official exporter vector with an opaque label', () => {
		expectHex(
			exportMlsSecret(
				provider,
				hex('37b4777fbfa0bb7b83d5a4e52d1d249000564918b96436704595c36b57c1e366'),
				'9ba13d54ecdec7cbefcb47b4268d7b1990fabc6d6e67681e167959389d84e4e4',
				hex('884f1af892ab002f5be4c5d5081ade9e0e6418c6ea7a9a92e90534f19dcef785'),
				32,
			),
			'fb21b093a965ca191ddc236dd38791d738d37818d8d3861020151dfdd8ee70b0',
		);
	});

	test('matches the official external key derivation vector', () => {
		expectHex(
			deriveP256KeyPair(provider, hex('1f0124fdbb08c0d72123838e3731ab6953a53d565496f523bb3a4e539c949aac')).publicKey,
			'0404c9d6889bc661210f8c74d9e07e355755268949b606694c395516b978e76e88d30be4f47e427abf0e64126dee99df85a62a90de44fc7feafab3e355d6338d8c',
		);
	});
});

function expectSecrets(actual: MlsEpochSecrets, expected: Record<keyof MlsEpochSecrets, string>): void {
	for (const key of Object.keys(expected) as (keyof MlsEpochSecrets)[]) expectHex(actual[key], expected[key]);
}

function hex(value: string): Uint8Array {
	return Buffer.from(value, 'hex');
}

function expectHex(value: Uint8Array, expected: string): void {
	expect(Buffer.from(value).toString('hex')).toBe(expected);
}
