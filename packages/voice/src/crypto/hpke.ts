import { concatenateBytes } from '../bytes';
import type { P256KeyPair, VoiceCryptoProvider } from './provider';

const EMPTY = new Uint8Array();
const HPKE_VERSION_LABEL = new TextEncoder().encode('HPKE-v1');
const KEM_SUITE_ID = concatenateBytes(new TextEncoder().encode('KEM'), uint16(0x0010));
const HPKE_SUITE_ID = concatenateBytes(
	new TextEncoder().encode('HPKE'),
	uint16(0x0010),
	uint16(0x0001),
	uint16(0x0001),
);

export interface HpkeCiphertext {
	readonly kemOutput: Uint8Array;
	readonly ciphertext: Uint8Array;
}

export function hpkeDeriveP256KeyPair(provider: VoiceCryptoProvider, inputKeyMaterial: Uint8Array): P256KeyPair {
	const derivationPseudorandomKey = labeledExtract(provider, KEM_SUITE_ID, EMPTY, 'dkp_prk', inputKeyMaterial);
	try {
		for (let counter = 0; counter <= 0xff; counter++) {
			const secretKey = labeledExpand(
				provider,
				KEM_SUITE_ID,
				derivationPseudorandomKey,
				'candidate',
				Uint8Array.of(counter),
				32,
			);
			try {
				return { secretKey, publicKey: provider.getP256PublicKey(secretKey) };
			} catch {
				secretKey.fill(0);
			}
		}
		throw new Error('HPKE could not derive a valid P-256 secret key.');
	} finally {
		eraseBytes(derivationPseudorandomKey);
	}
}

export function hpkeSealBase(
	provider: VoiceCryptoProvider,
	recipientPublicKey: Uint8Array,
	info: Uint8Array,
	additionalData: Uint8Array,
	plaintext: Uint8Array,
	ephemeralSecretKey?: Uint8Array,
): HpkeCiphertext {
	provider.validateP256PublicKey(recipientPublicKey);
	const ephemeralSecret = ephemeralSecretKey?.slice() ?? provider.generateP256KeyPair().secretKey;
	let diffieHellmanSecret: Uint8Array | undefined;
	let sharedSecret: Uint8Array | undefined;
	let key: Uint8Array | undefined;
	let nonce: Uint8Array | undefined;
	try {
		const ephemeralPublic = provider.getP256PublicKey(ephemeralSecret);
		diffieHellmanSecret = provider.p256SharedSecret(ephemeralSecret, recipientPublicKey);
		sharedSecret = extractAndExpand(
			provider,
			diffieHellmanSecret,
			concatenateBytes(ephemeralPublic, recipientPublicKey),
		);
		({ key, nonce } = deriveBaseContext(provider, sharedSecret, info));
		return {
			kemOutput: ephemeralPublic,
			ciphertext: provider.aesGcmSeal(key, nonce, additionalData, plaintext),
		};
	} finally {
		eraseBytes(ephemeralSecret, diffieHellmanSecret, sharedSecret, key, nonce);
	}
}

export function hpkeOpenBase(
	provider: VoiceCryptoProvider,
	recipientSecretKey: Uint8Array,
	kemOutput: Uint8Array,
	info: Uint8Array,
	additionalData: Uint8Array,
	ciphertext: Uint8Array,
): Uint8Array {
	provider.validateP256PublicKey(kemOutput);
	const recipientPublicKey = provider.getP256PublicKey(recipientSecretKey);
	let diffieHellmanSecret: Uint8Array | undefined;
	let sharedSecret: Uint8Array | undefined;
	let key: Uint8Array | undefined;
	let nonce: Uint8Array | undefined;
	try {
		diffieHellmanSecret = provider.p256SharedSecret(recipientSecretKey, kemOutput);
		sharedSecret = extractAndExpand(provider, diffieHellmanSecret, concatenateBytes(kemOutput, recipientPublicKey));
		({ key, nonce } = deriveBaseContext(provider, sharedSecret, info));
		return provider.aesGcmOpen(key, nonce, additionalData, ciphertext);
	} finally {
		eraseBytes(diffieHellmanSecret, sharedSecret, key, nonce);
	}
}

function extractAndExpand(
	provider: VoiceCryptoProvider,
	diffieHellmanSecret: Uint8Array,
	kemContext: Uint8Array,
): Uint8Array {
	const eaePseudorandomKey = labeledExtract(provider, KEM_SUITE_ID, EMPTY, 'eae_prk', diffieHellmanSecret);
	try {
		return labeledExpand(provider, KEM_SUITE_ID, eaePseudorandomKey, 'shared_secret', kemContext, 32);
	} finally {
		eraseBytes(eaePseudorandomKey);
	}
}

function deriveBaseContext(
	provider: VoiceCryptoProvider,
	sharedSecret: Uint8Array,
	info: Uint8Array,
): { readonly key: Uint8Array; readonly nonce: Uint8Array } {
	const pskIdHash = labeledExtract(provider, HPKE_SUITE_ID, EMPTY, 'psk_id_hash', EMPTY);
	const infoHash = labeledExtract(provider, HPKE_SUITE_ID, EMPTY, 'info_hash', info);
	const context = concatenateBytes(Uint8Array.of(0), pskIdHash, infoHash);
	const secret = labeledExtract(provider, HPKE_SUITE_ID, sharedSecret, 'secret', EMPTY);
	try {
		return {
			key: labeledExpand(provider, HPKE_SUITE_ID, secret, 'key', context, 16),
			nonce: labeledExpand(provider, HPKE_SUITE_ID, secret, 'base_nonce', context, 12),
		};
	} finally {
		eraseBytes(secret);
	}
}

function labeledExtract(
	provider: VoiceCryptoProvider,
	suiteId: Uint8Array,
	salt: Uint8Array,
	label: string,
	inputKeyMaterial: Uint8Array,
): Uint8Array {
	return provider.hkdfExtract(
		concatenateBytes(HPKE_VERSION_LABEL, suiteId, new TextEncoder().encode(label), inputKeyMaterial),
		salt,
	);
}

function labeledExpand(
	provider: VoiceCryptoProvider,
	suiteId: Uint8Array,
	pseudorandomKey: Uint8Array,
	label: string,
	info: Uint8Array,
	length: number,
): Uint8Array {
	return provider.hkdfExpand(
		pseudorandomKey,
		concatenateBytes(uint16(length), HPKE_VERSION_LABEL, suiteId, new TextEncoder().encode(label), info),
		length,
	);
}

function uint16(value: number): Uint8Array<ArrayBuffer> {
	if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new RangeError('value must fit uint16.');
	const output = new Uint8Array(2);
	new DataView(output.buffer).setUint16(0, value);
	return output;
}

function eraseBytes(...values: readonly (Uint8Array | undefined)[]): void {
	for (const value of values) value?.fill(0);
}
