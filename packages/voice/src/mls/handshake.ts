import { equalBytes } from '../bytes';
import type { VoiceCryptoProvider } from '../crypto/provider';
import {
	decryptWithLabel,
	encryptWithLabel,
	expandWithLabel,
	mac,
	refHash,
	verifyMac,
	verifyWithLabel,
} from './crypto';
import {
	ContentType,
	decodeGroupInfo,
	decodeGroupSecrets,
	encodeAuthenticatedContent,
	encodeAuthenticatedContentTbm,
	encodeFramedContentTbs,
	encodeGroupInfo,
	encodeGroupInfoTbs,
	encodeGroupSecrets,
	type MlsAuthenticatedContent,
	type MlsCommit,
	type MlsFramedContent,
	type MlsFramedContentTbs,
	type MlsGroupContext,
	type MlsGroupInfo,
	type MlsGroupInfoTbs,
	type MlsGroupSecrets,
	type MlsHpkeCiphertext,
	type MlsProposal,
	type MlsPublicMessage,
	SenderType,
	WireFormat,
} from './protocol';

const EMPTY = new Uint8Array();
const HASH_LENGTH = 32;

export interface MlsSigner {
	sign(label: string, content: Uint8Array): Uint8Array;
}

export interface ExternalProposalPublicMessageInput {
	readonly groupId: Uint8Array;
	readonly epoch: bigint;
	readonly senderIndex: number;
	readonly proposal: MlsProposal;
	readonly authenticatedData?: Uint8Array;
}

export interface MemberCommitInput {
	readonly groupContext: MlsGroupContext;
	readonly leafIndex: number;
	readonly commit: MlsCommit;
	readonly authenticatedData?: Uint8Array;
}

export interface MlsSignedMemberCommit {
	readonly wireFormat: typeof WireFormat.PublicMessage;
	readonly content: Extract<MlsFramedContent, { readonly type: typeof ContentType.Commit }>;
	readonly signature: Uint8Array;
}

export function createExternalProposalPublicMessage(
	signer: MlsSigner,
	input: ExternalProposalPublicMessageInput,
): MlsPublicMessage {
	const content: Extract<MlsFramedContent, { readonly type: typeof ContentType.Proposal }> = {
		groupId: input.groupId,
		epoch: input.epoch,
		sender: { type: SenderType.External, senderIndex: input.senderIndex },
		authenticatedData: input.authenticatedData ?? EMPTY,
		type: ContentType.Proposal,
		proposal: input.proposal,
	};
	const framedContentTbs: MlsFramedContentTbs = { wireFormat: WireFormat.PublicMessage, content };
	return {
		content,
		auth: { signature: signer.sign('FramedContentTBS', encodeFramedContentTbs(framedContentTbs)) },
	};
}

export function verifyExternalProposalPublicMessage(
	provider: VoiceCryptoProvider,
	message: MlsPublicMessage,
	signatureKey: Uint8Array,
): MlsAuthenticatedContent {
	if (message.content.sender.type !== SenderType.External || message.content.type !== ContentType.Proposal) {
		throw new TypeError('An MLS external proposal PublicMessage requires an external proposal sender.');
	}
	if (message.auth.confirmationTag !== undefined || message.membershipTag !== undefined) {
		throw new TypeError('An MLS external proposal PublicMessage cannot contain confirmation or membership tags.');
	}
	const authenticatedContent = toAuthenticatedContent(message);
	if (
		!verifyWithLabel(
			provider,
			signatureKey,
			'FramedContentTBS',
			encodeFramedContentTbs(authenticatedContent),
			message.auth.signature,
		)
	) {
		throw new TypeError('The MLS external proposal signature is invalid.');
	}
	return authenticatedContent;
}

export function createSignedMemberCommit(signer: MlsSigner, input: MemberCommitInput): MlsSignedMemberCommit {
	const content: Extract<MlsFramedContent, { readonly type: typeof ContentType.Commit }> = {
		groupId: input.groupContext.groupId,
		epoch: input.groupContext.epoch,
		sender: { type: SenderType.Member, leafIndex: input.leafIndex },
		authenticatedData: input.authenticatedData ?? EMPTY,
		type: ContentType.Commit,
		commit: input.commit,
	};
	const framedContentTbs: MlsFramedContentTbs = { wireFormat: WireFormat.PublicMessage, content };
	return {
		wireFormat: WireFormat.PublicMessage,
		content,
		signature: signer.sign('FramedContentTBS', encodeFramedContentTbs(framedContentTbs, input.groupContext)),
	};
}

