import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { VoiceCryptoProvider } from '../src/crypto/provider';
import { DaveIdentity } from '../src/dave/identity';
import { deriveP256KeyPair, deriveSecret, signWithLabel } from '../src/mls/crypto';
import {
	CipherSuite,
	decodeRatchetTree,
	decodeUpdatePath,
	encodeLeafNodeTbs,
	LeafNodeSource,
	type MlsLeafNode,
	type MlsUpdatePathNode,
	NodeType,
	ProtocolVersion,
} from '../src/mls/protocol';
import { leafNodeIndex, type MlsRatchetTree, treeHash } from '../src/mls/tree';
import {
	createUpdatePath,
	type MlsProvisionalGroupContextInput,
	mergeUpdatePath,
	processUpdatePath,
} from '../src/mls/treekem';

interface OfficialTreeKemVector {
	readonly cipher_suite: number;
	readonly confirmed_transcript_hash: string;
	readonly epoch: number;
	readonly group_id: string;
	readonly leaves_private: readonly OfficialLeafPrivate[];
	readonly ratchet_tree: string;
	readonly update_paths: readonly OfficialUpdatePath[];
}

interface OfficialLeafPrivate {
	readonly encryption_priv: string;
	readonly index: number;
	readonly path_secrets: readonly {
		readonly node: number;
		readonly path_secret: string;
	}[];
	readonly signature_priv: string;
}

interface OfficialUpdatePath {
	readonly commit_secret: string;
	readonly path_secrets: readonly (string | null)[];
	readonly sender: number;
	readonly tree_hash_after: string;
	readonly update_path: string;
}

// MLSWG mls-implementations cfd450286d1bfd9cd2519b95c80f9771f94a5b1a, test-vectors/treekem.json.
const officialVectors = JSON.parse(
	readFileSync(new URL('./fixtures/mls-treekem-suite2.json', import.meta.url), 'utf8'),
) as readonly OfficialTreeKemVector[];

const provider = new VoiceCryptoProvider();

