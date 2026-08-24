import { clearByteMap, equalBytes } from '../bytes';
import { assertP256KeyPair, type VoiceCryptoProvider } from '../crypto/provider';
import type { DaveIdentity } from '../dave/identity';
import { decryptWithLabel, deriveP256KeyPair, deriveSecret, encryptWithLabel, verifyWithLabel } from './crypto';
import {
	assertUniqueMlsExtensions,
	CipherSuite,
	CredentialType,
	encodeGroupContext,
	encodeLeafNodeTbs,
	LeafNodeSource,
	type MlsExtension,
	type MlsGroupContext,
	type MlsHpkeCiphertext,
	type MlsLeafNode,
	type MlsNode,
	type MlsUpdatePath,
	type MlsUpdatePathNode,
	NodeType,
	ProtocolVersion,
} from './protocol';
import {
	assertRatchetTree,
	compactTree,
	computeParentHash,
	copath,
	directPath,
	filteredDirectPath,
	leafNodeIndex,
	logicalLeafCount,
	type MlsRatchetTree,
	resolution,
	treeHash,
	validateParentHashes,
} from './tree';

const EMPTY = new Uint8Array();
const ZERO_COMMIT_SECRET = new Uint8Array(32);

export interface MlsProvisionalGroupContextInput {
	readonly version: typeof ProtocolVersion.Mls10;
	readonly cipherSuite: typeof CipherSuite.Dave;
	readonly groupId: Uint8Array;
	readonly epoch: bigint;
	readonly confirmedTranscriptHash: Uint8Array;
	readonly extensions: readonly MlsExtension[];
}

export interface MergeMlsUpdatePathInput {
	readonly tree: MlsRatchetTree;
	readonly senderLeafIndex: number;
	readonly updatePath: MlsUpdatePath;
	readonly groupId: Uint8Array;
	readonly excludedNewLeafIndices?: readonly number[];
}

export interface ProcessMlsUpdatePathInput {
	readonly tree: MlsRatchetTree;
	readonly senderLeafIndex: number;
	readonly updatePath: MlsUpdatePath;
	readonly groupContext: MlsProvisionalGroupContextInput;
	readonly privateKeys: ReadonlyMap<number, Uint8Array>;
	readonly excludedNewLeafIndices?: readonly number[];
}

export interface CreateMlsUpdatePathInput {
	readonly tree: MlsRatchetTree;
	readonly senderLeafIndex: number;
	readonly identity: DaveIdentity;
	readonly groupContext: MlsProvisionalGroupContextInput;
	readonly excludedNewLeafIndices?: readonly number[];
}

export interface MlsUpdatePathSecrets {
	readonly commitSecret: Uint8Array;
	readonly pathSecrets: ReadonlyMap<number, Uint8Array>;
	readonly privateKeys: ReadonlyMap<number, Uint8Array>;
	close(): void;
}

export interface ProcessedMlsUpdatePath {
	readonly tree: MlsRatchetTree;
	readonly groupContext: MlsGroupContext;
	readonly secrets: MlsUpdatePathSecrets;
}

export interface CreatedMlsUpdatePath extends ProcessedMlsUpdatePath {
	readonly updatePath: MlsUpdatePath;
}

interface MlsUpdatePathLayout {
	readonly senderNodeIndex: number;
	readonly pathNodeIndices: readonly number[];
	readonly copathNodeIndices: readonly number[];
	readonly resolutions: readonly (readonly number[])[];
}

interface MergedMlsUpdatePath {
	readonly tree: MlsRatchetTree;
	readonly layout: MlsUpdatePathLayout;
}

export function mergeUpdatePath(provider: VoiceCryptoProvider, input: MergeMlsUpdatePathInput): MlsRatchetTree {
	return mergeUpdatePathInternal(provider, input).tree;
}

export function processUpdatePath(
	provider: VoiceCryptoProvider,
	input: ProcessMlsUpdatePathInput,
): ProcessedMlsUpdatePath {
	const merged = mergeUpdatePathInternal(provider, {
		tree: input.tree,
		senderLeafIndex: input.senderLeafIndex,
		updatePath: input.updatePath,
		groupId: input.groupContext.groupId,
		excludedNewLeafIndices: input.excludedNewLeafIndices,
	});
	const groupContext = createProvisionalGroupContext(provider, input.groupContext, merged.tree);
	const encodedGroupContext = encodeGroupContext(groupContext);
	const decrypted = decryptPathSecret(
		provider,
		input.tree,
		merged.layout,
		input.updatePath,
		input.privateKeys,
		encodedGroupContext,
	);
	try {
		return Object.freeze({
			tree: merged.tree,
			groupContext,
			secrets: deriveReceivedPathSecrets(
				provider,
				merged.layout.pathNodeIndices,
				input.updatePath,
				decrypted.pathPosition,
				decrypted.pathSecret,
			),
		});
	} catch (error) {
		decrypted.pathSecret.fill(0);
		throw error;
	}
}

