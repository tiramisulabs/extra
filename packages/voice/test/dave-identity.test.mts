import { describe, expect, test } from 'vitest';
import { VoiceCryptoProvider } from '../src/crypto/provider';
import { DaveIdentity } from '../src/dave/identity';
import { verifyWithLabel } from '../src/mls/crypto';

describe('DaveIdentity', () => {
	test('uses one ephemeral P-256 key and erases it on close', () => {
		const provider = new VoiceCryptoProvider();
		const identity = new DaveIdentity(provider);
		const publicKey = identity.publicKey;
		const content = new TextEncoder().encode('identity');
		const signature = identity.sign('test', content);

		expect(identity.publicKey).not.toBe(publicKey);
		expect(identity.publicKey).toEqual(publicKey);
		expect(verifyWithLabel(provider, publicKey, 'test', content, signature)).toBe(true);

		identity.close();
		identity.close();
		expect(() => identity.publicKey).toThrow('closed');
		expect(() => identity.sign('test', content)).toThrow('closed');
	});
});
