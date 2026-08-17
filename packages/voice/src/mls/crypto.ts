import { concatenateBytes, equalBytes } from '../bytes';
import { type HpkeCiphertext, hpkeDeriveP256KeyPair, hpkeOpenBase, hpkeSealBase } from '../crypto/hpke';
import type { P256KeyPair, VoiceCryptoProvider } from '../crypto/provider';
import { MlsWriter } from './codec';

const EMPTY = new Uint8Array();
const MLS_LABEL = 'MLS 1.0 ';
const TEXT_ENCODER = new TextEncoder();

export function expandWithLabel(
	provider: VoiceCryptoProvider,
	secret: Uint8Array,
	label: string | Uint8Array,
	context: Uint8Array,
	length: number,
): Uint8Array {
	const info = new MlsWriter()
		.uint16(length)
		.vector(concatenateBytes(TEXT_ENCODER.encode(MLS_LABEL), encodeLabel(label)))
		.vector(context)
		.finish();
	return provider.hkdfExpand(secret, info, length);
}

export function deriveSecret(provider: VoiceCryptoProvider, secret: Uint8Array, label: string): Uint8Array {
	return expandWithLabel(provider, secret, label, EMPTY, 32);
}

export function deriveTreeSecret(
	provider: VoiceCryptoProvider,
	secret: Uint8Array,
	label: string,
	generation: number,
	length: number,
): Uint8Array {
	const context = new MlsWriter().uint32(generation).finish();
	return expandWithLabel(provider, secret, label, context, length);
}

export function refHash(
	provider: VoiceCryptoProvider,
	label: 'MLS 1.0 KeyPackage Reference' | 'MLS 1.0 Proposal Reference' | string,
	value: Uint8Array,
): Uint8Array {
	return provider.sha256(new MlsWriter().vector(TEXT_ENCODER.encode(label)).vector(value).finish());
}

export function signWithLabel(
	provider: VoiceCryptoProvider,
	secretKey: Uint8Array,
	label: string,
	content: Uint8Array,
): Uint8Array {
	return provider.signP256(createSignContent(label, content), secretKey);
}

export function verifyWithLabel(
	provider: VoiceCryptoProvider,
	publicKey: Uint8Array,
	label: string,
	content: Uint8Array,
	signature: Uint8Array,
): boolean {
	return provider.verifyP256(signature, createSignContent(label, content), publicKey);
}

export function encryptWithLabel(
	provider: VoiceCryptoProvider,
	publicKey: Uint8Array,
	label: string,
	context: Uint8Array,
	plaintext: Uint8Array,
	ephemeralSecretKey?: Uint8Array,
): HpkeCiphertext {
	return hpkeSealBase(provider, publicKey, createEncryptContext(label, context), EMPTY, plaintext, ephemeralSecretKey);
}

export function decryptWithLabel(
	provider: VoiceCryptoProvider,
	secretKey: Uint8Array,
	label: string,
	context: Uint8Array,
	kemOutput: Uint8Array,
	ciphertext: Uint8Array,
): Uint8Array {
	return hpkeOpenBase(provider, secretKey, kemOutput, createEncryptContext(label, context), EMPTY, ciphertext);
}

export function deriveP256KeyPair(provider: VoiceCryptoProvider, secret: Uint8Array): P256KeyPair {
	return hpkeDeriveP256KeyPair(provider, secret);
}

export function mac(provider: VoiceCryptoProvider, key: Uint8Array, content: Uint8Array): Uint8Array {
	return provider.hmacSha256(key, content);
}

export function verifyMac(
	provider: VoiceCryptoProvider,
	key: Uint8Array,
	content: Uint8Array,
	expected: Uint8Array,
): boolean {
	const actual = mac(provider, key, content);
	try {
		return equalBytes(actual, expected);
	} finally {
		actual.fill(0);
	}
}

function createSignContent(label: string, content: Uint8Array): Uint8Array {
	return new MlsWriter()
		.vector(TEXT_ENCODER.encode(`${MLS_LABEL}${label}`))
		.vector(content)
		.finish();
}

function createEncryptContext(label: string, context: Uint8Array): Uint8Array {
	return new MlsWriter()
		.vector(TEXT_ENCODER.encode(`${MLS_LABEL}${label}`))
		.vector(context)
		.finish();
}

function encodeLabel(label: string | Uint8Array): Uint8Array {
	return typeof label === 'string' ? TEXT_ENCODER.encode(label) : label;
}
