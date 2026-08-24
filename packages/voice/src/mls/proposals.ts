import { bytesToHex, equalBytes } from '../bytes';
import type { VoiceCryptoProvider } from '../crypto/provider';
import { refHash, verifyWithLabel } from './crypto';
import { validateDaveKeyPackage } from './profile';
import {
	ContentType,
	decodeMlsMessage,
	encodeAuthenticatedContent,
	encodeFramedContentTbs,
	type MlsAuthenticatedContent,
	type MlsExternalSender,
	type MlsGroupContext,
	type MlsKeyPackage,
	type MlsProposal,
	type MlsProposalOrRef,
	NodeType,
	ProposalOrRefType,
	ProposalType,
	SenderType,
	splitMlsMessages,
	WireFormat,
} from './protocol';
import { readDaveMlsRoster } from './state';
import { addLeaf, leafNodeIndex, type MlsRatchetTree, removeLeaf } from './tree';

export interface DaveCachedProposal {
	readonly reference: Uint8Array;
	readonly authenticatedContent: MlsAuthenticatedContent;
	readonly proposal: MlsProposal;
	readonly encodedMessage: Uint8Array;
}

export interface AppliedDaveProposals {
	readonly tree: MlsRatchetTree;
	readonly added: readonly {
		readonly leafIndex: number;
		readonly keyPackage: MlsKeyPackage;
		readonly reference: Uint8Array;
	}[];
	readonly removedLeafIndexes: ReadonlySet<number>;
}

export function decodeDaveProposalMessages(
	provider: VoiceCryptoProvider,
	encodedMessages: Uint8Array,
	context: MlsGroupContext,
	externalSender: MlsExternalSender,
	expectedUserIds: ReadonlySet<string>,
): readonly DaveCachedProposal[] {
	const messageBytes = splitMlsMessages(encodedMessages);
	if (messageBytes.length === 0) throw new TypeError('A DAVE proposal append must contain at least one MLS message.');
	return messageBytes.map(encodedMessage => {
		const message = decodeMlsMessage(encodedMessage);
		if (message.wireFormat !== WireFormat.PublicMessage) {
			throw new TypeError('A DAVE proposal must be an MLS PublicMessage.');
		}
		const publicMessage = message.publicMessage;
		const content = publicMessage.content;
		if (content.type !== ContentType.Proposal) throw new TypeError('A DAVE proposal message must contain a Proposal.');
		if (content.sender.type !== SenderType.External || content.sender.senderIndex !== 0) {
			throw new TypeError('A DAVE proposal must be signed by external sender zero.');
		}
		if (!equalBytes(content.groupId, context.groupId) || content.epoch !== context.epoch) {
			throw new TypeError('A DAVE proposal must target the current MLS group and epoch.');
		}
		if (content.authenticatedData.byteLength !== 0) {
			throw new TypeError('DAVE proposal authenticated data must be empty.');
		}
		const authenticatedContent: MlsAuthenticatedContent = {
			wireFormat: WireFormat.PublicMessage,
			content,
			auth: publicMessage.auth,
		};
		if (
			!verifyWithLabel(
				provider,
				externalSender.signatureKey,
				'FramedContentTBS',
				encodeFramedContentTbs(authenticatedContent),
				publicMessage.auth.signature,
			)
		) {
			throw new TypeError('The DAVE external proposal signature is invalid.');
		}
		if (content.proposal.type === ProposalType.Add) {
			const userId = credentialUserId(content.proposal.keyPackage.leafNode.credential.identity);
			if (!expectedUserIds.has(userId)) throw new TypeError('A DAVE Add proposal targets an unrecognized user.');
			validateDaveKeyPackage(provider, content.proposal.keyPackage, userId);
		}
		return Object.freeze({
			reference: refHash(provider, 'MLS 1.0 Proposal Reference', encodeAuthenticatedContent(authenticatedContent)),
			authenticatedContent,
			proposal: content.proposal,
			encodedMessage,
		});
	});
}

export function mergeDaveProposalQueue(
	current: readonly DaveCachedProposal[],
	append: readonly DaveCachedProposal[],
): readonly DaveCachedProposal[] {
	const references = new Set(current.map(proposal => bytesToHex(proposal.reference)));
	const merged = [...current];
	for (const proposal of append) {
		const key = bytesToHex(proposal.reference);
		if (references.has(key)) throw new TypeError('A DAVE ProposalRef cannot be queued more than once.');
		references.add(key);
		merged.push(proposal);
	}
	return Object.freeze(merged);
}

export function revokeDaveProposals(
	current: readonly DaveCachedProposal[],
	references: readonly Uint8Array[],
): readonly DaveCachedProposal[] {
	const revoked = new Set<string>();
	for (const reference of references) {
		if (reference.byteLength !== 32) throw new TypeError('A DAVE ProposalRef must contain 32 bytes.');
		const key = bytesToHex(reference);
		if (revoked.has(key)) throw new TypeError('A DAVE proposal revocation cannot repeat a ProposalRef.');
		if (!current.some(proposal => equalBytes(proposal.reference, reference))) {
			throw new TypeError('A DAVE proposal revocation contains an unknown ProposalRef.');
		}
		revoked.add(key);
	}
	return Object.freeze(current.filter(proposal => !revoked.has(bytesToHex(proposal.reference))));
}

export function applyDaveProposals(
	provider: VoiceCryptoProvider,
	tree: MlsRatchetTree,
	proposals: readonly DaveCachedProposal[],
	groupId: Uint8Array,
): AppliedDaveProposals {
	if (proposals.length === 0) throw new TypeError('A DAVE commit must reference at least one proposal.');
	const removedLeafIndexes = new Set<number>();
	for (const { proposal } of proposals) {
		if (proposal.type !== ProposalType.Remove) continue;
		if (removedLeafIndexes.has(proposal.removed)) {
			throw new TypeError('A DAVE commit cannot remove the same leaf more than once.');
		}
		const node = tree[leafNodeIndex(proposal.removed)];
		if (node?.type !== NodeType.Leaf) throw new TypeError('A DAVE Remove proposal targets a blank leaf.');
		removedLeafIndexes.add(proposal.removed);
	}

	let updatedTree = tree;
	for (const leafIndex of removedLeafIndexes) updatedTree = removeLeaf(updatedTree, leafIndex);
	const added: Array<{ leafIndex: number; keyPackage: MlsKeyPackage; reference: Uint8Array }> = [];
	for (const { proposal, reference } of proposals) {
		if (proposal.type !== ProposalType.Add) continue;
		const result = addLeaf(updatedTree, proposal.keyPackage.leafNode);
		updatedTree = result.tree;
		added.push(Object.freeze({ leafIndex: result.leafIndex, keyPackage: proposal.keyPackage, reference }));
	}

	readDaveMlsRoster(provider, updatedTree, groupId);
	return Object.freeze({
		tree: updatedTree,
		added: Object.freeze(added),
		removedLeafIndexes,
	});
}

export function proposalReferences(proposals: readonly DaveCachedProposal[]): readonly MlsProposalOrRef[] {
	return proposals.map(proposal => Object.freeze({ type: ProposalOrRefType.Reference, reference: proposal.reference }));
}

function credentialUserId(identity: Uint8Array): string {
	if (identity.byteLength !== 8) throw new TypeError('A DAVE credential identity must contain 8 bytes.');
	const value = new DataView(identity.buffer, identity.byteOffset, identity.byteLength).getBigUint64(0);
	if (value === 0n) throw new TypeError('A DAVE credential identity cannot be zero.');
	return value.toString();
}
