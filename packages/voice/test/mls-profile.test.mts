import { describe, expect, test } from 'vitest';
import { type P256KeyPair, VoiceCryptoProvider } from '../src/crypto/provider';
import { DaveIdentity } from '../src/dave/identity';
import { encodeSnowflakeBigEndian } from '../src/dave/verification';
import { refHash, verifyWithLabel } from '../src/mls/crypto';
import {
	createDaveJoinKeyPackage,
	createDaveKeyPackage,
	createDaveKeyPackageFromLeaf,
	createDaveLeafMaterial,
	validateDaveKeyPackage,
	validateDaveLeafNode,
} from '../src/mls/profile';
import {
	CipherSuite,
	CredentialType,
	decodeMlsMessage,
	ExtensionType,
	encodeKeyPackage,
	encodeKeyPackageTbs,
	encodeLeafNodeTbs,
	LeafNodeSource,
	type MlsCapabilities,
	type MlsKeyPackage,
	type MlsLeafNode,
	ProposalType,
	ProtocolVersion,
	WireFormat,
} from '../src/mls/protocol';

const USER_ID = '123456789012345678';
const OTHER_USER_ID = '987654321098765432';
const GREASE_EXTENSION = 0x0a0a;

describe('DAVE v1 MLS profile', () => {
	test('creates fresh join KeyPackages over one persistent session leaf', () => {
		const provider = new VoiceCryptoProvider();
		const identity = new DaveIdentity(provider);
		const leaf = createDaveLeafMaterial(provider, identity, USER_ID);
		const first = createDaveJoinKeyPackage(provider, identity, leaf);
		const second = createDaveJoinKeyPackage(provider, identity, leaf);
		try {
			expect(first.keyPackage.leafNode).toEqual(leaf.leafNode);
			expect(second.keyPackage.leafNode).toEqual(leaf.leafNode);
			expect(second.keyPackage.initKey).not.toEqual(first.keyPackage.initKey);
			expect(second.reference).not.toEqual(first.reference);
		} finally {
			first.close();
			second.close();
		}
		expect(leaf.encryptionSecretKey).toHaveLength(32);
		leaf.close();
		identity.close();
	});

	test('creates fresh signed KeyPackages and their wire messages and references', () => {
		const provider = new VoiceCryptoProvider();
		const identity = new DaveIdentity(provider);
		const first = createDaveKeyPackage(provider, identity, USER_ID);
		const second = createDaveKeyPackage(provider, identity, USER_ID);
		try {
			const { keyPackage, message } = first;
			expect(keyPackage.version).toBe(ProtocolVersion.Mls10);
			expect(keyPackage.cipherSuite).toBe(CipherSuite.Dave);
			expect(message).toEqual({
				version: ProtocolVersion.Mls10,
				wireFormat: WireFormat.KeyPackage,
				keyPackage,
			});
			expect(decodeMlsMessage(first.encodedMessage)).toEqual(message);
			expect(first.reference).toEqual(refHash(provider, 'MLS 1.0 KeyPackage Reference', encodeKeyPackage(keyPackage)));
			expect(first.reference).toHaveLength(32);
			expect(first.reference).not.toEqual(second.reference);
			expect(keyPackage.initKey).not.toEqual(keyPackage.leafNode.encryptionKey);
			expect(keyPackage.extensions).toEqual([]);

			const leafNode = keyPackage.leafNode;
			expect(leafNode.credential).toEqual({
				type: CredentialType.Basic,
				identity: encodeSnowflakeBigEndian(USER_ID),
			});
			expect(leafNode.capabilities).toEqual({
				versions: [ProtocolVersion.Mls10],
				cipherSuites: [CipherSuite.Dave],
				extensions: [],
				proposals: [],
				credentials: [CredentialType.Basic],
			});
			expect(leafNode.source).toEqual({
				type: LeafNodeSource.KeyPackage,
				lifetime: { notBefore: 0n, notAfter: 0xffff_ffff_ffff_ffffn },
			});
			expect(leafNode.extensions).toEqual([]);
			provider.validateP256PublicKey(keyPackage.initKey);
			provider.validateP256PublicKey(leafNode.encryptionKey);
			provider.validateP256PublicKey(leafNode.signatureKey);
			expect(
				verifyWithLabel(
					provider,
					leafNode.signatureKey,
					'LeafNodeTBS',
					encodeLeafNodeTbs(leafNode),
					leafNode.signature,
				),
			).toBe(true);
			expect(
				verifyWithLabel(
					provider,
					leafNode.signatureKey,
					'KeyPackageTBS',
					encodeKeyPackageTbs(keyPackage),
					keyPackage.signature,
				),
			).toBe(true);
			expect(() => validateDaveKeyPackage(provider, keyPackage, USER_ID)).not.toThrow();
		} finally {
			first.close();
			second.close();
			identity.close();
		}
	});

	test('returns defensive secret copies and erases owned secrets on close', () => {
		const provider = new TrackingCryptoProvider();
		const identity = new DaveIdentity(provider);
		const material = createDaveKeyPackage(provider, identity, USER_ID);
		const publicKeyPackage = material.keyPackage;
		const publicMessage = material.encodedMessage;
		const leafOwnedSecret = provider.generatedSecrets[1] as Uint8Array;
		const initOwnedSecret = provider.generatedSecrets[2] as Uint8Array;
		const firstInitCopy = material.initSecretKey;
		const firstLeafCopy = material.leafEncryptionSecretKey;

		expect(material.initSecretKey).not.toBe(firstInitCopy);
		expect(material.initSecretKey).toEqual(firstInitCopy);
		expect(material.leafEncryptionSecretKey).not.toBe(firstLeafCopy);
		expect(material.leafEncryptionSecretKey).toEqual(firstLeafCopy);
		firstInitCopy.fill(0);
		firstLeafCopy.fill(0);
		expect(isAllZero(material.initSecretKey)).toBe(false);
		expect(isAllZero(material.leafEncryptionSecretKey)).toBe(false);

		material.close();
		material.close();
		expect(isAllZero(initOwnedSecret)).toBe(true);
		expect(isAllZero(leafOwnedSecret)).toBe(true);
		expect(() => material.initSecretKey).toThrow('closed');
		expect(() => material.leafEncryptionSecretKey).toThrow('closed');
		expect(material.keyPackage).toBe(publicKeyPackage);
		expect(material.encodedMessage).toBe(publicMessage);

		identity.close();
		expect(isAllZero(provider.generatedSecrets[0] as Uint8Array)).toBe(true);
	});

	test('builds on an existing leaf without replacing or duplicating its owned HPKE secret', () => {
		const provider = new TrackingCryptoProvider();
		const identity = new DaveIdentity(provider);
		const leafMaterial = createDaveLeafMaterial(provider, identity, USER_ID);
		const leafNode = leafMaterial.leafNode;
		const leafOwnedSecret = provider.generatedSecrets[1] as Uint8Array;
		const expectedSecret = leafMaterial.encryptionSecretKey;
		const material = createDaveKeyPackageFromLeaf(provider, identity, leafMaterial);
		try {
			expect(provider.generatedSecrets).toHaveLength(3);
			expect(material.keyPackage.leafNode).toBe(leafNode);
			expect(material.leafEncryptionSecretKey).toEqual(expectedSecret);
			expect(leafMaterial.encryptionSecretKey).toEqual(expectedSecret);
		} finally {
			expectedSecret.fill(0);
			material.close();
			identity.close();
		}
		expect(isAllZero(leafOwnedSecret)).toBe(true);
		expect(() => leafMaterial.encryptionSecretKey).toThrow('closed');
	});

	test('closes a transferred leaf when its identity cannot sign the KeyPackage', () => {
		const provider = new TrackingCryptoProvider();
		const leafIdentity = new DaveIdentity(provider);
		const leafMaterial = createDaveLeafMaterial(provider, leafIdentity, USER_ID);
		const otherIdentity = new DaveIdentity(provider);
		const leafOwnedSecret = provider.generatedSecrets[1] as Uint8Array;
		try {
			expect(() => createDaveKeyPackageFromLeaf(provider, otherIdentity, leafMaterial)).toThrow(
				'must own the leaf node signature key',
			);
			expect(isAllZero(leafOwnedSecret)).toBe(true);
			expect(() => leafMaterial.encryptionSecretKey).toThrow('closed');
			expect(provider.generatedSecrets).toHaveLength(3);
		} finally {
			leafIdentity.close();
			otherIdentity.close();
		}
	});

	test('erases leaf material when init-key generation fails', () => {
		const provider = new FailingInitCryptoProvider();
		const identity = new DaveIdentity(provider);
		try {
			expect(() => createDaveKeyPackage(provider, identity, USER_ID)).toThrow('injected init-key failure');
			expect(isAllZero(provider.generatedSecrets[1] as Uint8Array)).toBe(true);
		} finally {
			identity.close();
		}
	});

	test('rejects semantically invalid DAVE leaves even when they are freshly signed', () => {
		const provider = new VoiceCryptoProvider();
		const identity = new DaveIdentity(provider);
		const material = createDaveLeafMaterial(provider, identity, USER_ID);
		try {
			const leafNode = material.leafNode;
			expect(() => validateDaveLeafNode(provider, leafNode)).not.toThrow();
			expect(() => validateDaveLeafNode(provider, leafNode, OTHER_USER_ID)).toThrow('expected Discord user');

			const zeroIdentity = resignLeaf(identity, leafNode, {
				credential: { type: CredentialType.Basic, identity: new Uint8Array(8) },
			});
			expect(() => validateDaveLeafNode(provider, zeroIdentity)).toThrow('zero snowflake');
			const shortIdentity = resignLeaf(identity, leafNode, {
				credential: { type: CredentialType.Basic, identity: new Uint8Array(7) },
			});
			expect(() => validateDaveLeafNode(provider, shortIdentity)).toThrow('8-byte');
			const unsupportedCredential = {
				...leafNode,
				credential: { type: 2, identity: leafNode.credential.identity },
			} as unknown as MlsLeafNode;
			expect(() => validateDaveLeafNode(provider, unsupportedCredential)).toThrow('Basic credential');

			for (const [name, capabilities] of invalidCapabilities(leafNode.capabilities)) {
				const mutated = resignLeaf(identity, leafNode, { capabilities });
				expect(() => validateDaveLeafNode(provider, mutated), name).toThrow();
			}

			const forwardCompatibleCapabilities = resignLeaf(identity, leafNode, {
				capabilities: {
					versions: [ProtocolVersion.Mls10, 0xaaaa],
					cipherSuites: [CipherSuite.Dave, 0xaaaa],
					extensions: [GREASE_EXTENSION],
					proposals: [0x1a1a],
					credentials: [CredentialType.Basic, 0xaaaa],
				},
			});
			expect(() => validateDaveLeafNode(provider, forwardCompatibleCapabilities)).not.toThrow();

			const invalidLifetime = resignLeaf(identity, leafNode, {
				source: {
					type: LeafNodeSource.KeyPackage,
					lifetime: { notBefore: 1n, notAfter: 0xffff_ffff_ffff_ffffn },
				},
			});
			expect(() => validateDaveLeafNode(provider, invalidLifetime)).toThrow('lifetime');
			const invalidSource = {
				...leafNode,
				source: { type: LeafNodeSource.Update },
			} as MlsLeafNode;
			expect(() => validateDaveLeafNode(provider, invalidSource)).toThrow('key_package source');

			const leafExtension = resignLeaf(identity, leafNode, {
				capabilities: { ...leafNode.capabilities, extensions: [GREASE_EXTENSION] },
				extensions: [{ type: GREASE_EXTENSION, data: Uint8Array.of(1) }],
			});
			expect(() => validateDaveLeafNode(provider, leafExtension)).toThrow('cannot contain extensions');

			const invalidEncryptionKey = { ...leafNode, encryptionKey: new Uint8Array(65) };
			expect(() => validateDaveLeafNode(provider, invalidEncryptionKey)).toThrow('P-256');
			const invalidSignatureKey = { ...leafNode, signatureKey: new Uint8Array(65) };
			expect(() => validateDaveLeafNode(provider, invalidSignatureKey)).toThrow('P-256');
			const invalidSignature = { ...leafNode, signature: flipFirstByte(leafNode.signature) };
			expect(() => validateDaveLeafNode(provider, invalidSignature)).toThrow('signature is invalid');
		} finally {
			material.close();
			identity.close();
		}
	});

	test('validates KeyPackage extension compatibility, key separation, and both signatures', () => {
		const provider = new VoiceCryptoProvider();
		const identity = new DaveIdentity(provider);
		const material = createDaveKeyPackage(provider, identity, USER_ID);
		try {
			const keyPackage = material.keyPackage;
			const extension = { type: GREASE_EXTENSION, data: Uint8Array.of(1, 2, 3) };
			const capableLeaf = resignLeaf(identity, keyPackage.leafNode, {
				capabilities: { ...keyPackage.leafNode.capabilities, extensions: [GREASE_EXTENSION] },
			});
			const compatible = resignKeyPackage(identity, keyPackage, {
				leafNode: capableLeaf,
				extensions: [extension],
			});
			expect(() => validateDaveKeyPackage(provider, compatible, USER_ID)).not.toThrow();

			const unadvertised = resignKeyPackage(identity, keyPackage, { extensions: [extension] });
			expect(() => validateDaveKeyPackage(provider, unadvertised)).toThrow('not advertised');
			const duplicate = resignKeyPackage(identity, keyPackage, {
				leafNode: capableLeaf,
				extensions: [extension, { ...extension, data: Uint8Array.of(4) }],
			});
			expect(() => validateDaveKeyPackage(provider, duplicate)).toThrow('duplicate');
			const misplacedKnownExtension = resignKeyPackage(identity, keyPackage, {
				extensions: [{ type: ExtensionType.RatchetTree, data: EMPTY_BYTES }],
			});
			expect(() => validateDaveKeyPackage(provider, misplacedKnownExtension)).toThrow('not valid in a KeyPackage');

			const reusedLeafKey = resignKeyPackage(identity, keyPackage, {
				initKey: keyPackage.leafNode.encryptionKey,
			});
			expect(() => validateDaveKeyPackage(provider, reusedLeafKey)).toThrow('must be distinct');
			const invalidInitKey = { ...keyPackage, initKey: new Uint8Array(65) };
			expect(() => validateDaveKeyPackage(provider, invalidInitKey)).toThrow('P-256');
			const invalidKeyPackageSignature = {
				...keyPackage,
				signature: flipFirstByte(keyPackage.signature),
			};
			expect(() => validateDaveKeyPackage(provider, invalidKeyPackageSignature)).toThrow('signature is invalid');

			const invalidLeafSignature = {
				...keyPackage,
				leafNode: { ...keyPackage.leafNode, signature: flipFirstByte(keyPackage.leafNode.signature) },
			};
			expect(() => validateDaveKeyPackage(provider, invalidLeafSignature)).toThrow('leaf node signature');
			const invalidVersion = { ...keyPackage, version: 2 } as unknown as MlsKeyPackage;
			expect(() => validateDaveKeyPackage(provider, invalidVersion)).toThrow('MLS 1.0');
			const invalidSuite = { ...keyPackage, cipherSuite: 1 } as unknown as MlsKeyPackage;
			expect(() => validateDaveKeyPackage(provider, invalidSuite)).toThrow('ciphersuite 2');
		} finally {
			material.close();
			identity.close();
		}
	});
});

