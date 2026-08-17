import { describe, expect, test } from 'vitest';
import { VoiceCryptoProvider } from '../src/crypto/provider';
import {
	createDaveEpochAuthenticatorCode,
	createDavePairwiseVerificationCode,
	createDaveSenderExportContext,
	deriveDavePairwiseVerificationCode,
	deriveDaveVerificationFingerprint,
	encodeSnowflakeBigEndian,
	encodeSnowflakeLittleEndian,
} from '../src/dave/verification';

const FIRST_PUBLIC_KEY = fromHex(
	'046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5',
);
const SECOND_PUBLIC_KEY = fromHex(
	'047cf27b188d034f7e8a52380304b51ac3c08969e277f21b35a60b48fc4766997807775510db8ed040293d9ac69f7430dbba7dade63ce982299e04b79d227873d1',
);

describe('DAVE verification', () => {
	test('encodes Discord snowflakes in both protocol byte orders', () => {
		const userId = '72623859790382856';
		expect(toHex(encodeSnowflakeBigEndian(userId))).toBe('0102030405060708');
		expect(toHex(encodeSnowflakeLittleEndian(userId))).toBe('0807060504030201');
		expect(createDaveSenderExportContext(userId)).toEqual(encodeSnowflakeLittleEndian(userId));
	});

	test('uses the native bigint parser for snowflake input', () => {
		expect(() => encodeSnowflakeBigEndian('snowflake')).toThrow(SyntaxError);
	});

	test('creates canonical 30 and 45 digit displayable codes', () => {
		const authenticator = Uint8Array.from({ length: 32 }, (_, index) => index);
		const fingerprint = Uint8Array.from({ length: 64 }, (_, index) => index);
		const epochCode = createDaveEpochAuthenticatorCode(authenticator);
		const pairwiseCode = createDavePairwiseVerificationCode(fingerprint);

		expect(epochCode).toBe('090606058512110636351516066685');
		expect(pairwiseCode).toBe('090606058512110636351516066685182106973521260');
		expect(epochCode).toMatch(/^\d{30}$/);
		expect(pairwiseCode).toMatch(/^\d{45}$/);
	});

	test('rejects displayable-code inputs with the wrong protocol length', () => {
		expect(() => createDaveEpochAuthenticatorCode(new Uint8Array(31))).toThrow('32 bytes');
		expect(() => createDaveEpochAuthenticatorCode(new Uint8Array(33))).toThrow('32 bytes');
		expect(() => createDavePairwiseVerificationCode(new Uint8Array(63))).toThrow('64 bytes');
		expect(() => createDavePairwiseVerificationCode(new Uint8Array(65))).toThrow('64 bytes');
	});

	test('matches an independently generated scrypt fingerprint vector and is symmetric', async () => {
		const provider = new VoiceCryptoProvider();
		const first = { userId: '1', publicKey: FIRST_PUBLIC_KEY };
		const second = { userId: '72623859790382856', publicKey: SECOND_PUBLIC_KEY };
		const expected =
			'f8ce49bd243952d90f0da9fad6fdaf5b676bec30262a7501a57780cf5e065af7fa5c56388e9252c501e2c18dcbaee2ec9ad6bb3323545e2984cd08eb772fdb1f';

		expect(toHex(await deriveDaveVerificationFingerprint(provider, first, second))).toBe(expected);
		expect(toHex(await deriveDaveVerificationFingerprint(provider, second, first))).toBe(expected);
		expect(await deriveDavePairwiseVerificationCode(provider, first, second)).toBe(
			'284529274966671500006845381894366302269302859',
		);
	});

	test('validates fingerprint public keys before starting scrypt', async () => {
		const provider = new VoiceCryptoProvider();
		await expect(
			deriveDaveVerificationFingerprint(
				provider,
				{ userId: '1', publicKey: new Uint8Array(65) },
				{ userId: '2', publicKey: SECOND_PUBLIC_KEY },
			),
		).rejects.toThrow('P-256');
	});
});

function fromHex(value: string): Uint8Array {
	return Uint8Array.from(value.match(/.{2}/g) ?? [], byte => Number.parseInt(byte, 16));
}

function toHex(value: Uint8Array): string {
	return Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('');
}
