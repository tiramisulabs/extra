import { describe, expect, test } from 'vitest';
import { equalBytes } from '../src/bytes';
import { VoiceCryptoProvider } from '../src/crypto/provider';
import { refHash, signWithLabel } from '../src/mls/crypto';
import {
	computeMembershipTag,
	createExternalProposalPublicMessage,
	createSignedMemberCommit,
	decryptGroupInfo,
	decryptGroupSecrets,
	encryptGroupInfo,
	encryptGroupSecrets,
	finalizeMemberCommitPublicMessage,
	type MlsSigner,
	proposalReference,
	signGroupInfo,
	verifyExternalProposalPublicMessage,
	verifyGroupInfo,
	verifyMemberCommitPublicMessage,
	verifyMembershipTag,
} from '../src/mls/handshake';
import { deriveWelcomeSecret } from '../src/mls/key-schedule';
import {
	CipherSuite,
	decodeMlsMessage,
	encodeAuthenticatedContent,
	encodeKeyPackage,
	type MlsGroupContext,
	type MlsGroupInfoTbs,
	type MlsPublicMessage,
	ProposalType,
	ProtocolVersion,
	SenderType,
	WireFormat,
} from '../src/mls/protocol';

const GROUP_ID = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8);

describe('MLS handshake protection', () => {
	test('creates and verifies an external proposal and hashes its exact AuthenticatedContent', () => {
		const provider = new VoiceCryptoProvider();
		const keyPair = provider.generateP256KeyPair();
		const signer = createSigner(provider, keyPair.secretKey);
		const message = createExternalProposalPublicMessage(signer, {
			groupId: GROUP_ID,
			epoch: 7n,
			senderIndex: 0,
			proposal: { type: ProposalType.Remove, removed: 3 },
			authenticatedData: Uint8Array.of(9, 8, 7),
		});

		const authenticatedContent = verifyExternalProposalPublicMessage(provider, message, keyPair.publicKey);
		expect(message.membershipTag).toBeUndefined();
		expect(message.auth.confirmationTag).toBeUndefined();
		expect(authenticatedContent).toEqual({
			wireFormat: WireFormat.PublicMessage,
			content: message.content,
			auth: message.auth,
		});
		expect(proposalReference(provider, authenticatedContent)).toEqual(
			refHash(provider, 'MLS 1.0 Proposal Reference', encodeAuthenticatedContent(authenticatedContent)),
		);
		keyPair.secretKey.fill(0);
	});

	test('rejects malformed or unauthenticated external proposal messages', () => {
		const provider = new VoiceCryptoProvider();
		const keyPair = provider.generateP256KeyPair();
		const message = createExternalProposalPublicMessage(createSigner(provider, keyPair.secretKey), {
			groupId: GROUP_ID,
			epoch: 0n,
			senderIndex: 0,
			proposal: { type: ProposalType.Remove, removed: 1 },
		});

		expect(() =>
			verifyExternalProposalPublicMessage(
				provider,
				{ ...message, auth: { signature: flipFirstByte(message.auth.signature) } },
				keyPair.publicKey,
			),
		).toThrow('signature is invalid');
		expect(() =>
			verifyExternalProposalPublicMessage(
				provider,
				{ ...message, membershipTag: new Uint8Array(32) },
				keyPair.publicKey,
			),
		).toThrow('cannot contain');
		expect(() =>
			verifyExternalProposalPublicMessage(
				provider,
				{ ...message, auth: { ...message.auth, confirmationTag: new Uint8Array(32) } },
				keyPair.publicKey,
			),
		).toThrow('cannot contain');
		const memberMessage = {
			...message,
			content: { ...message.content, sender: { type: SenderType.Member, leafIndex: 0 } },
		} as MlsPublicMessage;
		expect(() => verifyExternalProposalPublicMessage(provider, memberMessage, keyPair.publicKey)).toThrow(
			'external proposal sender',
		);
		keyPair.secretKey.fill(0);
	});

	test('signs, finalizes, and verifies a member commit using old-epoch membership protection', () => {
		const provider = new VoiceCryptoProvider();
		const keyPair = provider.generateP256KeyPair();
		const groupContext = createGroupContext();
		const membershipKey = provider.randomBytes(32);
		const confirmationTag = provider.randomBytes(32);
		const signed = createSignedMemberCommit(createSigner(provider, keyPair.secretKey), {
			groupContext,
			leafIndex: 2,
			commit: { proposals: [], path: undefined },
			authenticatedData: Uint8Array.of(4, 5, 6),
		});
		const message = finalizeMemberCommitPublicMessage(provider, signed, groupContext, confirmationTag, membershipKey);

		const authenticatedContent = verifyMemberCommitPublicMessage(
			provider,
			message,
			groupContext,
			keyPair.publicKey,
			membershipKey,
		);
		expect(authenticatedContent.auth.confirmationTag).toEqual(confirmationTag);
		expect(message.membershipTag).toEqual(
			computeMembershipTag(provider, membershipKey, authenticatedContent, groupContext),
		);
		const membershipTag = message.membershipTag;
		if (membershipTag === undefined) throw new Error('Expected a member membership tag.');
		expect(verifyMembershipTag(provider, membershipKey, authenticatedContent, groupContext, membershipTag)).toBe(true);
		keyPair.secretKey.fill(0);
		membershipKey.fill(0);
		confirmationTag.fill(0);
	});

	test('rejects member commits with stale context, invalid signatures, or invalid tags', () => {
		const provider = new VoiceCryptoProvider();
		const keyPair = provider.generateP256KeyPair();
		const groupContext = createGroupContext();
		const membershipKey = provider.randomBytes(32);
		const signed = createSignedMemberCommit(createSigner(provider, keyPair.secretKey), {
			groupContext,
			leafIndex: 0,
			commit: { proposals: [], path: undefined },
		});
		const message = finalizeMemberCommitPublicMessage(
			provider,
			signed,
			groupContext,
			provider.randomBytes(32),
			membershipKey,
		);
		const verify = (candidate: MlsPublicMessage, context = groupContext) =>
			verifyMemberCommitPublicMessage(provider, candidate, context, keyPair.publicKey, membershipKey);
		const membershipTag = message.membershipTag;
		if (membershipTag === undefined) throw new Error('Expected a member membership tag.');

		expect(() => verify({ ...message, membershipTag: undefined })).toThrow('requires a membership tag');
		expect(() => verify({ ...message, auth: { signature: message.auth.signature } })).toThrow(
			'requires a confirmation tag',
		);
		expect(() => verify({ ...message, auth: { ...message.auth, confirmationTag: new Uint8Array(31) } })).toThrow(
			'confirmation tag',
		);
		expect(() => verify({ ...message, membershipTag: new Uint8Array(31) })).toThrow('membership tag is invalid');
		expect(() => verify({ ...message, membershipTag: flipFirstByte(membershipTag) })).toThrow(
			'membership tag is invalid',
		);
		const badSignature = { ...message, auth: { ...message.auth, signature: flipFirstByte(message.auth.signature) } };
		const badSignatureContent = {
			wireFormat: WireFormat.PublicMessage,
			content: badSignature.content,
			auth: badSignature.auth,
		} as const;
		const badSignatureWithValidMembership = {
			...badSignature,
			membershipTag: computeMembershipTag(provider, membershipKey, badSignatureContent, groupContext),
		};
		expect(() => verify(badSignatureWithValidMembership)).toThrow('signature is invalid');
		expect(() => verify(message, { ...groupContext, epoch: groupContext.epoch + 1n })).toThrow('current GroupContext');
		expect(
			verifyMembershipTag(
				provider,
				membershipKey,
				badSignatureContent,
				{ ...groupContext, epoch: groupContext.epoch + 1n },
				badSignatureWithValidMembership.membershipTag,
			),
		).toBe(false);
		expect(() =>
			finalizeMemberCommitPublicMessage(provider, signed, groupContext, new Uint8Array(31), membershipKey),
		).toThrow('confirmation tag');
		expect(() =>
			finalizeMemberCommitPublicMessage(
				provider,
				{ ...signed, wireFormat: WireFormat.GroupInfo } as unknown as typeof signed,
				groupContext,
				provider.randomBytes(32),
				membershipKey,
			),
		).toThrow('PublicMessage wire format');
		expect(() => computeMembershipTag(provider, new Uint8Array(31), badSignatureContent, groupContext)).toThrow(
			'membership key',
		);
		keyPair.secretKey.fill(0);
		membershipKey.fill(0);
	});

	test('rejects ProposalRef for non-proposal authenticated content', () => {
		const provider = new VoiceCryptoProvider();
		const keyPair = provider.generateP256KeyPair();
		const groupContext = createGroupContext();
		const signed = createSignedMemberCommit(createSigner(provider, keyPair.secretKey), {
			groupContext,
			leafIndex: 0,
			commit: { proposals: [], path: undefined },
		});
		const message = finalizeMemberCommitPublicMessage(
			provider,
			signed,
			groupContext,
			provider.randomBytes(32),
			provider.randomBytes(32),
		);
		expect(() =>
			proposalReference(provider, {
				wireFormat: WireFormat.PublicMessage,
				content: message.content,
				auth: message.auth,
			}),
		).toThrow('requires authenticated proposal');
		keyPair.secretKey.fill(0);
	});
});

