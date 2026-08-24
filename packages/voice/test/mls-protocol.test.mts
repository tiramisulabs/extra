import { describe, expect, test } from 'vitest';
import { concatenateBytes as concatenate } from '../src/bytes';
import {
	CipherSuite,
	ContentType,
	CredentialType,
	decodeCommit,
	decodeCredential,
	decodeExternalSenders,
	decodeGroupInfo,
	decodeGroupSecrets,
	decodeMlsMessage,
	decodeMlsMessages,
	decodeRatchetTree,
	ExtensionType,
	encodeAuthenticatedContent,
	encodeConfirmedTranscriptHashInput,
	encodeExternalSenders,
	encodeFramedContent,
	encodeGroupInfo,
	encodeGroupInfoTbs,
	encodeGroupSecrets,
	encodeInterimTranscriptHashInput,
	encodeKeyPackageTbs,
	encodeLeafNode,
	encodeLeafNodeTbs,
	encodeMlsMessage,
	encodeMlsMessages,
	encodeParentNode,
	encodePublicMessage,
	encodeRatchetTree,
	LeafNodeSource,
	type MlsAuthenticatedContent,
	type MlsExternalSender,
	type MlsFramedContent,
	type MlsGroupInfo,
	type MlsKeyPackage,
	type MlsLeafNode,
	type MlsMessage,
	type MlsNode,
	NodeType,
	ProposalOrRefType,
	ProposalType,
	ProtocolVersion,
	SenderType,
	splitMlsMessages,
	WireFormat,
} from '../src/mls/protocol';

const keyPackageLeaf: MlsLeafNode = {
	encryptionKey: bytes(1, 2, 3),
	signatureKey: bytes(4, 5, 6),
	credential: { type: CredentialType.Basic, identity: bytes(7, 8) },
	capabilities: {
		versions: [ProtocolVersion.Mls10],
		cipherSuites: [CipherSuite.Dave],
		extensions: [],
		proposals: [],
		credentials: [CredentialType.Basic],
	},
	source: { type: LeafNodeSource.KeyPackage, lifetime: { notBefore: 0n, notAfter: 0xffff_ffff_ffff_ffffn } },
	extensions: [],
	signature: bytes(9, 10),
};

const keyPackage: MlsKeyPackage = {
	version: ProtocolVersion.Mls10,
	cipherSuite: CipherSuite.Dave,
	initKey: bytes(11, 12, 13),
	leafNode: keyPackageLeaf,
	extensions: [],
	signature: bytes(14, 15),
};

const commitLeaf: MlsLeafNode = {
	...keyPackageLeaf,
	source: { type: LeafNodeSource.Commit, parentHash: bytes(16, 17) },
	signature: bytes(18, 19),
};

const proposalContent: MlsFramedContent = {
	groupId: bytes(20, 21),
	epoch: 5n,
	sender: { type: SenderType.External, senderIndex: 0 },
	authenticatedData: bytes(22),
	type: ContentType.Proposal,
	proposal: { type: ProposalType.Add, keyPackage },
};

const commitContent: MlsFramedContent = {
	groupId: bytes(20, 21),
	epoch: 5n,
	sender: { type: SenderType.Member, leafIndex: 2 },
	authenticatedData: bytes(23),
	type: ContentType.Commit,
	commit: {
		proposals: [{ type: ProposalOrRefType.Reference, reference: bytes(24, 25) }],
		path: {
			leafNode: commitLeaf,
			nodes: [
				{
					encryptionKey: bytes(26, 27),
					encryptedPathSecrets: [{ kemOutput: bytes(28), ciphertext: bytes(29, 30) }],
				},
			],
		},
	},
};

const externalSender: MlsExternalSender = {
	signatureKey: bytes(31, 32),
	credential: { type: CredentialType.Basic, identity: bytes(33, 34) },
};

const groupInfo: MlsGroupInfo = {
	groupContext: {
		version: ProtocolVersion.Mls10,
		cipherSuite: CipherSuite.Dave,
		groupId: bytes(35, 36),
		epoch: 6n,
		treeHash: bytes(37, 38),
		confirmedTranscriptHash: bytes(39, 40),
		extensions: [{ type: ExtensionType.ExternalSenders, data: encodeExternalSenders([externalSender]) }],
	},
	extensions: [{ type: ExtensionType.RatchetTree, data: bytes(41, 42) }],
	confirmationTag: bytes(43, 44),
	signer: 2,
	signature: bytes(45, 46),
};