export function createUpdatePath(provider: VoiceCryptoProvider, input: CreateMlsUpdatePathInput): CreatedMlsUpdatePath {
	assertRatchetTree(input.tree);
	const layout = createUpdatePathLayout(input.tree, input.senderLeafIndex, input.excludedNewLeafIndices ?? []);
	const currentLeaf = requireLeafNode(input.tree, layout.senderNodeIndex).leafNode;
	if (!equalBytes(input.identity.publicKey, currentLeaf.signatureKey)) {
		throw new TypeError('The MLS UpdatePath identity must own the sender leaf signature key.');
	}

	const privateKeys = new Map<number, Uint8Array>();
	const pathSecrets = new Map<number, Uint8Array>();
	let commitSecret: Uint8Array | undefined;
	try {
		const leafKeyPair = provider.generateP256KeyPair();
		assertP256KeyPair(provider, leafKeyPair, 'The MLS UpdatePath leaf key pair does not match.');
		privateKeys.set(layout.senderNodeIndex, leafKeyPair.secretKey);

		const pathPublicKeys: Uint8Array[] = [];
		if (layout.pathNodeIndices.length > 0) {
			let pathSecret = provider.randomBytes(32);
			for (let position = 0; position < layout.pathNodeIndices.length; position++) {
				const pathNodeIndex = layout.pathNodeIndices[position] as number;
				pathSecrets.set(pathNodeIndex, pathSecret);
				const nodeSecret = deriveSecret(provider, pathSecret, 'node');
				try {
					const nodeKeyPair = deriveP256KeyPair(provider, nodeSecret);
					assertP256KeyPair(provider, nodeKeyPair, 'The MLS UpdatePath parent key pair does not match.');
					privateKeys.set(pathNodeIndex, nodeKeyPair.secretKey);
					pathPublicKeys.push(nodeKeyPair.publicKey);
				} finally {
					nodeSecret.fill(0);
				}
				if (position + 1 < layout.pathNodeIndices.length) pathSecret = deriveSecret(provider, pathSecret, 'path');
			}
			commitSecret = deriveSecret(
				provider,
				pathSecrets.get(layout.pathNodeIndices.at(-1) as number) as Uint8Array,
				'path',
			);
		} else {
			commitSecret = ZERO_COMMIT_SECRET.slice();
		}

		assertFreshUpdatePathKeys(provider, input.tree, leafKeyPair.publicKey, currentLeaf.signatureKey, pathPublicKeys);
		const pathTree = applyPathPublicKeys(provider, input.tree, layout, pathPublicKeys);
		const leafNode = createCommitLeafNode(
			input.identity,
			currentLeaf,
			leafKeyPair.publicKey,
			pathTree.leafParentHash,
			input.groupContext.groupId,
			input.senderLeafIndex,
		);
		validateUpdatePathLeaf(provider, input.tree, input.senderLeafIndex, leafNode, input.groupContext.groupId);
		const tree = finalizeUpdatePathTree(provider, pathTree.nodes, layout.senderNodeIndex, leafNode);
		const groupContext = createProvisionalGroupContext(provider, input.groupContext, tree);
		const encodedGroupContext = encodeGroupContext(groupContext);
		const updatePath: MlsUpdatePath = Object.freeze({
			leafNode,
			nodes: Object.freeze(
				layout.pathNodeIndices.map((pathNodeIndex, position) =>
					Object.freeze({
						encryptionKey: (pathPublicKeys[position] as Uint8Array).slice(),
						encryptedPathSecrets: Object.freeze(
							layout.resolutions[position]?.map(resolutionNodeIndex => {
								const ciphertext = encryptWithLabel(
									provider,
									getNodeEncryptionKey(input.tree, resolutionNodeIndex),
									'UpdatePathNode',
									encodedGroupContext,
									pathSecrets.get(pathNodeIndex) as Uint8Array,
								);
								return Object.freeze({
									kemOutput: ciphertext.kemOutput,
									ciphertext: ciphertext.ciphertext,
								});
							}) ?? [],
						),
					}),
				),
			),
		});
		validateUpdatePathNodes(provider, layout, updatePath);
		return Object.freeze({
			updatePath,
			tree,
			groupContext,
			secrets: new MlsUpdatePathSecretResource(commitSecret, pathSecrets, privateKeys),
		});
	} catch (error) {
		commitSecret?.fill(0);
		clearByteMap(pathSecrets);
		clearByteMap(privateKeys);
		throw error;
	}
}