describe('MLS GroupInfo and Welcome protection', () => {
	test('signs and verifies GroupInfo over every TBS field', () => {
		const provider = new VoiceCryptoProvider();
		const keyPair = provider.generateP256KeyPair();
		const groupInfo = signGroupInfo(createSigner(provider, keyPair.secretKey), createGroupInfo());

		expect(verifyGroupInfo(provider, groupInfo, keyPair.publicKey)).toBe(true);
		expect(verifyGroupInfo(provider, { ...groupInfo, signer: groupInfo.signer + 1 }, keyPair.publicKey)).toBe(false);
		expect(
			verifyGroupInfo(provider, { ...groupInfo, signature: flipFirstByte(groupInfo.signature) }, keyPair.publicKey),
		).toBe(false);
		expect(verifyGroupInfo(provider, { ...groupInfo, confirmationTag: new Uint8Array(31) }, keyPair.publicKey)).toBe(
			false,
		);
		expect(
			verifyGroupInfo(
				provider,
				{
					...groupInfo,
					groupContext: { ...groupInfo.groupContext, version: 2 } as unknown as typeof groupInfo.groupContext,
				},
				keyPair.publicKey,
			),
		).toBe(false);
		keyPair.secretKey.fill(0);
	});

	test('encrypts GroupInfo and GroupSecrets and rejects key, context, and ciphertext tampering', () => {
		const provider = new VoiceCryptoProvider();
		const signerKeyPair = provider.generateP256KeyPair();
		const initKeyPair = provider.generateP256KeyPair();
		const groupInfo = signGroupInfo(createSigner(provider, signerKeyPair.secretKey), createGroupInfo());
		const welcomeSecret = provider.randomBytes(32);
		const groupSecrets = {
			joinerSecret: provider.randomBytes(32),
			pathSecret: provider.randomBytes(32),
		};
		const encryptedGroupInfo = encryptGroupInfo(provider, welcomeSecret, groupInfo);
		const encryptedGroupSecrets = encryptGroupSecrets(
			provider,
			initKeyPair.publicKey,
			encryptedGroupInfo,
			groupSecrets,
		);

		expect(decryptGroupInfo(provider, welcomeSecret, encryptedGroupInfo)).toEqual(groupInfo);
		expect(decryptGroupSecrets(provider, initKeyPair.secretKey, encryptedGroupInfo, encryptedGroupSecrets)).toEqual(
			groupSecrets,
		);
		const wrongWelcomeSecret = provider.randomBytes(32);
		expect(() => decryptGroupInfo(provider, wrongWelcomeSecret, encryptedGroupInfo)).toThrow();
		expect(() => decryptGroupInfo(provider, welcomeSecret, flipFirstByte(encryptedGroupInfo))).toThrow();
		expect(() =>
			decryptGroupSecrets(provider, initKeyPair.secretKey, Uint8Array.of(1), encryptedGroupSecrets),
		).toThrow();
		expect(() =>
			decryptGroupSecrets(provider, initKeyPair.secretKey, encryptedGroupInfo, {
				...encryptedGroupSecrets,
				ciphertext: flipFirstByte(encryptedGroupSecrets.ciphertext),
			}),
		).toThrow();
		const wrongInitKeyPair = provider.generateP256KeyPair();
		expect(() =>
			decryptGroupSecrets(provider, wrongInitKeyPair.secretKey, encryptedGroupInfo, encryptedGroupSecrets),
		).toThrow();
		expect(() =>
			encryptGroupSecrets(provider, initKeyPair.publicKey, encryptedGroupInfo, {
				...groupSecrets,
				joinerSecret: new Uint8Array(31),
			}),
		).toThrow('joiner secret');
		expect(() => encryptGroupInfo(provider, new Uint8Array(31), groupInfo)).toThrow('welcome secret');
		signerKeyPair.secretKey.fill(0);
		initKeyPair.secretKey.fill(0);
		wrongInitKeyPair.secretKey.fill(0);
		welcomeSecret.fill(0);
		wrongWelcomeSecret.fill(0);
		groupSecrets.joinerSecret.fill(0);
		groupSecrets.pathSecret.fill(0);
	});

	test('decrypts and verifies the official MLS ciphersuite 2 Welcome vector', () => {
		const provider = new VoiceCryptoProvider();
		const welcomeMessage = decodeMlsMessage(hex(OFFICIAL_WELCOME));
		const keyPackageMessage = decodeMlsMessage(hex(OFFICIAL_KEY_PACKAGE));
		if (welcomeMessage.wireFormat !== WireFormat.Welcome) throw new Error('Expected a Welcome vector.');
		if (keyPackageMessage.wireFormat !== WireFormat.KeyPackage) throw new Error('Expected a KeyPackage vector.');
		const reference = refHash(provider, 'MLS 1.0 KeyPackage Reference', encodeKeyPackage(keyPackageMessage.keyPackage));
		const encryptedSecrets = welcomeMessage.welcome.secrets.find(entry => equalBytes(entry.newMember, reference));
		if (encryptedSecrets === undefined) throw new Error('Welcome did not reference the test KeyPackage.');

		const groupSecrets = decryptGroupSecrets(
			provider,
			hex(OFFICIAL_INIT_SECRET_KEY),
			welcomeMessage.welcome.encryptedGroupInfo,
			encryptedSecrets.encryptedGroupSecrets,
		);
		const welcomeSecret = deriveWelcomeSecret(provider, groupSecrets.joinerSecret);
		const groupInfo = decryptGroupInfo(provider, welcomeSecret, welcomeMessage.welcome.encryptedGroupInfo);

		expect(verifyGroupInfo(provider, groupInfo, hex(OFFICIAL_SIGNER_PUBLIC_KEY))).toBe(true);
		expect(groupInfo.groupContext.cipherSuite).toBe(CipherSuite.Dave);
		expect(groupSecrets.joinerSecret).toHaveLength(32);
		welcomeSecret.fill(0);
		groupSecrets.joinerSecret.fill(0);
		groupSecrets.pathSecret?.fill(0);
	});
});

