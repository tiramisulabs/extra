import { createCipheriv, createDecipheriv, randomBytes as nodeRandomBytes } from 'node:crypto';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { p256 } from '@noble/curves/nist.js';
import { extract as hkdfExtract } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatenateBytes, equalBytes } from '../bytes';

export interface P256KeyPair {
	readonly secretKey: Uint8Array;
	readonly publicKey: Uint8Array;
}

export class VoiceCryptoProvider {
	randomBytes(length: number): Uint8Array {
		if (!Number.isSafeInteger(length) || length < 0)
			throw new RangeError('length must be a non-negative safe integer.');
		return new Uint8Array(nodeRandomBytes(length));
	}

	sha256(data: Uint8Array): Uint8Array {
		return sha256(data);
	}

	hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
		return hmac(sha256, key, data);
	}

	hkdfExtract(inputKeyMaterial: Uint8Array, salt: Uint8Array): Uint8Array {
		return hkdfExtract(sha256, inputKeyMaterial, salt);
	}

	hkdfExpand(pseudorandomKey: Uint8Array, info: Uint8Array, length: number): Uint8Array {
		if (!Number.isSafeInteger(length) || length < 0 || length > 255 * sha256.outputLen) {
			throw new RangeError('HKDF output length must fit the RFC 5869 SHA-256 expansion bound.');
		}
		const output = new Uint8Array(length);
		let previous = new Uint8Array();
		let offset = 0;
		for (let counter = 1; offset < length; counter++) {
			const block = hmac(sha256, pseudorandomKey, concatenateBytes(previous, info, Uint8Array.of(counter)));
			previous.fill(0);
			previous = block;
			const count = Math.min(block.byteLength, length - offset);
			output.set(block.subarray(0, count), offset);
			offset += count;
		}
		previous.fill(0);
		return output;
	}

	generateP256KeyPair(): P256KeyPair {
		const { secretKey } = p256.keygen();
		return { secretKey, publicKey: p256.getPublicKey(secretKey, false) };
	}

	getP256PublicKey(secretKey: Uint8Array): Uint8Array {
		assertP256SecretKey(secretKey);
		return p256.getPublicKey(secretKey, false);
	}

	validateP256PublicKey(publicKey: Uint8Array): void {
		if (publicKey.byteLength !== 65 || publicKey[0] !== 4 || !p256.utils.isValidPublicKey(publicKey, false)) {
			throw new TypeError('P-256 public keys must be valid uncompressed SEC1 points.');
		}
	}

	p256SharedSecret(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
		assertP256SecretKey(secretKey);
		this.validateP256PublicKey(publicKey);
		const point = p256.getSharedSecret(secretKey, publicKey, false);
		if (point.byteLength !== 65 || point[0] !== 4) throw new Error('P-256 ECDH returned an invalid point.');
		return point.slice(1, 33);
	}

	signP256(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
		assertP256SecretKey(secretKey);
		return p256.sign(message, secretKey, { format: 'der', lowS: true, prehash: true });
	}

	verifyP256(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
		try {
			this.validateP256PublicKey(publicKey);
			return p256.verify(signature, message, publicKey, { format: 'der', lowS: false, prehash: true });
		} catch {
			return false;
		}
	}

	aesGcmSeal(
		key: Uint8Array,
		nonce: Uint8Array,
		additionalData: Uint8Array,
		plaintext: Uint8Array,
		tagLength = 16,
	): Uint8Array {
		assertAesGcmInput(key, nonce, tagLength);
		const cipher = createCipheriv(resolveAesGcmAlgorithm(key), key, nonce, { authTagLength: tagLength });
		cipher.setAAD(additionalData);
		return concatenateBytes(cipher.update(plaintext), cipher.final(), cipher.getAuthTag());
	}

	aesGcmOpen(
		key: Uint8Array,
		nonce: Uint8Array,
		additionalData: Uint8Array,
		ciphertext: Uint8Array,
		tagLength = 16,
	): Uint8Array {
		assertAesGcmInput(key, nonce, tagLength);
		if (ciphertext.byteLength < tagLength) throw new TypeError('AES-GCM ciphertext is shorter than its tag.');
		const encrypted = ciphertext.subarray(0, -tagLength);
		const tag = ciphertext.subarray(-tagLength);
		const decipher = createDecipheriv(resolveAesGcmAlgorithm(key), key, nonce, { authTagLength: tagLength });
		decipher.setAAD(additionalData);
		decipher.setAuthTag(tag);
		return concatenateBytes(decipher.update(encrypted), decipher.final());
	}

	xchacha20Poly1305Seal(
		key: Uint8Array,
		nonce: Uint8Array,
		additionalData: Uint8Array,
		plaintext: Uint8Array,
	): Uint8Array {
		return xchacha20poly1305(key, nonce, additionalData).encrypt(plaintext);
	}

	xchacha20Poly1305Open(
		key: Uint8Array,
		nonce: Uint8Array,
		additionalData: Uint8Array,
		ciphertext: Uint8Array,
	): Uint8Array {
		return xchacha20poly1305(key, nonce, additionalData).decrypt(ciphertext);
	}

	scrypt(
		password: Uint8Array,
		salt: Uint8Array,
		options: { readonly N: number; readonly r: number; readonly p: number; readonly length: number },
	): Promise<Uint8Array> {
		return scryptAsync(password, salt, { N: options.N, r: options.r, p: options.p, dkLen: options.length });
	}
}

/** @internal */
export function assertP256KeyPair(provider: VoiceCryptoProvider, keyPair: P256KeyPair, failureMessage: string): void {
	provider.validateP256PublicKey(keyPair.publicKey);
	if (equalBytes(provider.getP256PublicKey(keyPair.secretKey), keyPair.publicKey)) return;
	throw new TypeError(failureMessage);
}

function assertP256SecretKey(secretKey: Uint8Array): void {
	if (secretKey.byteLength === 32 && p256.utils.isValidSecretKey(secretKey)) return;
	throw new TypeError('P-256 secret keys must be valid 32-byte scalars.');
}

function resolveAesGcmAlgorithm(key: Uint8Array): 'aes-128-gcm' | 'aes-256-gcm' {
	if (key.byteLength === 16) return 'aes-128-gcm';
	if (key.byteLength === 32) return 'aes-256-gcm';
	throw new TypeError('AES-GCM keys must contain 16 or 32 bytes.');
}

function assertAesGcmInput(key: Uint8Array, nonce: Uint8Array, tagLength: number): void {
	resolveAesGcmAlgorithm(key);
	if (nonce.byteLength !== 12) throw new TypeError('AES-GCM nonces must contain 12 bytes.');
	if (tagLength !== 8 && tagLength !== 16) throw new TypeError('AES-GCM tags must contain 8 or 16 bytes.');
}