export function finalizeMemberCommitPublicMessage(
	provider: VoiceCryptoProvider,
	signedCommit: MlsSignedMemberCommit,
	groupContext: MlsGroupContext,
	confirmationTag: Uint8Array,
	membershipKey: Uint8Array,
): MlsPublicMessage {
	if (signedCommit.wireFormat !== WireFormat.PublicMessage) {
		throw new TypeError('An MLS signed member commit must use the PublicMessage wire format.');
	}
	assertMemberCommitContext(signedCommit.content, groupContext);
	assertHashLength(confirmationTag, 'MLS confirmation tag');
	const authenticatedContent: MlsAuthenticatedContent = {
		wireFormat: WireFormat.PublicMessage,
		content: signedCommit.content,
		auth: { signature: signedCommit.signature, confirmationTag },
	};
	return {
		content: authenticatedContent.content,
		auth: authenticatedContent.auth,
		membershipTag: computeMembershipTag(provider, membershipKey, authenticatedContent, groupContext),
	};
}

export function verifyMemberCommitPublicMessage(
	provider: VoiceCryptoProvider,
	message: MlsPublicMessage,
	groupContext: MlsGroupContext,
	signatureKey: Uint8Array,
	membershipKey: Uint8Array,
): MlsAuthenticatedContent {
	if (message.content.sender.type !== SenderType.Member || message.content.type !== ContentType.Commit) {
		throw new TypeError('An MLS member commit PublicMessage requires a member commit sender.');
	}
	assertMemberCommitContext(message.content, groupContext);
	if (message.auth.confirmationTag === undefined) {
		throw new TypeError('An MLS member commit PublicMessage requires a confirmation tag.');
	}
	assertHashLength(message.auth.confirmationTag, 'MLS confirmation tag');
	if (message.membershipTag === undefined) {
		throw new TypeError('An MLS member commit PublicMessage requires a membership tag.');
	}
	const authenticatedContent = toAuthenticatedContent(message);
	if (!verifyMembershipTag(provider, membershipKey, authenticatedContent, groupContext, message.membershipTag)) {
		throw new TypeError('The MLS member commit membership tag is invalid.');
	}
	if (
		!verifyWithLabel(
			provider,
			signatureKey,
			'FramedContentTBS',
			encodeFramedContentTbs(authenticatedContent, groupContext),
			message.auth.signature,
		)
	) {
		throw new TypeError('The MLS member commit signature is invalid.');
	}
	return authenticatedContent;
}

export function proposalReference(
	provider: VoiceCryptoProvider,
	authenticatedContent: MlsAuthenticatedContent,
): Uint8Array {
	if (authenticatedContent.content.type !== ContentType.Proposal) {
		throw new TypeError('An MLS ProposalRef requires authenticated proposal content.');
	}
	return refHash(provider, 'MLS 1.0 Proposal Reference', encodeAuthenticatedContent(authenticatedContent));
}

export function computeMembershipTag(
	provider: VoiceCryptoProvider,
	membershipKey: Uint8Array,
	authenticatedContent: MlsAuthenticatedContent,
	groupContext: MlsGroupContext,
): Uint8Array {
	assertHashLength(membershipKey, 'MLS membership key');
	if (authenticatedContent.content.sender.type !== SenderType.Member) {
		throw new TypeError('An MLS membership tag can only protect member content.');
	}
	assertMemberContentContext(authenticatedContent.content, groupContext);
	return mac(provider, membershipKey, encodeAuthenticatedContentTbm(authenticatedContent, groupContext));
}

export function verifyMembershipTag(
	provider: VoiceCryptoProvider,
	membershipKey: Uint8Array,
	authenticatedContent: MlsAuthenticatedContent,
	groupContext: MlsGroupContext,
	membershipTag: Uint8Array,
): boolean {
	if (membershipKey.byteLength !== HASH_LENGTH || membershipTag.byteLength !== HASH_LENGTH) return false;
	try {
		if (authenticatedContent.content.sender.type !== SenderType.Member) return false;
		assertMemberContentContext(authenticatedContent.content, groupContext);
		return verifyMac(
			provider,
			membershipKey,
			encodeAuthenticatedContentTbm(authenticatedContent, groupContext),
			membershipTag,
		);
	} catch {
		return false;
	}
}

export function signGroupInfo(signer: MlsSigner, groupInfo: MlsGroupInfoTbs): MlsGroupInfo {
	assertHashLength(groupInfo.confirmationTag, 'MLS GroupInfo confirmation tag');
	return {
		...groupInfo,
		signature: signer.sign('GroupInfoTBS', encodeGroupInfoTbs(groupInfo)),
	};
}

