import { equalBytes, zeroByteRecord } from '../bytes';
import type { VoiceCryptoProvider } from '../crypto/provider';
import { verifyWithLabel } from './crypto';
import { deriveInitialEpochSecrets, type MlsEpochSecrets } from './key-schedule';
import { type DaveLeafMaterial, validateDaveLeafNode } from './profile';
import {
	CipherSuite,
	CredentialType,
	decodeExternalSenders,
	ExtensionType,
	encodeExternalSenders,
	encodeLeafNodeTbs,
	LeafNodeSource,
	type MlsExtension,
	type MlsExternalSender,
	type MlsGroupContext,
	type MlsLeafNode,
	NodeType,
	ProtocolVersion,
} from './protocol';
import { computeConfirmationTag, updateInterimTranscriptHash, verifyConfirmationTag } from './transcript';
import {
	assertRatchetTree,
	leafIndex,
	leafNodeIndex,
	type MlsRatchetTree,
	treeHash,
	validateParentHashes,
} from './tree';

const EMPTY = new Uint8Array();

export type DaveMlsEpochSecrets = Omit<MlsEpochSecrets, 'joinerSecret' | 'welcomeSecret'>;

export interface DaveMlsRosterEntry {
	readonly leafIndex: number;
	readonly userId: string;
	readonly signatureKey: Uint8Array;
	readonly encryptionKey: Uint8Array;
}

export interface CreateDaveMlsGroupStateInput {
	readonly tree: MlsRatchetTree;
	readonly selfLeafIndex: number;
	readonly privateKeys: ReadonlyMap<number, Uint8Array>;
	readonly context: MlsGroupContext;
	readonly interimTranscriptHash: Uint8Array;
	readonly confirmationTag: Uint8Array;
	readonly secrets: DaveMlsEpochSecrets;
}

export class DaveMlsGroupState {
	readonly tree: MlsRatchetTree;
	readonly selfLeafIndex: number;
	readonly context: MlsGroupContext;
	readonly interimTranscriptHash: Uint8Array;
	readonly confirmationTag: Uint8Array;
	readonly secrets: DaveMlsEpochSecrets;
	readonly roster: ReadonlyMap<string, DaveMlsRosterEntry>;
	readonly #privateKeys: Map<number, Uint8Array>;
	#closed = false;

