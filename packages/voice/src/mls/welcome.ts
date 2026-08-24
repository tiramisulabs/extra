import { clearByteMap, equalBytes, zeroByteRecord, zeroBytes } from '../bytes';
import type { VoiceCryptoProvider } from '../crypto/provider';
import type { DaveIdentity } from '../dave/identity';
import { deriveP256KeyPair, deriveSecret, refHash } from './crypto';
import {
	decryptGroupInfo,
	decryptGroupSecrets,
	encryptGroupInfo,
	encryptGroupSecrets,
	signGroupInfo,
	verifyGroupInfo,
} from './handshake';
import { deriveEpochSecretsFromJoiner, deriveWelcomeSecret, type MlsEpochSecrets } from './key-schedule';
import type { DaveKeyPackageMaterial } from './profile';
import type { AppliedDaveProposals } from './proposals';
import {
	CipherSuite,
	decodeRatchetTree,
	decodeWelcome,
	ExtensionType,
	encodeGroupContext,
	encodeKeyPackage,
	encodeLeafNode,
	encodeRatchetTree,
	encodeWelcome,
	type MlsEncryptedGroupSecrets,
	type MlsExternalSender,
	type MlsGroupInfo,
	type MlsGroupSecrets,
	type MlsLeafNode,
	type MlsWelcome,
	NodeType,
} from './protocol';
import { assertDaveGroupContext, DaveMlsGroupState } from './state';
import { updateInterimTranscriptHash, verifyConfirmationTag } from './transcript';
import { directPath, leafIndex, leafNodeIndex, logicalLeafCount, type MlsRatchetTree } from './tree';
import type { CreatedMlsUpdatePath } from './treekem';

export interface CreateDaveMlsWelcomeInput {
	readonly state: DaveMlsGroupState;
	readonly secrets: MlsEpochSecrets;
	readonly added: AppliedDaveProposals['added'];
	readonly createdPath: CreatedMlsUpdatePath | undefined;
}

export interface ProcessDaveMlsWelcomeInput {
	readonly encodedWelcome: Uint8Array;
	readonly externalSender: MlsExternalSender;
	readonly groupId: Uint8Array;
	readonly joinKeyPackage: DaveKeyPackageMaterial;
}

export function createDaveMlsWelcome(
	provider: VoiceCryptoProvider,
	identity: DaveIdentity,
	input: CreateDaveMlsWelcomeInput,
): Uint8Array | undefined {
	if (input.added.length === 0) return undefined;
	const groupInfo = signGroupInfo(identity, {
		groupContext: input.state.context,
		extensions: [{ type: ExtensionType.RatchetTree, data: encodeRatchetTree(input.state.tree) }],
		confirmationTag: input.state.confirmationTag,
		signer: input.state.selfLeafIndex,
	});
	const encryptedGroupInfo = encryptGroupInfo(provider, input.secrets.welcomeSecret, groupInfo);
	const pathSecrets = input.createdPath?.secrets.pathSecrets;
	try {
		const encryptedSecrets = input.added.map(member => {
			const pathSecret =
				pathSecrets === undefined
					? undefined
					: requireWelcomePathSecret(input.state.tree, input.state.selfLeafIndex, member.leafIndex, pathSecrets);
			try {
				return Object.freeze({
					newMember: refHash(provider, 'MLS 1.0 KeyPackage Reference', encodeKeyPackage(member.keyPackage)),
					encryptedGroupSecrets: encryptGroupSecrets(provider, member.keyPackage.initKey, encryptedGroupInfo, {
						joinerSecret: input.secrets.joinerSecret,
						pathSecret,
					}),
				});
			} finally {
				pathSecret?.fill(0);
			}
		});
		const welcome: MlsWelcome = {
			cipherSuite: CipherSuite.Dave,
			secrets: encryptedSecrets,
			encryptedGroupInfo,
		};
		return encodeWelcome(welcome);
	} finally {
		zeroBytes(pathSecrets?.values() ?? []);
	}
}