export function verifyGroupInfo(
	provider: VoiceCryptoProvider,
	groupInfo: MlsGroupInfo,
	signatureKey: Uint8Array,
): boolean {
	if (groupInfo.confirmationTag.byteLength !== HASH_LENGTH) return false;
	try {
		return verifyWithLabel(provider, signatureKey, 'GroupInfoTBS', encodeGroupInfoTbs(groupInfo), groupInfo.signature);
	} catch {
		return false;
	}
}

export function encryptGroupInfo(
	provider: VoiceCryptoProvider,
	welcomeSecret: Uint8Array,
	groupInfo: MlsGroupInfo,
): Uint8Array {
	assertHashLength(welcomeSecret, 'MLS welcome secret');
	const { key, nonce } = deriveWelcomeKeyNonceFromSecret(provider, welcomeSecret);
	try {
		return provider.aesGcmSeal(key, nonce, EMPTY, encodeGroupInfo(groupInfo));
	} finally {
		key.fill(0);
		nonce.fill(0);
	}
}

export function decryptGroupInfo(
	provider: VoiceCryptoProvider,
	welcomeSecret: Uint8Array,
	encryptedGroupInfo: Uint8Array,
): MlsGroupInfo {
	assertHashLength(welcomeSecret, 'MLS welcome secret');
	const { key, nonce } = deriveWelcomeKeyNonceFromSecret(provider, welcomeSecret);
	let encodedGroupInfo: Uint8Array | undefined;
	try {
		encodedGroupInfo = provider.aesGcmOpen(key, nonce, EMPTY, encryptedGroupInfo);
		return decodeGroupInfo(encodedGroupInfo);
	} finally {
		key.fill(0);
		nonce.fill(0);
		encodedGroupInfo?.fill(0);
	}
}

export function encryptGroupSecrets(
	provider: VoiceCryptoProvider,
	initKey: Uint8Array,
	encryptedGroupInfo: Uint8Array,
	groupSecrets: MlsGroupSecrets,
): MlsHpkeCiphertext {
	assertGroupSecrets(groupSecrets);
	const encodedGroupSecrets = encodeGroupSecrets(groupSecrets);
	try {
		return encryptWithLabel(provider, initKey, 'Welcome', encryptedGroupInfo, encodedGroupSecrets);
	} finally {
		encodedGroupSecrets.fill(0);
	}
}

export function decryptGroupSecrets(
	provider: VoiceCryptoProvider,
	initSecretKey: Uint8Array,
	encryptedGroupInfo: Uint8Array,
	encryptedGroupSecrets: MlsHpkeCiphertext,
): MlsGroupSecrets {
	const encodedGroupSecrets = decryptWithLabel(
		provider,
		initSecretKey,
		'Welcome',
		encryptedGroupInfo,
		encryptedGroupSecrets.kemOutput,
		encryptedGroupSecrets.ciphertext,
	);
	try {
		const groupSecrets = decodeGroupSecrets(encodedGroupSecrets);
		assertGroupSecrets(groupSecrets);
		return groupSecrets;
	} finally {
		encodedGroupSecrets.fill(0);
	}
}

function toAuthenticatedContent(message: MlsPublicMessage): MlsAuthenticatedContent {
	return {
		wireFormat: WireFormat.PublicMessage,
		content: message.content,
		auth: message.auth,
	};
}

function assertMemberCommitContext(
	content: Extract<MlsFramedContent, { readonly type: typeof ContentType.Commit }>,
	groupContext: MlsGroupContext,
): void {
	if (content.sender.type !== SenderType.Member) {
		throw new TypeError('An MLS member commit requires a member sender.');
	}
	assertMemberContentContext(content, groupContext);
}

function assertMemberContentContext(content: MlsFramedContent, groupContext: MlsGroupContext): void {
	if (content.epoch === groupContext.epoch && equalBytes(content.groupId, groupContext.groupId)) return;
	throw new TypeError('The MLS member content does not match the current GroupContext.');
}

function deriveWelcomeKeyNonceFromSecret(
	provider: VoiceCryptoProvider,
	welcomeSecret: Uint8Array,
): { readonly key: Uint8Array; readonly nonce: Uint8Array } {
	return {
		key: expandWithLabel(provider, welcomeSecret, 'key', EMPTY, 16),
		nonce: expandWithLabel(provider, welcomeSecret, 'nonce', EMPTY, 12),
	};
}

function assertGroupSecrets(groupSecrets: MlsGroupSecrets): void {
	assertHashLength(groupSecrets.joinerSecret, 'MLS joiner secret');
	if (groupSecrets.pathSecret !== undefined) assertHashLength(groupSecrets.pathSecret, 'MLS path secret');
}

function assertHashLength(value: Uint8Array, name: string): void {
	if (value.byteLength === HASH_LENGTH) return;
	throw new TypeError(`${name} must contain ${HASH_LENGTH} bytes.`);
}
