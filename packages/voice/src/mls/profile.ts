import { equalBytes } from '../bytes';
import { assertP256KeyPair, type P256KeyPair, type VoiceCryptoProvider } from '../crypto/provider';
import type { DaveIdentity } from '../dave/identity';
import { encodeSnowflakeBigEndian } from '../dave/verification';
import { refHash, verifyWithLabel } from './crypto';
import {
	assertUniqueMlsExtensions,
	CipherSuite,
	CredentialType,
	encodeKeyPackage,
	encodeKeyPackageTbs,
	encodeLeafNodeTbs,
	encodeMlsMessage,
	LeafNodeSource,
	type MlsCapabilities,
	type MlsKeyPackage,
	type MlsLeafNode,
	type MlsMessage,
	ProtocolVersion,
	WireFormat,
} from './protocol';

const EMPTY = new Uint8Array();
const MAXIMUM_UINT64 = 0xffff_ffff_ffff_ffffn;
const MLS_DEFAULT_EXTENSION_TYPES = new Set([1, 2, 3, 4, 5]);
const MLS_DEFAULT_PROPOSAL_TYPES = new Set([1, 2, 3, 4, 5, 6, 7]);

export interface DaveLeafMaterial {
	readonly leafNode: MlsLeafNode;
	readonly encryptionSecretKey: Uint8Array;
	close(): void;
}

export type DaveKeyPackageMessage = Extract<MlsMessage, { readonly wireFormat: typeof WireFormat.KeyPackage }>;

export interface DaveKeyPackageMaterial {
	readonly keyPackage: MlsKeyPackage;
	readonly message: DaveKeyPackageMessage;
	readonly encodedMessage: Uint8Array;
	readonly reference: Uint8Array;
	readonly initSecretKey: Uint8Array;
	readonly leafEncryptionSecretKey: Uint8Array;
	close(): void;
}

export function createDaveLeafMaterial(
	provider: VoiceCryptoProvider,
	identity: DaveIdentity,
	userId: string,
): DaveLeafMaterial {
	const keyPair = provider.generateP256KeyPair();
	try {
		assertP256KeyPair(provider, keyPair, 'DAVE leaf encryption key pair does not match.');
		const unsignedLeafNode: MlsLeafNode = {
			encryptionKey: keyPair.publicKey,
			signatureKey: identity.publicKey,
			credential: { type: CredentialType.Basic, identity: encodeSnowflakeBigEndian(userId) },
			capabilities: {
				versions: [ProtocolVersion.Mls10],
				cipherSuites: [CipherSuite.Dave],
				extensions: [],
				proposals: [],
				credentials: [CredentialType.Basic],
			},
			source: {
				type: LeafNodeSource.KeyPackage,
				lifetime: { notBefore: 0n, notAfter: MAXIMUM_UINT64 },
			},
			extensions: [],
			signature: EMPTY,
		};
		const leafNode: MlsLeafNode = {
			...unsignedLeafNode,
			signature: identity.sign('LeafNodeTBS', encodeLeafNodeTbs(unsignedLeafNode)),
		};
		validateDaveLeafNode(provider, leafNode, userId);
		return new DaveLeafMaterialResource(leafNode, keyPair.secretKey);
	} catch (error) {
		keyPair.secretKey.fill(0);
		throw error;
	}
}

export function createDaveKeyPackage(
	provider: VoiceCryptoProvider,
	identity: DaveIdentity,
	userId: string,
): DaveKeyPackageMaterial {
	return createDaveKeyPackageFromLeaf(provider, identity, createDaveLeafMaterial(provider, identity, userId));
}

/**
 * Creates a fresh one-use join KeyPackage while leaving ownership of the persistent session leaf with the caller.
 */
export function createDaveJoinKeyPackage(
	provider: VoiceCryptoProvider,
	identity: DaveIdentity,
	leafMaterial: DaveLeafMaterial,
): DaveKeyPackageMaterial {
	return createDaveKeyPackageMaterial(provider, identity, leafMaterial, false);
}

/**
 * Transfers ownership of `leafMaterial` to the returned KeyPackage material, or closes it if construction fails.
 */
export function createDaveKeyPackageFromLeaf(
	provider: VoiceCryptoProvider,
	identity: DaveIdentity,
	leafMaterial: DaveLeafMaterial,
): DaveKeyPackageMaterial {
	return createDaveKeyPackageMaterial(provider, identity, leafMaterial, true);
}