export function processDaveMlsWelcome(
	provider: VoiceCryptoProvider,
	input: ProcessDaveMlsWelcomeInput,
): DaveMlsGroupState {
	const welcome = decodeWelcome(input.encodedWelcome);
	const matchingSecrets = welcome.secrets.filter(secret =>
		equalBytes(secret.newMember, input.joinKeyPackage.reference),
	);
	if (matchingSecrets.length !== 1) {
		throw new TypeError('The DAVE Welcome must contain exactly one entry for the latest KeyPackage.');
	}

	const initSecretKey = input.joinKeyPackage.initSecretKey;
	let groupSecrets: MlsGroupSecrets | undefined;
	let welcomeSecret: Uint8Array | undefined;
	let epochSecrets: Omit<MlsEpochSecrets, 'joinerSecret'> | undefined;
	let privateKeys: Map<number, Uint8Array> | undefined;
	try {
		groupSecrets = decryptGroupSecrets(
			provider,
			initSecretKey,
			welcome.encryptedGroupInfo,
			(matchingSecrets[0] as MlsEncryptedGroupSecrets).encryptedGroupSecrets,
		);
		welcomeSecret = deriveWelcomeSecret(provider, groupSecrets.joinerSecret);
		const groupInfo = decryptGroupInfo(provider, welcomeSecret, welcome.encryptedGroupInfo);
		const tree = readInlineRatchetTree(groupInfo);
		assertDaveGroupContext(provider, groupInfo.groupContext, tree, input.externalSender);
		if (!equalBytes(groupInfo.groupContext.groupId, input.groupId)) {
			throw new TypeError('The DAVE Welcome targets an unexpected MLS group.');
		}
		const signerNode = tree[leafNodeIndex(groupInfo.signer)];
		if (signerNode?.type !== NodeType.Leaf) throw new TypeError('The DAVE GroupInfo signer is not in the roster.');
		if (!verifyGroupInfo(provider, groupInfo, signerNode.leafNode.signatureKey)) {
			throw new TypeError('The DAVE GroupInfo signature is invalid.');
		}
		const selfLeafIndex = findWelcomeLeaf(tree, input.joinKeyPackage.keyPackage.leafNode);
		epochSecrets = deriveEpochSecretsFromJoiner(
			provider,
			groupSecrets.joinerSecret,
			encodeGroupContext(groupInfo.groupContext),
		);
		if (
			!verifyConfirmationTag(
				provider,
				epochSecrets.confirmationKey,
				groupInfo.groupContext.confirmedTranscriptHash,
				groupInfo.confirmationTag,
			)
		) {
			throw new TypeError('The DAVE Welcome confirmation tag is invalid.');
		}
		privateKeys = createWelcomePrivateKeys(
			provider,
			tree,
			selfLeafIndex,
			groupInfo.signer,
			input.joinKeyPackage.leafEncryptionSecretKey,
			groupSecrets.pathSecret,
		);
		const { welcomeSecret: _welcomeSecret, ...stateSecrets } = epochSecrets;
		return DaveMlsGroupState.create(provider, {
			tree,
			selfLeafIndex,
			privateKeys,
			context: groupInfo.groupContext,
			interimTranscriptHash: updateInterimTranscriptHash(
				provider,
				groupInfo.groupContext.confirmedTranscriptHash,
				groupInfo.confirmationTag,
			),
			confirmationTag: groupInfo.confirmationTag,
			secrets: stateSecrets,
		});
	} finally {
		initSecretKey.fill(0);
		groupSecrets?.joinerSecret.fill(0);
		groupSecrets?.pathSecret?.fill(0);
		welcomeSecret?.fill(0);
		if (epochSecrets !== undefined) zeroByteRecord(epochSecrets);
		if (privateKeys !== undefined) clearByteMap(privateKeys);
	}
}

function readInlineRatchetTree(groupInfo: MlsGroupInfo): MlsRatchetTree {
	if (groupInfo.extensions.length !== 1 || groupInfo.extensions[0]?.type !== ExtensionType.RatchetTree) {
		throw new TypeError('A DAVE Welcome GroupInfo must contain exactly one inline ratchet_tree extension.');
	}
	return decodeRatchetTree(groupInfo.extensions[0].data);
}

