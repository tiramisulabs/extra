import { describe, expect, test } from 'vitest';
import { VoiceCryptoProvider } from '../src/crypto/provider';
import {
	decryptWithLabel,
	deriveSecret,
	deriveTreeSecret,
	expandWithLabel,
	refHash,
	signWithLabel,
	verifyWithLabel,
} from '../src/mls/crypto';

const provider = new VoiceCryptoProvider();

describe('MLS ciphersuite 2 primitives', () => {
	test('matches the official ExpandWithLabel and DeriveSecret vectors', () => {
		expectHex(
			expandWithLabel(
				provider,
				hex('194d4e81c3f9fcfbc40e2cf3f5b104d0f51e71b5a7f1e4ddd70cc8d4a3620e5f'),
				'ExpandWithLabel',
				hex('453c420d63ecb1a8da89d3569770c42bad572864f3709d1e9dd19a0961cbf5e1'),
				16,
			),
			'5710680c556304f4aec67aab4abbc1b1',
		);
		expectHex(
			deriveSecret(provider, hex('7165576616048aa145d20f7c1d460e2d9d8bbde882bc3bb0750d50e369809f99'), 'DeriveSecret'),
			'1ecafd3d40cb32cae416e09bc01da56357d00cb094f74e3c69c2969216e50afc',
		);
	});

	test('matches the official DeriveTreeSecret and RefHash vectors', () => {
		expectHex(
			deriveTreeSecret(
				provider,
				hex('62db8a06300e98dbfd2c831e18544873cec3a2c1ba852fcee8423ff3c08e397e'),
				'DeriveTreeSecret',
				0xa0a0_a0a0,
				32,
			),
			'298ab27d2e621d9fc079126d9ffce5259fa0d58697267b40bfadf805b01d0d3c',
		);
		expectHex(
			refHash(provider, 'RefHash', hex('feb64672017685dc26d0b7fc41cd96d8bef40af09002eb5aa9a52580c80f0b2e')),
			'8f508c2f89d2797b6882ee487dc2832b2b6d59b27681293c2c2c3f1f0e6cd54f',
		);
	});

	test('verifies and creates SignWithLabel signatures', () => {
		const secretKey = hex('207c472d3efaf6737a6f5ae14a3c33a139034865364a128bca5475c85cc02fe0');
		const publicKey = hex(
			'04448971fc06de011d780cf68fd27e2570322d04079f529c3deb48a2015fdd828162c570264e051b5856e8111171fb0341907173aefa665682c2549af982a31483',
		);
		const content = hex('a0dda617ce4685d764c762b11186b6d60ff8de85ff01eca2413bd4ecfd3b3a57');
		const signature = hex(
			'304402206042e397e1bb78951709790e3446b13bf17f9c641aaed92fb1768b5bc99dd98402202465153d91dd79e808286088768d8ed150381f3675498d6e150ae713be43387b',
		);
		expect(verifyWithLabel(provider, publicKey, 'SignWithLabel', content, signature)).toBe(true);
		expect(verifyWithLabel(provider, publicKey, 'different', content, signature)).toBe(false);
		expect(
			verifyWithLabel(
				provider,
				publicKey,
				'SignWithLabel',
				content,
				signWithLabel(provider, secretKey, 'SignWithLabel', content),
			),
		).toBe(true);
	});

	test('opens the official EncryptWithLabel vector', () => {
		const plaintext = decryptWithLabel(
			provider,
			hex('ff21771424dadd640e05c67983aafe19b4d8df50783a0c2decc17d0c7ca4cc17'),
			'EncryptWithLabel',
			hex('e27e3b0104990cca866751732c82787af4dcf265c893f77e31bcfd679370e24e'),
			hex(
				'041fae8a8173cad50c0cc6d55f148ff8edda63083b3673cf6dce6a0ae6ee3f0b61505470309dade87ac5ccdb581da3e9ddf6726949d5a92b65dcad6c8679c7313e',
			),
			hex('98b7d4edc79f4a90f65434050f75e31a3bc6501c584d41abd6ed5fe3c2db9de22d25ef40c45cce7d0fcc881d7d27af2f'),
		);
		expectHex(plaintext, '38a6b327573639d654b5b729336cf74d01728cf4fa9af81a0ef1814ffc1d492f');
	});
});

function hex(value: string): Uint8Array {
	return Buffer.from(value, 'hex');
}

function expectHex(value: Uint8Array, expected: string): void {
	expect(Buffer.from(value).toString('hex')).toBe(expected);
}