function createSigner(provider: VoiceCryptoProvider, secretKey: Uint8Array): MlsSigner {
	return { sign: (label, content) => signWithLabel(provider, secretKey, label, content) };
}

function createGroupContext(): MlsGroupContext {
	return {
		version: ProtocolVersion.Mls10,
		cipherSuite: CipherSuite.Dave,
		groupId: GROUP_ID,
		epoch: 4n,
		treeHash: Uint8Array.from({ length: 32 }, (_, index) => index),
		confirmedTranscriptHash: Uint8Array.from({ length: 32 }, (_, index) => 255 - index),
		extensions: [],
	};
}

function createGroupInfo(): MlsGroupInfoTbs {
	return {
		groupContext: createGroupContext(),
		extensions: [{ type: 0x0a0a, data: Uint8Array.of(1, 2, 3) }],
		confirmationTag: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
		signer: 2,
	};
}

function flipFirstByte(value: Uint8Array): Uint8Array {
	const output = value.slice();
	output[0] = (output[0] as number) ^ 1;
	return output;
}

function hex(value: string): Uint8Array {
	return Uint8Array.from(Buffer.from(value, 'hex'));
}

const OFFICIAL_INIT_SECRET_KEY = '0c627e5642c6a01adb63f130222b66eea352ebe47b85dfef57d123f7d17fcaf7';
const OFFICIAL_SIGNER_PUBLIC_KEY =
	'04b8d619186ae6aad30a2705941f354e317df3d83aba604c8a852d3db3c08e6cc7a226bcc5ec72be698727b3e27fd39f6fe4a624c3064d99f3967731b22fbfe330';