class TrackingCryptoProvider extends VoiceCryptoProvider {
	readonly generatedSecrets: Uint8Array[] = [];

	override generateP256KeyPair(): P256KeyPair {
		const keyPair = super.generateP256KeyPair();
		this.generatedSecrets.push(keyPair.secretKey);
		return keyPair;
	}
}

class FailingInitCryptoProvider extends TrackingCryptoProvider {
	#calls = 0;

	override generateP256KeyPair(): P256KeyPair {
		this.#calls++;
		if (this.#calls === 3) throw new Error('injected init-key failure');
		return super.generateP256KeyPair();
	}
}

function resignLeaf(identity: DaveIdentity, leafNode: MlsLeafNode, changes: Partial<MlsLeafNode>): MlsLeafNode {
	const unsigned = { ...leafNode, ...changes, signature: EMPTY_BYTES };
	return { ...unsigned, signature: identity.sign('LeafNodeTBS', encodeLeafNodeTbs(unsigned)) };
}

function resignKeyPackage(
	identity: DaveIdentity,
	keyPackage: MlsKeyPackage,
	changes: Partial<MlsKeyPackage>,
): MlsKeyPackage {
	const unsigned = { ...keyPackage, ...changes, signature: EMPTY_BYTES };
	return { ...unsigned, signature: identity.sign('KeyPackageTBS', encodeKeyPackageTbs(unsigned)) };
}

function invalidCapabilities(capabilities: MlsCapabilities): readonly (readonly [string, MlsCapabilities])[] {
	return [
		['missing MLS 1.0', { ...capabilities, versions: [] }],
		['missing ciphersuite 2', { ...capabilities, cipherSuites: [] }],
		['missing Basic', { ...capabilities, credentials: [] }],
		['reserved version', { ...capabilities, versions: [0, ProtocolVersion.Mls10] }],
		['default extension', { ...capabilities, extensions: [ExtensionType.RatchetTree] }],
		['default proposal', { ...capabilities, proposals: [ProposalType.Add] }],
	];
}

function flipFirstByte(value: Uint8Array): Uint8Array {
	const output = value.slice();
	output[0] = (output[0] as number) ^ 1;
	return output;
}

function isAllZero(value: Uint8Array): boolean {
	return value.every(byte => byte === 0);
}

const EMPTY_BYTES = new Uint8Array();