class MlsUpdatePathSecretResource implements MlsUpdatePathSecrets {
	readonly #commitSecret: Uint8Array;
	readonly #pathSecrets: Map<number, Uint8Array>;
	readonly #privateKeys: Map<number, Uint8Array>;
	#closed = false;

	constructor(commitSecret: Uint8Array, pathSecrets: Map<number, Uint8Array>, privateKeys: Map<number, Uint8Array>) {
		this.#commitSecret = commitSecret;
		this.#pathSecrets = pathSecrets;
		this.#privateKeys = privateKeys;
	}

	get commitSecret(): Uint8Array {
		this.assertOpen();
		return this.#commitSecret.slice();
	}

	get pathSecrets(): ReadonlyMap<number, Uint8Array> {
		this.assertOpen();
		return cloneSecretMap(this.#pathSecrets);
	}

	get privateKeys(): ReadonlyMap<number, Uint8Array> {
		this.assertOpen();
		return cloneSecretMap(this.#privateKeys);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#commitSecret.fill(0);
		clearByteMap(this.#pathSecrets);
		clearByteMap(this.#privateKeys);
	}

	private assertOpen(): void {
		if (!this.#closed) return;
		throw new Error('The MLS UpdatePath secrets are closed.');
	}
}

function mergeUpdatePathInternal(provider: VoiceCryptoProvider, input: MergeMlsUpdatePathInput): MergedMlsUpdatePath {
	assertRatchetTree(input.tree);
	const layout = createUpdatePathLayout(input.tree, input.senderLeafIndex, input.excludedNewLeafIndices ?? []);
	validateUpdatePathLeaf(provider, input.tree, input.senderLeafIndex, input.updatePath.leafNode, input.groupId);
	validateUpdatePathNodes(provider, layout, input.updatePath);
	assertFreshUpdatePathKeys(
		provider,
		input.tree,
		input.updatePath.leafNode.encryptionKey,
		input.updatePath.leafNode.signatureKey,
		input.updatePath.nodes.map(node => node.encryptionKey),
	);
	const pathTree = applyPathPublicKeys(
		provider,
		input.tree,
		layout,
		input.updatePath.nodes.map(node => node.encryptionKey),
	);
	if (!equalBytes(pathTree.leafParentHash, readCommitLeafParentHash(input.updatePath.leafNode))) {
		throw new TypeError('The MLS UpdatePath leaf parent hash is invalid.');
	}
	return Object.freeze({
		layout,
		tree: finalizeUpdatePathTree(provider, pathTree.nodes, layout.senderNodeIndex, input.updatePath.leafNode),
	});
}

function createUpdatePathLayout(
	tree: MlsRatchetTree,
	senderLeafIndex: number,
	excludedNewLeafIndices: readonly number[],
): MlsUpdatePathLayout {
	assertRatchetTree(tree);
	const senderNodeIndex = leafNodeIndex(senderLeafIndex);
	requireLeafNode(tree, senderNodeIndex);
	const leafCount = logicalLeafCount(tree);
	const fullPath = directPath(senderNodeIndex, leafCount);
	const fullCopath = copath(senderNodeIndex, leafCount);
	const pathNodeIndices = filteredDirectPath(tree, senderLeafIndex);
	const excludedNodeIndices = validateExcludedLeaves(tree, senderLeafIndex, excludedNewLeafIndices);
	const copathNodeIndices = pathNodeIndices.map(pathNodeIndex => {
		const position = fullPath.indexOf(pathNodeIndex);
		if (position === -1) throw new Error('The MLS filtered direct path is inconsistent with the direct path.');
		return fullCopath[position] as number;
	});
	return Object.freeze({
		senderNodeIndex,
		pathNodeIndices: Object.freeze([...pathNodeIndices]),
		copathNodeIndices: Object.freeze(copathNodeIndices),
		resolutions: Object.freeze(
			copathNodeIndices.map(nodeIndex =>
				Object.freeze(resolution(tree, nodeIndex).filter(value => !excludedNodeIndices.has(value))),
			),
		),
	});
}

function validateExcludedLeaves(
	tree: MlsRatchetTree,
	senderLeafIndex: number,
	excludedNewLeafIndices: readonly number[],
): ReadonlySet<number> {
	const excluded = new Set<number>();
	for (const memberLeafIndex of excludedNewLeafIndices) {
		if (!Number.isSafeInteger(memberLeafIndex) || memberLeafIndex < 0) {
			throw new RangeError('An excluded MLS leaf index is invalid.');
		}
		if (memberLeafIndex === senderLeafIndex) throw new TypeError('The MLS UpdatePath sender cannot be excluded.');
		const nodeIndex = leafNodeIndex(memberLeafIndex);
		requireLeafNode(tree, nodeIndex);
		if (excluded.has(nodeIndex)) throw new TypeError('An MLS UpdatePath excluded leaf is duplicated.');
		excluded.add(nodeIndex);
	}
	return excluded;
}

function validateUpdatePathLeaf(
	provider: VoiceCryptoProvider,
	tree: MlsRatchetTree,
	senderLeafIndex: number,
	leafNode: MlsLeafNode,
	groupId: Uint8Array,
): void {
	const senderNodeIndex = leafNodeIndex(senderLeafIndex);
	const currentLeaf = requireLeafNode(tree, senderNodeIndex).leafNode;
	if (leafNode.source.type !== LeafNodeSource.Commit) {
		throw new TypeError('An MLS UpdatePath leaf must use the commit source.');
	}
	provider.validateP256PublicKey(leafNode.encryptionKey);
	provider.validateP256PublicKey(leafNode.signatureKey);
	if (equalBytes(leafNode.encryptionKey, currentLeaf.encryptionKey)) {
		throw new TypeError('An MLS UpdatePath must replace the sender leaf encryption key.');
	}
	if (equalBytes(leafNode.encryptionKey, leafNode.signatureKey)) {
		throw new TypeError('MLS leaf encryption and signature keys must be distinct.');
	}
	if (leafNode.credential.type !== CredentialType.Basic || leafNode.credential.identity.byteLength === 0) {
		throw new TypeError('An MLS UpdatePath leaf must contain a non-empty Basic credential.');
	}
	assertRequiredCapability(leafNode.capabilities.versions, ProtocolVersion.Mls10, 'MLS 1.0');
	assertRequiredCapability(leafNode.capabilities.cipherSuites, CipherSuite.Dave, 'ciphersuite 2');
	assertRequiredCapability(leafNode.capabilities.credentials, CredentialType.Basic, 'Basic credentials');
	assertUniqueMlsExtensions(leafNode.extensions);
	for (const extension of leafNode.extensions) {
		if (!leafNode.capabilities.extensions.includes(extension.type)) {
			throw new TypeError(`MLS leaf extension ${extension.type} is not advertised by its capabilities.`);
		}
	}
	for (let nodeIndex = 0; nodeIndex < tree.length; nodeIndex++) {
		const node = tree[nodeIndex];
		if (node === undefined || nodeIndex === senderNodeIndex) continue;
		const keys =
			node.type === NodeType.Leaf
				? [node.leafNode.signatureKey, node.leafNode.encryptionKey]
				: [node.parentNode.encryptionKey];
		if (keys.some(key => equalBytes(key, leafNode.signatureKey) || equalBytes(key, leafNode.encryptionKey))) {
			throw new TypeError('MLS leaf keys must be distinct from every key in the ratchet tree.');
		}
	}
	if (
		!verifyWithLabel(
			provider,
			leafNode.signatureKey,
			'LeafNodeTBS',
			encodeLeafNodeTbs(leafNode, { groupId, leafIndex: senderLeafIndex }),
			leafNode.signature,
		)
	) {
		throw new TypeError('The MLS UpdatePath leaf signature is invalid.');
	}
}

function validateUpdatePathNodes(
	provider: VoiceCryptoProvider,
	layout: MlsUpdatePathLayout,
	updatePath: MlsUpdatePath,
): void {
	if (updatePath.nodes.length !== layout.pathNodeIndices.length) {
		throw new TypeError('The MLS UpdatePath node count does not match the filtered direct path.');
	}
	for (let position = 0; position < updatePath.nodes.length; position++) {
		const node = updatePath.nodes[position] as MlsUpdatePathNode;
		provider.validateP256PublicKey(node.encryptionKey);
		const expectedCiphertexts = layout.resolutions[position]?.length ?? 0;
		if (node.encryptedPathSecrets.length !== expectedCiphertexts) {
			throw new TypeError('An MLS UpdatePath encrypted path secret count does not match the copath resolution.');
		}
		for (const encryptedPathSecret of node.encryptedPathSecrets) {
			provider.validateP256PublicKey(encryptedPathSecret.kemOutput);
			if (encryptedPathSecret.ciphertext.byteLength !== 48) {
				throw new TypeError('An MLS ciphersuite 2 encrypted path secret must contain 48 bytes.');
			}
		}
	}
}

function applyPathPublicKeys(
	provider: VoiceCryptoProvider,
	tree: MlsRatchetTree,
	layout: MlsUpdatePathLayout,
	pathPublicKeys: readonly Uint8Array[],
): { readonly nodes: (MlsNode | undefined)[]; readonly leafParentHash: Uint8Array } {
	if (pathPublicKeys.length !== layout.pathNodeIndices.length) {
		throw new TypeError('The MLS path public key count does not match the filtered direct path.');
	}
	const nodes = [...tree];
	const leafCount = logicalLeafCount(tree);
	for (const pathNodeIndex of directPath(layout.senderNodeIndex, leafCount)) nodes[pathNodeIndex] = undefined;
	for (let position = 0; position < layout.pathNodeIndices.length; position++) {
		const pathNodeIndex = layout.pathNodeIndices[position] as number;
		nodes[pathNodeIndex] = Object.freeze({
			type: NodeType.Parent,
			parentNode: Object.freeze({
				encryptionKey: (pathPublicKeys[position] as Uint8Array).slice(),
				parentHash: EMPTY,
				unmergedLeaves: Object.freeze([]),
			}),
		});
	}
	for (let position = layout.pathNodeIndices.length - 1; position >= 0; position--) {
		const pathNodeIndex = layout.pathNodeIndices[position] as number;
		const currentNode = requireParentNode(nodes, pathNodeIndex);
		const parentHash =
			position + 1 === layout.pathNodeIndices.length
				? EMPTY
				: computeParentHash(
						provider,
						compactTree(nodes),
						layout.pathNodeIndices[position + 1] as number,
						layout.copathNodeIndices[position + 1] as number,
					);
		nodes[pathNodeIndex] = Object.freeze({
			type: NodeType.Parent,
			parentNode: Object.freeze({ ...currentNode.parentNode, parentHash }),
		});
	}
	const leafParentHash =
		layout.pathNodeIndices.length === 0
			? EMPTY
			: computeParentHash(
					provider,
					compactTree(nodes),
					layout.pathNodeIndices[0] as number,
					layout.copathNodeIndices[0] as number,
				);
	return Object.freeze({ nodes, leafParentHash });
}

function finalizeUpdatePathTree(
	provider: VoiceCryptoProvider,
	nodes: (MlsNode | undefined)[],
	senderNodeIndex: number,
	leafNode: MlsLeafNode,
): MlsRatchetTree {
	nodes[senderNodeIndex] = Object.freeze({ type: NodeType.Leaf, leafNode });
	const tree = Object.freeze(compactTree(nodes));
	assertRatchetTree(tree);
	if (!validateParentHashes(provider, tree)) {
		throw new TypeError('The MLS UpdatePath does not produce a valid parent-hash tree.');
	}
	return tree;
}

function createCommitLeafNode(
	identity: DaveIdentity,
	currentLeaf: MlsLeafNode,
	encryptionKey: Uint8Array,
	parentHash: Uint8Array,
	groupId: Uint8Array,
	senderLeafIndex: number,
): MlsLeafNode {
	const unsignedLeaf: MlsLeafNode = {
		...currentLeaf,
		encryptionKey: encryptionKey.slice(),
		source: { type: LeafNodeSource.Commit, parentHash: parentHash.slice() },
		signature: EMPTY,
	};
	return Object.freeze({
		...unsignedLeaf,
		signature: identity.sign('LeafNodeTBS', encodeLeafNodeTbs(unsignedLeaf, { groupId, leafIndex: senderLeafIndex })),
	});
}

function createProvisionalGroupContext(
	provider: VoiceCryptoProvider,
	input: MlsProvisionalGroupContextInput,
	tree: MlsRatchetTree,
): MlsGroupContext {
	if (input.version !== ProtocolVersion.Mls10 || input.cipherSuite !== CipherSuite.Dave) {
		throw new TypeError('An MLS UpdatePath must use MLS 1.0 and ciphersuite 2.');
	}
	if (input.groupId.byteLength === 0) throw new TypeError('An MLS group ID cannot be empty.');
	if (input.epoch < 0n || input.epoch > 0xffff_ffff_ffff_ffffn) {
		throw new RangeError('An MLS epoch must fit uint64.');
	}
	if (input.confirmedTranscriptHash.byteLength !== 0 && input.confirmedTranscriptHash.byteLength !== 32) {
		throw new TypeError('An MLS confirmed transcript hash must be empty or contain 32 bytes.');
	}
	assertUniqueMlsExtensions(input.extensions);
	return Object.freeze({
		version: input.version,
		cipherSuite: input.cipherSuite,
		groupId: input.groupId.slice(),
		epoch: input.epoch,
		treeHash: treeHash(provider, tree),
		confirmedTranscriptHash: input.confirmedTranscriptHash.slice(),
		extensions: Object.freeze(
			input.extensions.map(extension => Object.freeze({ type: extension.type, data: extension.data.slice() })),
		),
	});
}

function decryptPathSecret(
	provider: VoiceCryptoProvider,
	tree: MlsRatchetTree,
	layout: MlsUpdatePathLayout,
	updatePath: MlsUpdatePath,
	privateKeys: ReadonlyMap<number, Uint8Array>,
	encodedGroupContext: Uint8Array,
): { readonly pathPosition: number; readonly pathSecret: Uint8Array } {
	for (let pathPosition = 0; pathPosition < layout.resolutions.length; pathPosition++) {
		const pathNode = updatePath.nodes[pathPosition] as MlsUpdatePathNode;
		const pathResolution = layout.resolutions[pathPosition] as readonly number[];
		for (let resolutionPosition = 0; resolutionPosition < pathResolution.length; resolutionPosition++) {
			const resolutionNodeIndex = pathResolution[resolutionPosition] as number;
			const privateKey = privateKeys.get(resolutionNodeIndex);
			if (privateKey === undefined) continue;
			if (!equalBytes(provider.getP256PublicKey(privateKey), getNodeEncryptionKey(tree, resolutionNodeIndex))) {
				throw new TypeError('An MLS private key does not match its ratchet tree node.');
			}
			const ciphertext = pathNode.encryptedPathSecrets[resolutionPosition] as MlsHpkeCiphertext;
			let pathSecret: Uint8Array;
			try {
				pathSecret = decryptWithLabel(
					provider,
					privateKey,
					'UpdatePathNode',
					encodedGroupContext,
					ciphertext.kemOutput,
					ciphertext.ciphertext,
				);
			} catch (cause) {
				throw new TypeError('The MLS UpdatePath path secret could not be decrypted.', { cause });
			}
			if (pathSecret.byteLength !== 32) {
				pathSecret.fill(0);
				throw new TypeError('An MLS path secret must contain 32 bytes.');
			}
			return Object.freeze({ pathPosition, pathSecret });
		}
	}
	throw new TypeError('No MLS UpdatePath path secret can be decrypted with the supplied private keys.');
}

function deriveReceivedPathSecrets(
	provider: VoiceCryptoProvider,
	pathNodeIndices: readonly number[],
	updatePath: MlsUpdatePath,
	startPosition: number,
	initialPathSecret: Uint8Array,
): MlsUpdatePathSecrets {
	const pathSecrets = new Map<number, Uint8Array>();
	const privateKeys = new Map<number, Uint8Array>();
	let currentPathSecret = initialPathSecret;
	let commitSecret: Uint8Array | undefined;
	try {
		for (let position = startPosition; position < pathNodeIndices.length; position++) {
			const pathNodeIndex = pathNodeIndices[position] as number;
			pathSecrets.set(pathNodeIndex, currentPathSecret.slice());
			const nodeSecret = deriveSecret(provider, currentPathSecret, 'node');
			try {
				const nodeKeyPair = deriveP256KeyPair(provider, nodeSecret);
				if (!equalBytes(nodeKeyPair.publicKey, (updatePath.nodes[position] as MlsUpdatePathNode).encryptionKey)) {
					nodeKeyPair.secretKey.fill(0);
					throw new TypeError('An MLS UpdatePath public key does not match its path secret.');
				}
				privateKeys.set(pathNodeIndex, nodeKeyPair.secretKey);
			} finally {
				nodeSecret.fill(0);
			}
			if (position + 1 < pathNodeIndices.length) {
				const nextPathSecret = deriveSecret(provider, currentPathSecret, 'path');
				currentPathSecret.fill(0);
				currentPathSecret = nextPathSecret;
			}
		}
		commitSecret = deriveSecret(provider, currentPathSecret, 'path');
		currentPathSecret.fill(0);
		return new MlsUpdatePathSecretResource(commitSecret, pathSecrets, privateKeys);
	} catch (error) {
		currentPathSecret.fill(0);
		commitSecret?.fill(0);
		clearByteMap(pathSecrets);
		clearByteMap(privateKeys);
		throw error;
	}
}

function assertFreshUpdatePathKeys(
	provider: VoiceCryptoProvider,
	tree: MlsRatchetTree,
	leafEncryptionKey: Uint8Array,
	leafSignatureKey: Uint8Array,
	pathEncryptionKeys: readonly Uint8Array[],
): void {
	const existingKeys: Uint8Array[] = [];
	for (let nodeIndex = 0; nodeIndex < tree.length; nodeIndex++) {
		const node = tree[nodeIndex];
		if (node === undefined) continue;
		const encryptionKey = node.type === NodeType.Leaf ? node.leafNode.encryptionKey : node.parentNode.encryptionKey;
		provider.validateP256PublicKey(encryptionKey);
		existingKeys.push(encryptionKey);
		if (node.type === NodeType.Leaf) existingKeys.push(node.leafNode.signatureKey);
	}
	const updateKeys = [leafEncryptionKey, ...pathEncryptionKeys];
	for (let position = 0; position < updateKeys.length; position++) {
		const updateKey = updateKeys[position] as Uint8Array;
		provider.validateP256PublicKey(updateKey);
		if (equalBytes(leafSignatureKey, updateKey)) {
			throw new TypeError('MLS UpdatePath encryption keys must be distinct from the leaf signature key.');
		}
		if (existingKeys.some(existing => equalBytes(existing, updateKey))) {
			throw new TypeError('An MLS UpdatePath public key already appears in the ratchet tree.');
		}
		if (updateKeys.slice(0, position).some(existing => equalBytes(existing, updateKey))) {
			throw new TypeError('MLS UpdatePath public keys must be unique.');
		}
	}
}

function requireLeafNode(tree: MlsRatchetTree, nodeIndex: number): Extract<MlsNode, { readonly type: 1 }> {
	const node = tree[nodeIndex];
	if (node?.type !== NodeType.Leaf) throw new TypeError('The MLS UpdatePath sender leaf must be non-blank.');
	return node;
}

function readCommitLeafParentHash(leafNode: MlsLeafNode): Uint8Array {
	if (leafNode.source.type !== LeafNodeSource.Commit) {
		throw new TypeError('An MLS UpdatePath leaf must use the commit source.');
	}
	return leafNode.source.parentHash;
}

function requireParentNode(
	tree: readonly (MlsNode | undefined)[],
	nodeIndex: number,
): Extract<MlsNode, { readonly type: 2 }> {
	const node = tree[nodeIndex];
	if (node?.type !== NodeType.Parent) throw new TypeError('An MLS UpdatePath parent node is missing.');
	return node;
}

function getNodeEncryptionKey(tree: MlsRatchetTree, nodeIndex: number): Uint8Array {
	const node = tree[nodeIndex];
	if (node === undefined) throw new TypeError('An MLS UpdatePath resolution contains a blank node.');
	return node.type === NodeType.Leaf ? node.leafNode.encryptionKey : node.parentNode.encryptionKey;
}

function assertRequiredCapability(values: readonly number[], expected: number, name: string): void {
	if (values.includes(expected)) return;
	throw new TypeError(`An MLS UpdatePath leaf must advertise ${name}.`);
}

function cloneSecretMap(source: ReadonlyMap<number, Uint8Array>): ReadonlyMap<number, Uint8Array> {
	return new Map([...source].map(([nodeIndex, secret]) => [nodeIndex, secret.slice()] as const));
}