function createDaveKeyPackageMaterial(
	provider: VoiceCryptoProvider,
	identity: DaveIdentity,
	leafMaterial: DaveLeafMaterial,
	takeLeafOwnership: boolean,
): DaveKeyPackageMaterial {
	let initKeyPair: P256KeyPair | undefined;
	try {
		validateDaveLeafNode(provider, leafMaterial.leafNode);
		if (!equalBytes(identity.publicKey, leafMaterial.leafNode.signatureKey)) {
			throw new TypeError('The DAVE identity must own the leaf node signature key.');
		}
		const leafSecretKey = leafMaterial.encryptionSecretKey;
		try {
			assertP256KeyPair(
				provider,
				{ secretKey: leafSecretKey, publicKey: leafMaterial.leafNode.encryptionKey },
				'DAVE leaf encryption key pair does not match.',
			);
		} finally {
			leafSecretKey.fill(0);
		}
		initKeyPair = provider.generateP256KeyPair();
		assertP256KeyPair(provider, initKeyPair, 'DAVE KeyPackage init key pair does not match.');
		if (equalBytes(initKeyPair.publicKey, leafMaterial.leafNode.encryptionKey)) {
			throw new Error('DAVE KeyPackage init and leaf encryption keys must be distinct.');
		}
		const unsignedKeyPackage: MlsKeyPackage = {
			version: ProtocolVersion.Mls10,
			cipherSuite: CipherSuite.Dave,
			initKey: initKeyPair.publicKey,
			leafNode: leafMaterial.leafNode,
			extensions: [],
			signature: EMPTY,
		};
		const keyPackage: MlsKeyPackage = {
			...unsignedKeyPackage,
			signature: identity.sign('KeyPackageTBS', encodeKeyPackageTbs(unsignedKeyPackage)),
		};
		validateDaveKeyPackage(provider, keyPackage);
		const message: DaveKeyPackageMessage = {
			version: ProtocolVersion.Mls10,
			wireFormat: WireFormat.KeyPackage,
			keyPackage,
		};
		return new DaveKeyPackageMaterialResource(
			keyPackage,
			message,
			encodeMlsMessage(message),
			refHash(provider, 'MLS 1.0 KeyPackage Reference', encodeKeyPackage(keyPackage)),
			initKeyPair.secretKey,
			leafMaterial,
			takeLeafOwnership,
		);
	} catch (error) {
		initKeyPair?.secretKey.fill(0);
		if (takeLeafOwnership) leafMaterial.close();
		throw error;
	}
}

export function validateDaveLeafNode(
	provider: VoiceCryptoProvider,
	leafNode: MlsLeafNode,
	expectedUserId?: string,
): void {
	provider.validateP256PublicKey(leafNode.encryptionKey);
	provider.validateP256PublicKey(leafNode.signatureKey);
	if (leafNode.credential.type !== CredentialType.Basic) {
		throw new TypeError('DAVE leaf nodes must use a Basic credential.');
	}
	assertDaveCredentialIdentity(leafNode.credential.identity, expectedUserId);
	assertDaveCapabilities(leafNode.capabilities);
	if (leafNode.source.type !== LeafNodeSource.KeyPackage) {
		throw new TypeError('DAVE KeyPackage leaf nodes must use the key_package source.');
	}
	if (leafNode.source.lifetime.notBefore !== 0n || leafNode.source.lifetime.notAfter !== MAXIMUM_UINT64) {
		throw new TypeError('DAVE KeyPackage leaf lifetime must span 0 through 2^64 - 1.');
	}
	if (leafNode.extensions.length !== 0) throw new TypeError('DAVE v1 leaf nodes cannot contain extensions.');
	if (
		!verifyWithLabel(provider, leafNode.signatureKey, 'LeafNodeTBS', encodeLeafNodeTbs(leafNode), leafNode.signature)
	) {
		throw new TypeError('DAVE leaf node signature is invalid.');
	}
}

export function validateDaveKeyPackage(
	provider: VoiceCryptoProvider,
	keyPackage: MlsKeyPackage,
	expectedUserId?: string,
): void {
	if (keyPackage.version !== ProtocolVersion.Mls10) {
		throw new TypeError('DAVE v1 KeyPackages must use MLS 1.0.');
	}
	if (keyPackage.cipherSuite !== CipherSuite.Dave) {
		throw new TypeError('DAVE v1 KeyPackages must use MLS ciphersuite 2.');
	}
	provider.validateP256PublicKey(keyPackage.initKey);
	validateDaveLeafNode(provider, keyPackage.leafNode, expectedUserId);
	assertUniqueMlsExtensions(keyPackage.extensions);
	assertKeyPackageExtensionCapabilities(keyPackage);
	if (equalBytes(keyPackage.initKey, keyPackage.leafNode.encryptionKey)) {
		throw new TypeError('DAVE KeyPackage init and leaf encryption keys must be distinct.');
	}
	if (
		!verifyWithLabel(
			provider,
			keyPackage.leafNode.signatureKey,
			'KeyPackageTBS',
			encodeKeyPackageTbs(keyPackage),
			keyPackage.signature,
		)
	) {
		throw new TypeError('DAVE KeyPackage signature is invalid.');
	}
}

class DaveLeafMaterialResource implements DaveLeafMaterial {
	readonly leafNode: MlsLeafNode;
	readonly #secretKey: Uint8Array;
	#closed = false;

