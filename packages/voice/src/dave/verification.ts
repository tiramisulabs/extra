import { concatenateBytes } from '../bytes';
import type { VoiceCryptoProvider } from '../crypto/provider';

const DAVE_FINGERPRINT_SALT = Uint8Array.of(
	0x24,
	0xca,
	0xb1,
	0x7a,
	0x7a,
	0xf8,
	0xec,
	0x2b,
	0x82,
	0xb4,
	0x12,
	0xb9,
	0x2d,
	0xab,
	0x19,
	0x2e,
);
const VERIFICATION_VERSION = Uint8Array.of(0, 0);

export interface DaveVerificationIdentity {
	readonly userId: string;
	readonly publicKey: Uint8Array;
}

export function encodeSnowflakeBigEndian(userId: string): Uint8Array<ArrayBuffer> {
	return encodeSnowflake(userId, false);
}

export function encodeSnowflakeLittleEndian(userId: string): Uint8Array<ArrayBuffer> {
	return encodeSnowflake(userId, true);
}

export function createDaveSenderExportContext(userId: string): Uint8Array<ArrayBuffer> {
	return encodeSnowflakeLittleEndian(userId);
}

export function createDaveEpochAuthenticatorCode(authenticator: Uint8Array): string {
	if (authenticator.byteLength !== 32) throw new TypeError('A DAVE epoch authenticator must contain 32 bytes.');
	return createDisplayableCode(authenticator, 30);
}

export function createDavePairwiseVerificationCode(fingerprint: Uint8Array): string {
	if (fingerprint.byteLength !== 64) throw new TypeError('A DAVE verification fingerprint must contain 64 bytes.');
	return createDisplayableCode(fingerprint, 45);
}

export async function deriveDaveVerificationFingerprint(
	provider: VoiceCryptoProvider,
	first: DaveVerificationIdentity,
	second: DaveVerificationIdentity,
): Promise<Uint8Array> {
	provider.validateP256PublicKey(first.publicKey);
	provider.validateP256PublicKey(second.publicKey);
	const firstInput = createFingerprintInput(first);
	const secondInput = createFingerprintInput(second);
	const ordered = compareBytes(firstInput, secondInput) <= 0 ? [firstInput, secondInput] : [secondInput, firstInput];
	return provider.scrypt(concatenateBytes(...ordered), DAVE_FINGERPRINT_SALT, {
		N: 16_384,
		r: 8,
		p: 2,
		length: 64,
	});
}

export async function deriveDavePairwiseVerificationCode(
	provider: VoiceCryptoProvider,
	first: DaveVerificationIdentity,
	second: DaveVerificationIdentity,
): Promise<string> {
	const fingerprint = await deriveDaveVerificationFingerprint(provider, first, second);
	try {
		return createDavePairwiseVerificationCode(fingerprint);
	} finally {
		fingerprint.fill(0);
	}
}

function encodeSnowflake(userId: string, littleEndian: boolean): Uint8Array<ArrayBuffer> {
	const output = new Uint8Array(8);
	new DataView(output.buffer).setBigUint64(0, BigInt(userId), littleEndian);
	return output;
}

function createFingerprintInput(identity: DaveVerificationIdentity): Uint8Array<ArrayBuffer> {
	return concatenateBytes(VERIFICATION_VERSION, identity.publicKey, encodeSnowflakeBigEndian(identity.userId));
}

function createDisplayableCode(input: Uint8Array, codeLength: number): string {
	let output = '';
	for (let offset = 0; offset < codeLength; offset += 5) {
		let value = 0n;
		for (let index = offset; index < offset + 5; index++) value = (value << 8n) | BigInt(input[index] as number);
		output += (value % 100_000n).toString().padStart(5, '0');
	}
	return output;
}

function compareBytes(first: Uint8Array, second: Uint8Array): number {
	const length = Math.min(first.byteLength, second.byteLength);
	for (let index = 0; index < length; index++) {
		const difference = (first[index] as number) - (second[index] as number);
		if (difference !== 0) return difference;
	}
	return first.byteLength - second.byteLength;
}