const OFFICIAL_KEY_PACKAGE =
	'00010005000100024041049e8568620803fb6a37c3167e2e6df927a58e46905aa339d067fa05d9bfb33d6bb22250f44c24bf8441f1924f60f7f281236de1c99c98cbb8ca1f5a26edf286e04041045b2f23e87fdd51c407478878689f647cfeca1e6ddf13bab8315af9485d124943fd297144d1934525ed49397628b2ead0e6bc6e51aa1be12cf1b7c9f24765966f4041041ff15b03864ec390007b543c6e244468a46dcc57378d468722a267db7371c49cb0a9a2e32e864f292b25c29674d7edc37d637edbdf9b41ac8904dd8ca4ee77f1000120b640fbb0df8e646b29c83c5ed08aea89f72ab108922827ea76cd3b917d6d99420200010c00010002000300040005000600000400010002010000000000000000ffffffffffffffff0040483046022100a1168a2d80fb099aba2f983c5c3e344127f0d57e4b57b841ec2dfacdd1be629602210099422833715ad86ed402557d453e359f4c7c7a87dc2438f514047d6fcfb0b31a0040473045022100d973500369913a17440a0491c6119a50e0911d175b588f0cfde3ff41274aa9f5022043e06b3f7c32f2a40f68802b87743d6e1b0828efcedd182fe6363b45f9656e19';