	constructor(leafNode: MlsLeafNode, secretKey: Uint8Array) {
		this.leafNode = leafNode;
		this.#secretKey = secretKey;
	}

	get encryptionSecretKey(): Uint8Array {
		this.assertOpen();
		return this.#secretKey.slice();
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#secretKey.fill(0);
	}

	private assertOpen(): void {
		if (!this.#closed) return;
		throw new Error('The DAVE leaf material is closed.');
	}
}

class DaveKeyPackageMaterialResource implements DaveKeyPackageMaterial {
	readonly keyPackage: MlsKeyPackage;
	readonly message: DaveKeyPackageMessage;
	readonly encodedMessage: Uint8Array;
	readonly reference: Uint8Array;
	readonly #initSecretKey: Uint8Array;
	readonly #leafMaterial: DaveLeafMaterial;
	readonly #ownsLeafMaterial: boolean;
	#closed = false;

	constructor(
		keyPackage: MlsKeyPackage,
		message: DaveKeyPackageMessage,
		encodedMessage: Uint8Array,
		reference: Uint8Array,
		initSecretKey: Uint8Array,
		leafMaterial: DaveLeafMaterial,
		ownsLeafMaterial: boolean,
	) {
		this.keyPackage = keyPackage;
		this.message = message;
		this.encodedMessage = encodedMessage;
		this.reference = reference;
		this.#initSecretKey = initSecretKey;
		this.#leafMaterial = leafMaterial;
		this.#ownsLeafMaterial = ownsLeafMaterial;
	}

	get initSecretKey(): Uint8Array {
		this.assertOpen();
		return this.#initSecretKey.slice();
	}

	get leafEncryptionSecretKey(): Uint8Array {
		this.assertOpen();
		return this.#leafMaterial.encryptionSecretKey;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#initSecretKey.fill(0);
		if (this.#ownsLeafMaterial) this.#leafMaterial.close();
	}

	private assertOpen(): void {
		if (!this.#closed) return;
		throw new Error('The DAVE KeyPackage material is closed.');
	}
}

function assertDaveCredentialIdentity(identity: Uint8Array, expectedUserId: string | undefined): void {
	if (identity.byteLength !== 8) {
		throw new TypeError('A DAVE Basic credential identity must be an 8-byte big-endian Discord snowflake.');
	}
	const userId = new DataView(identity.buffer, identity.byteOffset, identity.byteLength).getBigUint64(0);
	if (userId === 0n) throw new TypeError('A DAVE Basic credential identity cannot be the zero snowflake.');
	if (expectedUserId === undefined || equalBytes(identity, encodeSnowflakeBigEndian(expectedUserId))) return;
	throw new TypeError('DAVE Basic credential identity does not match the expected Discord user.');
}

function assertDaveCapabilities(capabilities: MlsCapabilities): void {
	assertCapability(capabilities.versions, ProtocolVersion.Mls10, 'MLS 1.0');
	assertCapability(capabilities.cipherSuites, CipherSuite.Dave, 'MLS ciphersuite 2');
	assertCapability(capabilities.credentials, CredentialType.Basic, 'Basic credentials');
	assertNoReservedCapability(capabilities.versions, 'protocol versions');
	assertNoReservedCapability(capabilities.cipherSuites, 'ciphersuites');
	assertNoReservedCapability(capabilities.extensions, 'extensions');
	assertNoReservedCapability(capabilities.proposals, 'proposals');
	assertNoReservedCapability(capabilities.credentials, 'credentials');
	assertNoDefaultCapabilities(capabilities.extensions, MLS_DEFAULT_EXTENSION_TYPES, 'extensions');
	assertNoDefaultCapabilities(capabilities.proposals, MLS_DEFAULT_PROPOSAL_TYPES, 'proposals');
}

function assertCapability(values: readonly number[], expected: number, name: string): void {
	if (values.includes(expected)) return;
	throw new TypeError(`DAVE leaf capabilities must advertise ${name}.`);
}

function assertNoReservedCapability(values: readonly number[], name: string): void {
	if (!values.includes(0)) return;
	throw new TypeError(`DAVE leaf capabilities cannot advertise reserved ${name}.`);
}

function assertNoDefaultCapabilities(values: readonly number[], defaults: ReadonlySet<number>, name: string): void {
	if (!values.some(value => defaults.has(value))) return;
	throw new TypeError(`MLS default ${name} must not be advertised in leaf capabilities.`);
}

function assertKeyPackageExtensionCapabilities(keyPackage: MlsKeyPackage): void {
	for (const extension of keyPackage.extensions) {
		if (MLS_DEFAULT_EXTENSION_TYPES.has(extension.type)) {
			throw new TypeError(`MLS extension ${extension.type} is not valid in a KeyPackage.`);
		}
		if (keyPackage.leafNode.capabilities.extensions.includes(extension.type)) continue;
		throw new TypeError(`MLS KeyPackage extension ${extension.type} is not advertised by the leaf capabilities.`);
	}
}
