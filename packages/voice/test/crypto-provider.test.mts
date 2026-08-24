import { describe, expect, test } from 'vitest';
import { hpkeOpenBase, hpkeSealBase } from '../src/crypto/hpke';
import { VoiceCryptoProvider } from '../src/crypto/provider';

function fromHex(value: string): Uint8Array {
	if (value.length % 2 !== 0 || !/^[\da-f]*$/i.test(value))
		throw new TypeError('Expected an even-length hexadecimal string.');
	return Uint8Array.from(value.match(/.{2}/g) ?? [], byte => Number.parseInt(byte, 16));
}

function toHex(value: Uint8Array): string {
	return Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('');
}

describe('VoiceCryptoProvider', () => {
	test('matches RFC 5869 HKDF-SHA256 test case 1', () => {
		const provider = new VoiceCryptoProvider();
		const pseudorandomKey = provider.hkdfExtract(new Uint8Array(22).fill(0x0b), fromHex('000102030405060708090a0b0c'));

		expect(toHex(pseudorandomKey)).toBe('077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5');
		expect(toHex(provider.hkdfExpand(pseudorandomKey, fromHex('f0f1f2f3f4f5f6f7f8f9'), 42))).toBe(
			'3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
		);
	});

	test('signs, verifies, validates, and derives symmetric P-256 secrets', () => {
		const provider = new VoiceCryptoProvider();
		const alice = provider.generateP256KeyPair();
		const bob = provider.generateP256KeyPair();
		const message = new TextEncoder().encode('discord voice');
		const signature = provider.signP256(message, alice.secretKey);

		expect(provider.verifyP256(signature, message, alice.publicKey)).toBe(true);
		expect(provider.verifyP256(signature, new TextEncoder().encode('different'), alice.publicKey)).toBe(false);
		expect(provider.p256SharedSecret(alice.secretKey, bob.publicKey)).toEqual(
			provider.p256SharedSecret(bob.secretKey, alice.publicKey),
		);
		expect(() => provider.validateP256PublicKey(new Uint8Array(65))).toThrow(TypeError);
	});

	test.each([16, 32])('round-trips AES-%i-GCM and rejects modified authentication tags', keyLength => {
		const provider = new VoiceCryptoProvider();
		const key = provider.randomBytes(keyLength);
		const nonce = provider.randomBytes(12);
		const additionalData = new TextEncoder().encode('header');
		const plaintext = new TextEncoder().encode('voice frame');
		const ciphertext = provider.aesGcmSeal(key, nonce, additionalData, plaintext);

		expect(provider.aesGcmOpen(key, nonce, additionalData, ciphertext)).toEqual(plaintext);
		const modified = ciphertext.slice();
		modified[modified.length - 1] ^= 1;
		expect(() => provider.aesGcmOpen(key, nonce, additionalData, modified)).toThrow();
	});

	test('round-trips XChaCha20-Poly1305 and rejects modified authentication tags', () => {
		const provider = new VoiceCryptoProvider();
		const key = provider.randomBytes(32);
		const nonce = provider.randomBytes(24);
		const additionalData = new TextEncoder().encode('header');
		const plaintext = new TextEncoder().encode('voice frame');
		const ciphertext = provider.xchacha20Poly1305Seal(key, nonce, additionalData, plaintext);

		expect(provider.xchacha20Poly1305Open(key, nonce, additionalData, ciphertext)).toEqual(plaintext);
		const modified = ciphertext.slice();
		modified[modified.length - 1] ^= 1;
		expect(() => provider.xchacha20Poly1305Open(key, nonce, additionalData, modified)).toThrow();
	});
});

describe('HPKE Base mode', () => {
	test('matches the RFC 9180 P-256/HKDF-SHA256/AES-128-GCM vector', () => {
		const provider = new VoiceCryptoProvider();
		const recipientSecretKey = fromHex('f3ce7fdae57e1a310d87f1ebbde6f328be0a99cdbcadf4d6589cf29de4b8ffd2');
		const recipientPublicKey = fromHex(
			'04fe8c19ce0905191ebc298a9245792531f26f0cece2460639e8bc39cb7f706a826a779b4cf969b8a0e539c7f62fb3d30ad6aa8f80e30f1d128aafd68a2ce72ea0',
		);
		const ephemeralSecretKey = fromHex('4995788ef4b9d6132b249ce59a77281493eb39af373d236a1fe415cb0c2d7beb');
		const info = fromHex('4f6465206f6e2061204772656369616e2055726e');
		const additionalData = fromHex('436f756e742d30');
		const plaintext = fromHex('4265617574792069732074727574682c20747275746820626561757479');
		const sealed = hpkeSealBase(provider, recipientPublicKey, info, additionalData, plaintext, ephemeralSecretKey);

		expect(toHex(sealed.kemOutput)).toBe(
			'04a92719c6195d5085104f469a8b9814d5838ff72b60501e2c4466e5e67b325ac98536d7b61a1af4b78e5b7f951c0900be863c403ce65c9bfcb9382657222d18c4',
		);
		expect(toHex(sealed.ciphertext)).toBe(
			'5ad590bb8baa577f8619db35a36311226a896e7342a6d836d8b7bcd2f20b6c7f9076ac232e3ab2523f39513434',
		);
		expect(
			hpkeOpenBase(provider, recipientSecretKey, sealed.kemOutput, info, additionalData, sealed.ciphertext),
		).toEqual(plaintext);
	});
});