describe('MLS TreeKEM UpdatePath processing', () => {
	test('processes every official ciphersuite 2 UpdatePath for every active recipient', () => {
		let updatePathCount = 0;
		let recipientCount = 0;
		for (const vector of officialVectors) {
			expect(vector.cipher_suite).toBe(CipherSuite.Dave);
			const tree = decodeRatchetTree(hex(vector.ratchet_tree));
			const groupContext = groupContextInput(vector);
			for (const officialPath of vector.update_paths) {
				updatePathCount++;
				const updatePath = decodeUpdatePath(hex(officialPath.update_path));
				for (const leafPrivate of vector.leaves_private) {
					const expectedPathSecret = officialPath.path_secrets[leafPrivate.index];
					if (expectedPathSecret === null || expectedPathSecret === undefined) continue;
					recipientCount++;
					const privateKeys = readPrivateKeys(provider, leafPrivate);
					try {
						const result = processUpdatePath(provider, {
							tree,
							senderLeafIndex: officialPath.sender,
							updatePath,
							groupContext,
							privateKeys,
						});
						expect(toHex(result.groupContext.treeHash)).toBe(officialPath.tree_hash_after);
						expect(toHex(treeHash(provider, result.tree))).toBe(officialPath.tree_hash_after);
						expect(toHex(result.secrets.commitSecret)).toBe(officialPath.commit_secret);
						expect(toHex(firstSecret(result.secrets.pathSecrets))).toBe(expectedPathSecret);
						assertPrivateKeysMatchTree(provider, result.tree, result.secrets.privateKeys);
						result.secrets.close();
						expect(() => result.secrets.commitSecret).toThrow('closed');
					} finally {
						eraseSecrets(privateKeys);
					}
				}
			}
		}
		expect(officialVectors).toHaveLength(11);
		expect(updatePathCount).toBe(62);
		expect(recipientCount).toBe(328);
	}, 30_000);

	test('rejects malformed nodes, reused keys, signatures and parent hashes before exposing secrets', () => {
		const vector = officialVectors[0] as OfficialTreeKemVector;
		const officialPath = vector.update_paths[0] as OfficialUpdatePath;
		const tree = decodeRatchetTree(hex(vector.ratchet_tree));
		const updatePath = decodeUpdatePath(hex(officialPath.update_path));
		const receiver = vector.leaves_private.find(
			leaf => officialPath.path_secrets[leaf.index] !== null,
		) as OfficialLeafPrivate;
		const privateKeys = readPrivateKeys(provider, receiver);
		try {
			const firstNode = updatePath.nodes[0] as MlsUpdatePathNode;
			expect(() =>
				processUpdatePath(provider, {
					tree,
					senderLeafIndex: officialPath.sender,
					updatePath: {
						...updatePath,
						nodes: [
							{ ...firstNode, encryptedPathSecrets: firstNode.encryptedPathSecrets.slice(1) },
							...updatePath.nodes.slice(1),
						],
					},
					groupContext: groupContextInput(vector),
					privateKeys,
				}),
			).toThrow('resolution');

			const badSignature = updatePath.leafNode.signature.slice();
			badSignature[badSignature.length - 1] ^= 1;
			expect(() =>
				mergeUpdatePath(provider, {
					tree,
					senderLeafIndex: officialPath.sender,
					updatePath: { ...updatePath, leafNode: { ...updatePath.leafNode, signature: badSignature } },
					groupId: hex(vector.group_id),
				}),
			).toThrow('signature');

			const senderNode = tree[leafNodeIndex(officialPath.sender)];
			if (senderNode?.type !== NodeType.Leaf) throw new TypeError('Expected the vector sender leaf.');
			expect(() =>
				mergeUpdatePath(provider, {
					tree,
					senderLeafIndex: officialPath.sender,
					updatePath: {
						...updatePath,
						leafNode: { ...updatePath.leafNode, encryptionKey: senderNode.leafNode.encryptionKey },
					},
					groupId: hex(vector.group_id),
				}),
			).toThrow('replace');

			const identity = new VectorDaveIdentity(
				provider,
				hex(
					(vector.leaves_private.find(leaf => leaf.index === officialPath.sender) as OfficialLeafPrivate)
						.signature_priv,
				),
			);
			try {
				const reusedUnsignedLeaf: MlsLeafNode = {
					...updatePath.leafNode,
					encryptionKey: updatePath.leafNode.signatureKey,
					signature: new Uint8Array(),
				};
				const reusedLeaf: MlsLeafNode = {
					...reusedUnsignedLeaf,
					signature: identity.sign(
						'LeafNodeTBS',
						encodeLeafNodeTbs(reusedUnsignedLeaf, {
							groupId: hex(vector.group_id),
							leafIndex: officialPath.sender,
						}),
					),
				};
				expect(() =>
					mergeUpdatePath(provider, {
						tree,
						senderLeafIndex: officialPath.sender,
						updatePath: { ...updatePath, leafNode: reusedLeaf },
						groupId: hex(vector.group_id),
					}),
				).toThrow('distinct');

				const source = updatePath.leafNode.source;
				if (source.type !== LeafNodeSource.Commit) throw new TypeError('Expected a commit leaf.');
				const parentHash = source.parentHash.slice();
				parentHash[0] ^= 1;
				const unsignedLeaf: MlsLeafNode = {
					...updatePath.leafNode,
					source: { type: LeafNodeSource.Commit, parentHash },
					signature: new Uint8Array(),
				};
				const leafNode: MlsLeafNode = {
					...unsignedLeaf,
					signature: identity.sign(
						'LeafNodeTBS',
						encodeLeafNodeTbs(unsignedLeaf, {
							groupId: hex(vector.group_id),
							leafIndex: officialPath.sender,
						}),
					),
				};
				expect(() =>
					mergeUpdatePath(provider, {
						tree,
						senderLeafIndex: officialPath.sender,
						updatePath: { ...updatePath, leafNode },
						groupId: hex(vector.group_id),
					}),
				).toThrow('parent hash');
			} finally {
				identity.close();
			}
		} finally {
			eraseSecrets(privateKeys);
		}
	});
});

describe('MLS TreeKEM UpdatePath creation', () => {
	test('creates a path on an official tree that every other active member can process', () => {
		const vector = officialVectors[6] as OfficialTreeKemVector;
		const sender = vector.update_paths[0]?.sender as number;
		const senderPrivate = vector.leaves_private.find(leaf => leaf.index === sender) as OfficialLeafPrivate;
		const identity = new VectorDaveIdentity(provider, hex(senderPrivate.signature_priv));
		const tree = decodeRatchetTree(hex(vector.ratchet_tree));
		const created = createUpdatePath(provider, {
			tree,
			senderLeafIndex: sender,
			identity,
			groupContext: groupContextInput(vector),
		});
		try {
			expect(created.updatePath.leafNode.source.type).toBe(LeafNodeSource.Commit);
			expect(created.updatePath.nodes.length).toBeGreaterThan(0);
			expect(created.groupContext.treeHash).toEqual(treeHash(provider, created.tree));
			assertPrivateKeysMatchTree(provider, created.tree, created.secrets.privateKeys);

			let recipients = 0;
			for (const receiver of vector.leaves_private) {
				if (receiver.index === sender) continue;
				recipients++;
				const privateKeys = readPrivateKeys(provider, receiver);
				try {
					const processed = processUpdatePath(provider, {
						tree,
						senderLeafIndex: sender,
						updatePath: created.updatePath,
						groupContext: groupContextInput(vector),
						privateKeys,
					});
					try {
						expect(processed.tree).toEqual(created.tree);
						expect(processed.secrets.commitSecret).toEqual(created.secrets.commitSecret);
						const [firstNodeIndex, firstPathSecret] = firstSecretEntry(processed.secrets.pathSecrets);
						expect(firstPathSecret).toEqual(created.secrets.pathSecrets.get(firstNodeIndex));
					} finally {
						processed.secrets.close();
					}
				} finally {
					eraseSecrets(privateKeys);
				}
			}
			expect(recipients).toBe(7);

			const exposedCommitSecret = created.secrets.commitSecret;
			exposedCommitSecret.fill(0);
			expect(created.secrets.commitSecret).not.toEqual(exposedCommitSecret);
			const exposedPrivateKeys = created.secrets.privateKeys;
			firstSecret(exposedPrivateKeys).fill(0);
			assertPrivateKeysMatchTree(provider, created.tree, created.secrets.privateKeys);
		} finally {
			created.secrets.close();
			identity.close();
		}
		expect(() => created.secrets.privateKeys).toThrow('closed');
	});
});