function findWelcomeLeaf(tree: MlsRatchetTree, leafNode: MlsLeafNode): number {
	const encodedLeaf = encodeLeafNode(leafNode);
	let found: number | undefined;
	for (let nodeIndex = 0; nodeIndex < tree.length; nodeIndex += 2) {
		const node = tree[nodeIndex];
		if (node?.type !== NodeType.Leaf || !equalBytes(encodeLeafNode(node.leafNode), encodedLeaf)) continue;
		if (found !== undefined) throw new TypeError('The DAVE Welcome contains the local KeyPackage leaf more than once.');
		found = leafIndex(nodeIndex);
	}
	if (found === undefined) throw new TypeError('The DAVE Welcome does not contain the local KeyPackage leaf.');
	return found;
}

function createWelcomePrivateKeys(
	provider: VoiceCryptoProvider,
	tree: MlsRatchetTree,
	selfLeafIndex: number,
	signerLeafIndex: number,
	leafSecretKey: Uint8Array,
	pathSecret: Uint8Array | undefined,
): Map<number, Uint8Array> {
	const privateKeys = new Map<number, Uint8Array>([[leafNodeIndex(selfLeafIndex), leafSecretKey]]);
	const sharedPath = sharedDirectPath(tree, selfLeafIndex, signerLeafIndex);
	if (pathSecret === undefined) {
		if (welcomeRequiresPathSecret(tree, selfLeafIndex, sharedPath)) {
			clearByteMap(privateKeys);
			throw new TypeError('The DAVE Welcome is missing the local member path secret.');
		}
		return privateKeys;
	}
	let currentSecret: Uint8Array = pathSecret.slice();
	try {
		for (const nodeIndex of sharedPath) {
			const nodeSecret = deriveSecret(provider, currentSecret, 'node');
			try {
				const keyPair = deriveP256KeyPair(provider, nodeSecret);
				const node = tree[nodeIndex];
				if (node?.type !== NodeType.Parent || !equalBytes(node.parentNode.encryptionKey, keyPair.publicKey)) {
					keyPair.secretKey.fill(0);
					throw new TypeError('The DAVE Welcome path secret does not match the ratchet tree.');
				}
				privateKeys.set(nodeIndex, keyPair.secretKey);
			} finally {
				nodeSecret.fill(0);
			}
			const next = deriveSecret(provider, currentSecret, 'path');
			currentSecret.fill(0);
			currentSecret = next;
		}
		return privateKeys;
	} catch (error) {
		clearByteMap(privateKeys);
		throw error;
	} finally {
		currentSecret.fill(0);
	}
}

function welcomeRequiresPathSecret(
	tree: MlsRatchetTree,
	selfLeafIndex: number,
	sharedPath: readonly number[],
): boolean {
	return sharedPath.some(nodeIndex => {
		const node = tree[nodeIndex];
		return node?.type === NodeType.Parent && !node.parentNode.unmergedLeaves.includes(selfLeafIndex);
	});
}

function requireWelcomePathSecret(
	tree: MlsRatchetTree,
	senderLeafIndex: number,
	newLeafIndex: number,
	pathSecrets: ReadonlyMap<number, Uint8Array>,
): Uint8Array {
	const nodeIndex = sharedDirectPath(tree, senderLeafIndex, newLeafIndex)[0];
	if (nodeIndex === undefined) throw new TypeError('A DAVE Welcome member has no common ancestor with the committer.');
	const secret = pathSecrets.get(nodeIndex);
	if (secret === undefined) throw new TypeError('A DAVE Welcome is missing the new member path secret.');
	return secret.slice();
}

function sharedDirectPath(tree: MlsRatchetTree, leftLeafIndex: number, rightLeafIndex: number): readonly number[] {
	const leafCount = logicalLeafCount(tree);
	const leftPath = directPath(leafNodeIndex(leftLeafIndex), leafCount);
	const rightPath = new Set(directPath(leafNodeIndex(rightLeafIndex), leafCount));
	const firstShared = leftPath.findIndex(nodeIndex => rightPath.has(nodeIndex));
	if (firstShared === -1) return Object.freeze([]);
	return Object.freeze(leftPath.slice(firstShared));
}