const OFFICIAL_WELCOME =
	'000100030002409820e25365e70ce3dc73d96d38ff1969f3488e9999ab81403e26437c9332bf0f878d404104d0d237907f851105d0317a02e3bc53006a0632d1e36398d511cc9b8a0847d4397276473fe7183c7c997de9ccd5500d82735c179e03db75cacc82129c37dc796133a9331de12bd6fe7c212b6ade3b2967feff8ed72b1dfbad54b07d7a9c13c9afe00c1c47186af40b33a07670827404f7cd99e86e40ef0bee12b48b86d125155b035f52e8a131469cf1b9645d70e270d3aa21c04945fa80b7fea30ccfceb436e4df23558cdc1a6cd435db3199314795b7c488b4bf0855cb589ad9c7eb43ea8bc9edef6b85ad1c97451b706e5de27aabe664dca132a288b3fc091b9100e470fb506833aaa4ab279a4480b6e01e9d9b502537197c129b98aacbc52a7a440844c4fb153bf0ec32629eca3bf038cd2e89226e953f2cb36171d9f86df078e5bb12fabb90da79deac8a207986089add4da2dd2ad9c7bb5407c80fd1e0e89ece6c328ee9bf27e79a56961e794b4b85d01befdde8e4255a80a62e58ac2b668485b9b3876afdc51e5a63';