class VectorDaveIdentity extends DaveIdentity {
	readonly #fixedProvider: VoiceCryptoProvider;
	readonly #fixedSecretKey: Uint8Array;
	readonly #fixedPublicKey: Uint8Array;
	#fixedClosed = false;

	constructor(provider: VoiceCryptoProvider, secretKey: Uint8Array) {
		super(provider);
		super.close();
		this.#fixedProvider = provider;
		this.#fixedSecretKey = secretKey.slice();
		this.#fixedPublicKey = provider.getP256PublicKey(secretKey);
	}

	override get publicKey(): Uint8Array {
		this.assertFixedOpen();
		return this.#fixedPublicKey.slice();
	}

	override sign(label: string, content: Uint8Array): Uint8Array {
		this.assertFixedOpen();
		return signWithLabel(this.#fixedProvider, this.#fixedSecretKey, label, content);
	}

	override close(): void {
		if (this.#fixedClosed) return;
		this.#fixedClosed = true;
		this.#fixedSecretKey.fill(0);
		this.#fixedPublicKey.fill(0);
	}

	private assertFixedOpen(): void {
		if (!this.#fixedClosed) return;
		throw new Error('The vector DAVE identity is closed.');
	}
}

function groupContextInput(vector: OfficialTreeKemVector): MlsProvisionalGroupContextInput {
	return {
		version: ProtocolVersion.Mls10,
		cipherSuite: CipherSuite.Dave,
		groupId: hex(vector.group_id),
		epoch: BigInt(vector.epoch),
		confirmedTranscriptHash: hex(vector.confirmed_transcript_hash),
		extensions: [],
	};
}

function readPrivateKeys(
	cryptoProvider: VoiceCryptoProvider,
	leafPrivate: OfficialLeafPrivate,
): Map<number, Uint8Array> {
	const privateKeys = new Map<number, Uint8Array>([
		[leafNodeIndex(leafPrivate.index), hex(leafPrivate.encryption_priv)],
	]);
	try {
		for (const pathSecret of leafPrivate.path_secrets) {
			const nodeSecret = deriveSecret(cryptoProvider, hex(pathSecret.path_secret), 'node');
			try {
				privateKeys.set(pathSecret.node, deriveP256KeyPair(cryptoProvider, nodeSecret).secretKey);
			} finally {
				nodeSecret.fill(0);
			}
		}
		return privateKeys;
	} catch (error) {
		eraseSecrets(privateKeys);
		throw error;
	}
}

function assertPrivateKeysMatchTree(
	cryptoProvider: VoiceCryptoProvider,
	tree: MlsRatchetTree,
	privateKeys: ReadonlyMap<number, Uint8Array>,
): void {
	for (const [nodeIndex, privateKey] of privateKeys) {
		const node = tree[nodeIndex];
		if (node === undefined) throw new TypeError('Expected a non-blank private-key node.');
		const publicKey = node.type === NodeType.Leaf ? node.leafNode.encryptionKey : node.parentNode.encryptionKey;
		expect(cryptoProvider.getP256PublicKey(privateKey)).toEqual(publicKey);
	}
}

function firstSecret(secrets: ReadonlyMap<number, Uint8Array>): Uint8Array {
	return firstSecretEntry(secrets)[1];
}

function firstSecretEntry(secrets: ReadonlyMap<number, Uint8Array>): readonly [number, Uint8Array] {
	const entry = secrets.entries().next().value;
	if (entry === undefined) throw new TypeError('Expected at least one MLS secret.');
	return entry;
}

function eraseSecrets(secrets: Map<number, Uint8Array>): void {
	for (const secret of secrets.values()) secret.fill(0);
	secrets.clear();
}

function hex(value: string): Uint8Array {
	return Buffer.from(value, 'hex');
}

function toHex(value: Uint8Array): string {
	return Buffer.from(value).toString('hex');
}