	private constructor(input: CreateDaveMlsGroupStateInput, roster: ReadonlyMap<string, DaveMlsRosterEntry>) {
		this.tree = input.tree;
		this.selfLeafIndex = input.selfLeafIndex;
		this.context = input.context;
		this.interimTranscriptHash = input.interimTranscriptHash.slice();
		this.confirmationTag = input.confirmationTag.slice();
		this.secrets = copyEpochSecrets(input.secrets);
		this.roster = roster;
		this.#privateKeys = new Map(
			[...input.privateKeys].map(([nodeIndex, privateKey]) => [nodeIndex, privateKey.slice()] as const),
		);
	}

	getPrivateKey(nodeIndex: number): Uint8Array | undefined {
		this.assertOpen();
		return this.#privateKeys.get(nodeIndex)?.slice();
	}

	/** @internal */
	getPrivateKeyEntries(): readonly (readonly [number, Uint8Array])[] {
		this.assertOpen();
		return [...this.#privateKeys].map(([nodeIndex, privateKey]) => [nodeIndex, privateKey.slice()] as const);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const privateKey of this.#privateKeys.values()) privateKey.fill(0);
		this.#privateKeys.clear();
		zeroByteRecord(this.secrets);
		this.interimTranscriptHash.fill(0);
		this.confirmationTag.fill(0);
	}

	private assertOpen(): void {
		if (!this.#closed) return;
		throw new Error('The DAVE MLS group state is closed.');
	}

	static create(provider: VoiceCryptoProvider, input: CreateDaveMlsGroupStateInput): DaveMlsGroupState {
		validateGroupState(provider, input);
		return new DaveMlsGroupState(input, readDaveMlsRoster(provider, input.tree, input.context.groupId));
	}
}

export function createInitialDaveMlsGroupState(
	provider: VoiceCryptoProvider,
	leafMaterial: DaveLeafMaterial,
	groupId: Uint8Array,
	externalSender: MlsExternalSender,
): DaveMlsGroupState {
	validateDaveExternalSender(provider, externalSender);
	validateDaveLeafNode(provider, leafMaterial.leafNode);
	const leafPrivateKey = leafMaterial.encryptionSecretKey;
	const epochSecret = provider.randomBytes(32);
	let secrets: DaveMlsEpochSecrets | undefined;
	try {
		const tree: MlsRatchetTree = Object.freeze([
			Object.freeze({ type: NodeType.Leaf, leafNode: leafMaterial.leafNode }),
		]);
		const confirmedTranscriptHash = EMPTY;
		const context: MlsGroupContext = Object.freeze({
			version: ProtocolVersion.Mls10,
			cipherSuite: CipherSuite.Dave,
			groupId: groupId.slice(),
			epoch: 0n,
			treeHash: treeHash(provider, tree),
			confirmedTranscriptHash,
			extensions: [createExternalSendersExtension(externalSender)],
		});
		secrets = deriveInitialEpochSecrets(provider, epochSecret);
		const confirmationTag = computeConfirmationTag(provider, secrets.confirmationKey, confirmedTranscriptHash);
		return DaveMlsGroupState.create(provider, {
			tree,
			selfLeafIndex: 0,
			privateKeys: new Map([[0, leafPrivateKey]]),
			context,
			interimTranscriptHash: updateInterimTranscriptHash(provider, confirmedTranscriptHash, confirmationTag),
			confirmationTag,
			secrets,
		});
	} finally {
		leafPrivateKey.fill(0);
		epochSecret.fill(0);
		if (secrets !== undefined) zeroByteRecord(secrets);
	}
}

export function createExternalSendersExtension(externalSender: MlsExternalSender): MlsExtension {
	return Object.freeze({
		type: ExtensionType.ExternalSenders,
		data: encodeExternalSenders([externalSender]),
	});
}

export function assertDaveGroupContext(
	provider: VoiceCryptoProvider,
	context: MlsGroupContext,
	tree: MlsRatchetTree,
	expectedExternalSender: MlsExternalSender,
): void {
	if (context.version !== ProtocolVersion.Mls10 || context.cipherSuite !== CipherSuite.Dave) {
		throw new TypeError('A DAVE group must use MLS 1.0 and ciphersuite 2.');
	}
	if (context.groupId.byteLength === 0) throw new TypeError('A DAVE MLS group ID cannot be empty.');
	if (!equalBytes(context.treeHash, treeHash(provider, tree))) {
		throw new TypeError('The DAVE MLS GroupContext tree hash does not match the ratchet tree.');
	}
	if (context.confirmedTranscriptHash.byteLength !== 0 && context.confirmedTranscriptHash.byteLength !== 32) {
		throw new TypeError('A DAVE MLS confirmed transcript hash must be empty for epoch zero or contain 32 bytes.');
	}
	if (context.epoch !== 0n && context.confirmedTranscriptHash.byteLength !== 32) {
		throw new TypeError('A nonzero DAVE MLS epoch requires a confirmed transcript hash.');
	}
	if (context.extensions.length !== 1 || context.extensions[0]?.type !== ExtensionType.ExternalSenders) {
		throw new TypeError('A DAVE group must contain exactly one external_senders extension.');
	}
	const senders = decodeExternalSenders(context.extensions[0].data);
	if (senders.length !== 1 || !equalDaveExternalSenders(senders[0] as MlsExternalSender, expectedExternalSender)) {
		throw new TypeError('The DAVE group external sender does not match the Voice Gateway sender.');
	}
}

export function readDaveExternalSender(provider: VoiceCryptoProvider, context: MlsGroupContext): MlsExternalSender {
	if (context.extensions.length !== 1 || context.extensions[0]?.type !== ExtensionType.ExternalSenders) {
		throw new TypeError('A DAVE group must contain exactly one external_senders extension.');
	}
	const senders = decodeExternalSenders(context.extensions[0].data);
	if (senders.length !== 1) throw new TypeError('A DAVE group must contain exactly one external sender.');
	const sender = senders[0] as MlsExternalSender;
	validateDaveExternalSender(provider, sender);
	return sender;
}

export function readDaveMlsRoster(
	provider: VoiceCryptoProvider,
	tree: MlsRatchetTree,
	groupId: Uint8Array,
): ReadonlyMap<string, DaveMlsRosterEntry> {
	assertRatchetTree(tree);
	const roster = new Map<string, DaveMlsRosterEntry>();
	const treeKeys: Uint8Array[] = [];
	for (let nodeIndex = 0; nodeIndex < tree.length; nodeIndex++) {
		const node = tree[nodeIndex];
		if (node === undefined) continue;
		if (node.type === NodeType.Parent) {
			provider.validateP256PublicKey(node.parentNode.encryptionKey);
			assertUniqueKey(node.parentNode.encryptionKey, treeKeys, 'ratchet tree');
			continue;
		}
		const memberLeafIndex = leafIndex(nodeIndex);
		validateGroupLeafNode(provider, node.leafNode, groupId, memberLeafIndex);
		assertUniqueKey(node.leafNode.signatureKey, treeKeys, 'ratchet tree');
		assertUniqueKey(node.leafNode.encryptionKey, treeKeys, 'ratchet tree');
		const userId = decodeCredentialUserId(node.leafNode.credential.identity);
		if (roster.has(userId)) throw new TypeError('A DAVE MLS roster cannot contain duplicate Discord users.');
		roster.set(
			userId,
			Object.freeze({
				leafIndex: memberLeafIndex,
				userId,
				signatureKey: node.leafNode.signatureKey.slice(),
				encryptionKey: node.leafNode.encryptionKey.slice(),
			}),
		);
	}
	if (roster.size === 0) throw new TypeError('A DAVE MLS group cannot have an empty roster.');
	return roster;
}

export function closePrivateKeyEntries(entries: readonly (readonly [number, Uint8Array])[]): void {
	for (const [, privateKey] of entries) privateKey.fill(0);
}

function validateGroupState(provider: VoiceCryptoProvider, input: CreateDaveMlsGroupStateInput): void {
	assertRatchetTree(input.tree);
	if (input.context.version !== ProtocolVersion.Mls10 || input.context.cipherSuite !== CipherSuite.Dave) {
		throw new TypeError('A DAVE group must use MLS 1.0 and ciphersuite 2.');
	}
	if (input.context.groupId.byteLength === 0) throw new TypeError('A DAVE MLS group ID cannot be empty.');
	if (!equalBytes(input.context.treeHash, treeHash(provider, input.tree))) {
		throw new TypeError('The DAVE MLS GroupContext tree hash does not match the ratchet tree.');
	}
	if (!validateParentHashes(provider, input.tree)) {
		throw new TypeError('The DAVE MLS ratchet tree parent hashes are invalid.');
	}
	readDaveExternalSender(provider, input.context);
	if (!Number.isInteger(input.selfLeafIndex) || input.selfLeafIndex < 0) {
		throw new RangeError('The DAVE MLS self leaf index is invalid.');
	}
	const selfNode = input.tree[leafNodeIndex(input.selfLeafIndex)];
	if (selfNode?.type !== NodeType.Leaf) throw new TypeError('The DAVE MLS self leaf must be non-blank.');
	if (input.interimTranscriptHash.byteLength !== 32) {
		throw new TypeError('The DAVE MLS interim transcript hash must contain 32 bytes.');
	}
	if (input.confirmationTag.byteLength !== 32) {
		throw new TypeError('The DAVE MLS confirmation tag must contain 32 bytes.');
	}
	assertEpochSecrets(input.secrets);
	if (
		!verifyConfirmationTag(
			provider,
			input.secrets.confirmationKey,
			input.context.confirmedTranscriptHash,
			input.confirmationTag,
		)
	) {
		throw new TypeError('The DAVE MLS state confirmation tag is invalid.');
	}
	if (
		!equalBytes(
			input.interimTranscriptHash,
			updateInterimTranscriptHash(provider, input.context.confirmedTranscriptHash, input.confirmationTag),
		)
	) {
		throw new TypeError('The DAVE MLS state interim transcript hash is invalid.');
	}
	const encryptionKeys: Uint8Array[] = [];
	for (const node of input.tree) {
		if (node === undefined) continue;
		const encryptionKey = node.type === NodeType.Leaf ? node.leafNode.encryptionKey : node.parentNode.encryptionKey;
		provider.validateP256PublicKey(encryptionKey);
		assertUniqueKey(encryptionKey, encryptionKeys, 'encryption');
	}
	for (const [nodeIndex, privateKey] of input.privateKeys) {
		const node = input.tree[nodeIndex];
		if (node === undefined) throw new TypeError('DAVE MLS private keys must refer to non-blank tree nodes.');
		const publicKey = node.type === NodeType.Leaf ? node.leafNode.encryptionKey : node.parentNode.encryptionKey;
		if (!equalBytes(provider.getP256PublicKey(privateKey), publicKey)) {
			throw new TypeError('A DAVE MLS private key does not match its ratchet tree node.');
		}
	}
	if (!input.privateKeys.has(leafNodeIndex(input.selfLeafIndex))) {
		throw new TypeError('The DAVE MLS group state must retain its self leaf private key.');
	}
}

function validateGroupLeafNode(
	provider: VoiceCryptoProvider,
	leafNode: MlsLeafNode,
	groupId: Uint8Array,
	memberLeafIndex: number,
): void {
	provider.validateP256PublicKey(leafNode.encryptionKey);
	provider.validateP256PublicKey(leafNode.signatureKey);
	if (leafNode.credential.type !== CredentialType.Basic || leafNode.credential.identity.byteLength !== 8) {
		throw new TypeError('DAVE group leaves must use an 8-byte Basic credential.');
	}
	if (leafNode.extensions.length !== 0) throw new TypeError('DAVE v1 group leaves cannot contain extensions.');
	if (leafNode.source.type === LeafNodeSource.KeyPackage) {
		validateDaveLeafNode(provider, leafNode);
		return;
	}
	if (leafNode.source.type !== LeafNodeSource.Commit) {
		throw new TypeError('A DAVE ratchet tree leaf must originate from a KeyPackage or Commit.');
	}
	if (
		!verifyWithLabel(
			provider,
			leafNode.signatureKey,
			'LeafNodeTBS',
			encodeLeafNodeTbs(leafNode, { groupId, leafIndex: memberLeafIndex }),
			leafNode.signature,
		)
	) {
		throw new TypeError('A DAVE MLS commit leaf signature is invalid.');
	}
}

/** @internal */
export function validateDaveExternalSender(provider: VoiceCryptoProvider, externalSender: MlsExternalSender): void {
	provider.validateP256PublicKey(externalSender.signatureKey);
	if (externalSender.credential.type !== CredentialType.Basic) {
		throw new TypeError('The DAVE external sender must use a Basic credential.');
	}
}

/** @internal */
export function copyDaveExternalSender(sender: MlsExternalSender): MlsExternalSender {
	return Object.freeze({
		signatureKey: sender.signatureKey.slice(),
		credential: Object.freeze({ type: CredentialType.Basic, identity: sender.credential.identity.slice() }),
	});
}

/** @internal */
export function equalDaveExternalSenders(left: MlsExternalSender, right: MlsExternalSender): boolean {
	return (
		equalBytes(left.signatureKey, right.signatureKey) &&
		left.credential.type === right.credential.type &&
		equalBytes(left.credential.identity, right.credential.identity)
	);
}

function decodeCredentialUserId(identity: Uint8Array): string {
	if (identity.byteLength !== 8) throw new TypeError('A DAVE credential identity must contain 8 bytes.');
	const value = new DataView(identity.buffer, identity.byteOffset, identity.byteLength).getBigUint64(0);
	if (value === 0n) throw new TypeError('A DAVE credential identity cannot be zero.');
	return value.toString();
}

function assertUniqueKey(value: Uint8Array, existing: Uint8Array[], name: string): void {
	if (existing.some(key => equalBytes(key, value)))
		throw new TypeError(`A DAVE MLS roster has a duplicate ${name} key.`);
	existing.push(value);
}

function assertEpochSecrets(secrets: DaveMlsEpochSecrets): void {
	for (const [name, secret] of Object.entries(secrets)) {
		if (secret.byteLength !== 32) throw new TypeError(`The MLS ${name} secret must contain 32 bytes.`);
	}
}

function copyEpochSecrets(secrets: DaveMlsEpochSecrets): DaveMlsEpochSecrets {
	return Object.freeze(
		Object.fromEntries(
			Object.entries(secrets).map(([name, secret]) => [name, secret.slice()]),
		) as unknown as DaveMlsEpochSecrets,
	);
}