describe('DAVE MLS protocol codec', () => {
	test('round-trips every supported MLSMessage wire format canonically', () => {
		const messages: readonly MlsMessage[] = [
			{
				version: ProtocolVersion.Mls10,
				wireFormat: WireFormat.KeyPackage,
				keyPackage,
			},
			{
				version: ProtocolVersion.Mls10,
				wireFormat: WireFormat.PublicMessage,
				publicMessage: {
					content: proposalContent,
					auth: { signature: bytes(47, 48) },
				},
			},
			{
				version: ProtocolVersion.Mls10,
				wireFormat: WireFormat.PublicMessage,
				publicMessage: {
					content: commitContent,
					auth: { signature: bytes(49, 50), confirmationTag: bytes(51, 52) },
					membershipTag: bytes(53, 54),
				},
			},
			{
				version: ProtocolVersion.Mls10,
				wireFormat: WireFormat.Welcome,
				welcome: {
					cipherSuite: CipherSuite.Dave,
					secrets: [
						{
							newMember: bytes(55, 56),
							encryptedGroupSecrets: { kemOutput: bytes(57), ciphertext: bytes(58, 59) },
						},
					],
					encryptedGroupInfo: bytes(60, 61),
				},
			},
			{
				version: ProtocolVersion.Mls10,
				wireFormat: WireFormat.GroupInfo,
				groupInfo,
			},
		];

		for (const message of messages) {
			const encoded = encodeMlsMessage(message);
			expect(encodeMlsMessage(decodeMlsMessage(encoded))).toEqual(encoded);
		}
	});

	test('matches an official ciphersuite 2 KeyPackage message vector', () => {
		// mlswg/mls-implementations passive-client-welcome.json at cfd450286d1bfd9cd2519b95c80f9771f94a5b1a.
		const encoded = hex(
			'0001000500010002404104dc0c6128e6a3df0e693c9f33f1c59689abf674229066f7dc02cdcf6ae776d2b9b58b66dde042706146fa6f47cfbc4124c5a70faae37f461be1aba51d3db725e04041040ff29c1878cdefca3c5a5c0dc20b8a29ead0485ca3ec8d23369fffe7c8159cc0808f6b2e1f005552714b08c95b3f9c180d07fd2889bee5ed18913cf599414d7c404104815051765ec9b1f30e64a28a3bc4161e5c4ffb94143d4c3482568d354f3cd348c27ac49fa30ff779ffc66567e974179e3ad61fe555c5a1c277c333de6e04816900010641726e6f6c640200010e0001000200030004000500060007000002000101000000006401d6810000000065e30a01004046304402202085e725f912a4e59bab6059ab05b93ae744f764be3f91f3609ae781f540e59b022054455e276303629330d5952772776fd1058a6e638a0fe0b5986a5cffb8837127004047304502205d1774a62a3c235fca4666f9e5a9f8f7c85894dbbfe0ae32874c702a26520f550221008c52bea9b9b68e9709809fb3c21567d9b0a8f62bd81c6f5b2df776bedd1bce60',
		);
		const decoded = decodeMlsMessage(encoded);

		expect(decoded).toMatchObject({ version: ProtocolVersion.Mls10, wireFormat: WireFormat.KeyPackage });
		if (decoded.wireFormat !== WireFormat.KeyPackage) throw new Error('Expected a KeyPackage message.');
		expect(decoded.keyPackage.cipherSuite).toBe(CipherSuite.Dave);
		expect(decoded.keyPackage.leafNode.credential.type).toBe(CredentialType.Basic);
		expect([...decoded.keyPackage.leafNode.credential.identity]).toEqual([...new TextEncoder().encode('Arnold')]);
		expect(decoded.keyPackage.leafNode.source.type).toBe(LeafNodeSource.KeyPackage);
		expect([...encodeMlsMessage(decoded)]).toEqual([...encoded]);
	});

	test('matches an official ciphersuite 2 Welcome message vector', () => {
		// Same pinned MLS WG vector set as the KeyPackage above.
		const encoded = hex(
			'00010003000240ba205f070a6995cdefb038d405e226e9501beae4ef2ff69bcf072bc5258b49966ac340410410bf273d75f98fd46367c174cb8ae5b69bbe9f19ac55e3e24883accc1b4e26c6facd548c3db3d7cf9cea9750bc6d3d976bda5f481358f7a1c105fc4b8d3d3633405424b1a590ee71822fd2084e052670faeca5627852944f8fd01ab4bb23273173c3fe813210c9b6c4edd0863b4016c3c91363cd55d484f5ee0d18cdbe2e70782cf23b77df527bf0d14502425663b2705666291095ea40d488352fc581df83cc33c3112a0e898086025cae65d83b4a09b17edc129cef7f323cdb68f5b731d43eb8f77833dd6f51ec52fd6b62310c0491775a47ba06f7418afa7ebb2d0fee705bd38efe3604a909bb3edc541270f0933fdab33170097e96d29f0529c379f39e8e694f58deb2588f916e5c2f102f0745bd2fddb7313fa1acef1ce45c413fefd419c0495ecb24459add9211809a6135e2f24ec1498a76c3fa51fa8a663d901d4fe1a49128ef413022754bf4a7c78425cbcfcfea2cad6fd7867482ee1e12901a97fece9241ed5358f7189dcebaab',
		);
		const decoded = decodeMlsMessage(encoded);

		expect(decoded).toMatchObject({
			version: ProtocolVersion.Mls10,
			wireFormat: WireFormat.Welcome,
			welcome: { cipherSuite: CipherSuite.Dave },
		});
		expect([...encodeMlsMessage(decoded)]).toEqual([...encoded]);
	});

	test('round-trips a bare sequence of MLS messages and permits an empty sequence', () => {
		const messages: readonly MlsMessage[] = [
			{ version: ProtocolVersion.Mls10, wireFormat: WireFormat.KeyPackage, keyPackage },
			{ version: ProtocolVersion.Mls10, wireFormat: WireFormat.GroupInfo, groupInfo },
		];
		const encoded = encodeMlsMessages(messages);
		expect(decodeMlsMessages(encoded)).toEqual(messages);
		const split = splitMlsMessages(encoded);
		expect(split).toEqual(messages.map(encodeMlsMessage));
		split[0]![0] = 0xff;
		expect(encoded[0]).toBe(0);
		expect(() => splitMlsMessages(encoded.subarray(0, -1))).toThrow('truncated');
		expect(encodeMlsMessages([])).toHaveLength(0);
		expect(decodeMlsMessages(bytes())).toEqual([]);
		expect(splitMlsMessages(bytes())).toEqual([]);
	});

	test('encodes TBS forms without their outer signatures', () => {
		const leaf = encodeLeafNode(keyPackageLeaf);
		const { signature: _leafSignature, ...unsignedLeaf } = keyPackageLeaf;
		const leafTbs = encodeLeafNodeTbs(unsignedLeaf);
		expect(leaf).toEqual(concatenate(leafTbs, vector(keyPackageLeaf.signature)));
		expect(() => encodeLeafNodeTbs(commitLeaf)).toThrow('require group context');

		const encodedKeyPackage = encodeMlsMessage({
			version: ProtocolVersion.Mls10,
			wireFormat: WireFormat.KeyPackage,
			keyPackage,
		});
		const { signature: _keyPackageSignature, ...unsignedKeyPackage } = keyPackage;
		const keyPackageTbs = encodeKeyPackageTbs(unsignedKeyPackage);
		expect(encodedKeyPackage).toEqual(concatenate(bytes(0, 1, 0, 5), keyPackageTbs, vector(keyPackage.signature)));

		const encodedGroupInfo = encodeGroupInfo(groupInfo);
		const { signature: _groupInfoSignature, ...unsignedGroupInfo } = groupInfo;
		const groupInfoTbs = encodeGroupInfoTbs(unsignedGroupInfo);
		expect(encodedGroupInfo).toEqual(concatenate(groupInfoTbs, vector(groupInfo.signature)));
	});

	test('encodes transcript inputs without confirmation or membership tags', () => {
		const authenticatedContent: MlsAuthenticatedContent = {
			wireFormat: WireFormat.PublicMessage,
			content: commitContent,
			auth: { signature: bytes(62, 63), confirmationTag: bytes(64, 65) },
		};
		const confirmed = encodeConfirmedTranscriptHashInput(authenticatedContent);
		const membershipTag = bytes(0xfa, 0xfb, 0xfc);
		const publicMessage = encodePublicMessage({
			content: commitContent,
			auth: authenticatedContent.auth,
			membershipTag,
		});

		expect(confirmed).toEqual(
			concatenate(
				bytes(0, WireFormat.PublicMessage),
				encodeFramedContent(commitContent),
				vector(authenticatedContent.auth.signature),
			),
		);
		expect(confirmed).not.toEqual(encodeAuthenticatedContent(authenticatedContent));
		expect(Buffer.from(confirmed).includes(Buffer.from(authenticatedContent.auth.confirmationTag!))).toBe(false);
		expect(Buffer.from(publicMessage).includes(Buffer.from(membershipTag))).toBe(true);
		expect(Buffer.from(confirmed).includes(Buffer.from(membershipTag))).toBe(false);
		expect(encodeInterimTranscriptHashInput(bytes(66, 67))).toEqual(vector(bytes(66, 67)));
	});

	test('round-trips external senders, GroupInfo, ratchet tree, and DAVE GroupSecrets', () => {
		const senders = encodeExternalSenders([externalSender]);
		expect(decodeExternalSenders(senders)).toEqual([externalSender]);
		expect(decodeGroupInfo(encodeGroupInfo(groupInfo))).toEqual(groupInfo);

		const nodes: readonly (MlsNode | undefined)[] = [
			{ type: NodeType.Leaf, leafNode: keyPackageLeaf },
			undefined,
			{
				type: NodeType.Parent,
				parentNode: { encryptionKey: bytes(68), parentHash: bytes(69), unmergedLeaves: [1, 3] },
			},
		];
		const tree = encodeRatchetTree(nodes);
		expect(decodeRatchetTree(tree)).toEqual(nodes);

		const groupSecrets = { joinerSecret: bytes(70, 71), pathSecret: bytes(72, 73) };
		expect(decodeGroupSecrets(encodeGroupSecrets(groupSecrets))).toEqual(groupSecrets);
	});

	test('rejects malformed, trailing, and unsupported profile encodings', () => {
		const keyPackageMessage = encodeMlsMessage({
			version: ProtocolVersion.Mls10,
			wireFormat: WireFormat.KeyPackage,
			keyPackage,
		});
		expect(() => decodeMlsMessage(keyPackageMessage.subarray(0, -1))).toThrow('truncated');
		expect(() => decodeMlsMessage(concatenate(keyPackageMessage, bytes(0)))).toThrow('trailing');
		expect(() => decodeMlsMessage(bytes(0, 2, 0, 5))).toThrow('ProtocolVersion');
		expect(() => decodeMlsMessage(bytes(0, 1, 0, 2))).toThrow('DAVE WireFormat');

		const unsupportedSuite = keyPackageMessage.slice();
		unsupportedSuite[7] = 1;
		expect(() => decodeMlsMessage(unsupportedSuite)).toThrow('DAVE CipherSuite');

		const application = concatenate(
			bytes(0, 1, 0, 1),
			vector(bytes()),
			bytes(0, 0, 0, 0, 0, 0, 0, 0),
			bytes(SenderType.Member, 0, 0, 0, 0),
			vector(bytes()),
			bytes(ContentType.Application),
		);
		expect(() => decodeMlsMessage(application)).toThrow('DAVE ContentType');
		expect(() => decodeCredential(bytes(0, 2))).toThrow('CredentialType');
		expect(() => decodeCommit(bytes(0, 2))).toThrow('presence marker');
		expect(() => encodeParentNode({ encryptionKey: bytes(), parentHash: bytes(), unmergedLeaves: [2, 2] })).toThrow(
			'strictly increasing',
		);
		expect(() => decodeRatchetTree(bytes(0))).toThrow('non-blank');
		expect(() => encodeRatchetTree([{ type: NodeType.Leaf, leafNode: keyPackageLeaf }, undefined])).toThrow(
			'non-blank',
		);
	});
});

function bytes(...values: number[]): Uint8Array {
	return Uint8Array.from(values);
}

function hex(value: string): Uint8Array {
	return Buffer.from(value, 'hex');
}

function vector(value: Uint8Array): Uint8Array {
	if (value.byteLength >= 64) throw new RangeError('Test helper only supports one-byte vectors.');
	return concatenate(bytes(value.byteLength), value);
}
