import { MlsReader, MlsWriter } from './codec';

export const ProtocolVersion = Object.freeze({
	Mls10: 0x0001,
} as const);

export const CipherSuite = Object.freeze({
	Dave: 0x0002,
} as const);

export const WireFormat = Object.freeze({
	PublicMessage: 0x0001,
	PrivateMessage: 0x0002,
	Welcome: 0x0003,
	GroupInfo: 0x0004,
	KeyPackage: 0x0005,
} as const);

export const ContentType = Object.freeze({
	Application: 0x01,
	Proposal: 0x02,
	Commit: 0x03,
} as const);

export const SenderType = Object.freeze({
	Member: 0x01,
	External: 0x02,
	NewMemberProposal: 0x03,
	NewMemberCommit: 0x04,
} as const);

export const CredentialType = Object.freeze({
	Basic: 0x0001,
} as const);

export const LeafNodeSource = Object.freeze({
	KeyPackage: 0x01,
	Update: 0x02,
	Commit: 0x03,
} as const);

export const NodeType = Object.freeze({
	Leaf: 0x01,
	Parent: 0x02,
} as const);

export const ExtensionType = Object.freeze({
	RatchetTree: 0x0002,
	ExternalSenders: 0x0005,
} as const);

export const ProposalType = Object.freeze({
	Add: 0x0001,
	Remove: 0x0003,
} as const);

export const ProposalOrRefType = Object.freeze({
	Proposal: 0x01,
	Reference: 0x02,
} as const);

export type ProtocolVersion = (typeof ProtocolVersion)[keyof typeof ProtocolVersion];
export type CipherSuite = (typeof CipherSuite)[keyof typeof CipherSuite];
export type WireFormat = (typeof WireFormat)[keyof typeof WireFormat];
export type ContentType = (typeof ContentType)[keyof typeof ContentType];
export type SenderType = (typeof SenderType)[keyof typeof SenderType];
export type CredentialType = (typeof CredentialType)[keyof typeof CredentialType];
export type LeafNodeSource = (typeof LeafNodeSource)[keyof typeof LeafNodeSource];
export type NodeType = (typeof NodeType)[keyof typeof NodeType];
export type ExtensionType = (typeof ExtensionType)[keyof typeof ExtensionType];
export type ProposalType = (typeof ProposalType)[keyof typeof ProposalType];
export type ProposalOrRefType = (typeof ProposalOrRefType)[keyof typeof ProposalOrRefType];

export interface MlsBasicCredential {
	readonly type: typeof CredentialType.Basic;
	readonly identity: Uint8Array;
}

export type MlsCredential = MlsBasicCredential;

export interface MlsExternalSender {
	readonly signatureKey: Uint8Array;
	readonly credential: MlsCredential;
}

export interface MlsExtension {
	readonly type: number;
	readonly data: Uint8Array;
}

/** @internal */
export function assertUniqueMlsExtensions(extensions: readonly MlsExtension[]): void {
	const types = new Set<number>();
	for (const extension of extensions) {
		if (extension.type === 0) throw new TypeError('MLS extension type 0 is reserved.');
		if (types.has(extension.type)) throw new TypeError('MLS extension lists cannot contain duplicate types.');
		types.add(extension.type);
	}
}

export interface MlsCapabilities {
	readonly versions: readonly number[];
	readonly cipherSuites: readonly number[];
	readonly extensions: readonly number[];
	readonly proposals: readonly number[];
	readonly credentials: readonly number[];
}

export interface MlsLifetime {
	readonly notBefore: bigint;
	readonly notAfter: bigint;
}

export type MlsLeafNodeSource =
	| {
			readonly type: typeof LeafNodeSource.KeyPackage;
			readonly lifetime: MlsLifetime;
	  }
	| {
			readonly type: typeof LeafNodeSource.Update;
	  }
	| {
			readonly type: typeof LeafNodeSource.Commit;
			readonly parentHash: Uint8Array;
	  };

export interface MlsLeafNodeTbs {
	readonly encryptionKey: Uint8Array;
	readonly signatureKey: Uint8Array;
	readonly credential: MlsCredential;
	readonly capabilities: MlsCapabilities;
	readonly source: MlsLeafNodeSource;
	readonly extensions: readonly MlsExtension[];
}

export interface MlsLeafNode extends MlsLeafNodeTbs {
	readonly signature: Uint8Array;
}

export interface MlsKeyPackageTbs {
	readonly version: typeof ProtocolVersion.Mls10;
	readonly cipherSuite: typeof CipherSuite.Dave;
	readonly initKey: Uint8Array;
	readonly leafNode: MlsLeafNode;
	readonly extensions: readonly MlsExtension[];
}

export interface MlsKeyPackage extends MlsKeyPackageTbs {
	readonly signature: Uint8Array;
}

export interface MlsParentNode {
	readonly encryptionKey: Uint8Array;
	readonly parentHash: Uint8Array;
	readonly unmergedLeaves: readonly number[];
}

export type MlsNode =
	| {
			readonly type: typeof NodeType.Leaf;
			readonly leafNode: MlsLeafNode;
	  }
	| {
			readonly type: typeof NodeType.Parent;
			readonly parentNode: MlsParentNode;
	  };

export type MlsSender =
	| {
			readonly type: typeof SenderType.Member;
			readonly leafIndex: number;
	  }
	| {
			readonly type: typeof SenderType.External;
			readonly senderIndex: number;
	  };

export type MlsProposal =
	| {
			readonly type: typeof ProposalType.Add;
			readonly keyPackage: MlsKeyPackage;
	  }
	| {
			readonly type: typeof ProposalType.Remove;
			readonly removed: number;
	  };

export interface MlsHpkeCiphertext {
	readonly kemOutput: Uint8Array;
	readonly ciphertext: Uint8Array;
}

export interface MlsUpdatePathNode {
	readonly encryptionKey: Uint8Array;
	readonly encryptedPathSecrets: readonly MlsHpkeCiphertext[];
}

export interface MlsUpdatePath {
	readonly leafNode: MlsLeafNode;
	readonly nodes: readonly MlsUpdatePathNode[];
}

export type MlsProposalOrRef =
	| {
			readonly type: typeof ProposalOrRefType.Proposal;
			readonly proposal: MlsProposal;
	  }
	| {
			readonly type: typeof ProposalOrRefType.Reference;
			readonly reference: Uint8Array;
	  };

export interface MlsCommit {
	readonly proposals: readonly MlsProposalOrRef[];
	readonly path: MlsUpdatePath | undefined;
}

interface MlsFramedContentBase {
	readonly groupId: Uint8Array;
	readonly epoch: bigint;
	readonly sender: MlsSender;
	readonly authenticatedData: Uint8Array;
}

export type MlsFramedContent = MlsFramedContentBase &
	(
		| {
				readonly type: typeof ContentType.Proposal;
				readonly proposal: MlsProposal;
		  }
		| {
				readonly type: typeof ContentType.Commit;
				readonly commit: MlsCommit;
		  }
	);

export interface MlsFramedContentAuthData {
	readonly signature: Uint8Array;
	readonly confirmationTag?: Uint8Array;
}

export interface MlsPublicMessage {
	readonly content: MlsFramedContent;
	readonly auth: MlsFramedContentAuthData;
	readonly membershipTag?: Uint8Array;
}

export interface MlsFramedContentTbs {
	readonly wireFormat: typeof WireFormat.PublicMessage;
	readonly content: MlsFramedContent;
}

export interface MlsAuthenticatedContent extends MlsFramedContentTbs {
	readonly auth: MlsFramedContentAuthData;
}

export interface MlsGroupContext {
	readonly version: typeof ProtocolVersion.Mls10;
	readonly cipherSuite: typeof CipherSuite.Dave;
	readonly groupId: Uint8Array;
	readonly epoch: bigint;
	readonly treeHash: Uint8Array;
	readonly confirmedTranscriptHash: Uint8Array;
	readonly extensions: readonly MlsExtension[];
}

export interface MlsGroupInfoTbs {
	readonly groupContext: MlsGroupContext;
	readonly extensions: readonly MlsExtension[];
	readonly confirmationTag: Uint8Array;
	readonly signer: number;
}

export interface MlsGroupInfo extends MlsGroupInfoTbs {
	readonly signature: Uint8Array;
}

export interface MlsEncryptedGroupSecrets {
	readonly newMember: Uint8Array;
	readonly encryptedGroupSecrets: MlsHpkeCiphertext;
}

export interface MlsGroupSecrets {
	readonly joinerSecret: Uint8Array;
	readonly pathSecret: Uint8Array | undefined;
}

export interface MlsLeafNodeTbsContext {
	readonly groupId: Uint8Array;
	readonly leafIndex: number;
}

export interface MlsWelcome {
	readonly cipherSuite: typeof CipherSuite.Dave;
	readonly secrets: readonly MlsEncryptedGroupSecrets[];
	readonly encryptedGroupInfo: Uint8Array;
}

interface MlsMessageBase {
	readonly version: typeof ProtocolVersion.Mls10;
}

export type MlsMessage = MlsMessageBase &
	(
		| {
				readonly wireFormat: typeof WireFormat.PublicMessage;
				readonly publicMessage: MlsPublicMessage;
		  }
		| {
				readonly wireFormat: typeof WireFormat.Welcome;
				readonly welcome: MlsWelcome;
		  }
		| {
				readonly wireFormat: typeof WireFormat.GroupInfo;
				readonly groupInfo: MlsGroupInfo;
		  }
		| {
				readonly wireFormat: typeof WireFormat.KeyPackage;
				readonly keyPackage: MlsKeyPackage;
		  }
	);

export function encodeCredential(credential: MlsCredential): Uint8Array<ArrayBuffer> {
	return encodeStructure(credential, writeCredential);
}

export function decodeCredential(data: Uint8Array, maximumVectorLength?: number): MlsCredential {
	return decodeStructure(data, readCredential, maximumVectorLength);
}

export function encodeExternalSender(sender: MlsExternalSender): Uint8Array<ArrayBuffer> {
	return encodeStructure(sender, writeExternalSender);
}

export function decodeExternalSender(data: Uint8Array, maximumVectorLength?: number): MlsExternalSender {
	return decodeStructure(data, readExternalSender, maximumVectorLength);
}

export function encodeExternalSenders(senders: readonly MlsExternalSender[]): Uint8Array<ArrayBuffer> {
	return encodeStructure(senders, writeExternalSenders);
}

export function decodeExternalSenders(data: Uint8Array, maximumVectorLength?: number): readonly MlsExternalSender[] {
	return decodeStructure(data, readExternalSenders, maximumVectorLength);
}

export function encodeExtension(extension: MlsExtension): Uint8Array<ArrayBuffer> {
	return encodeStructure(extension, writeExtension);
}

export function decodeExtension(data: Uint8Array, maximumVectorLength?: number): MlsExtension {
	return decodeStructure(data, readExtension, maximumVectorLength);
}

export function encodeCapabilities(capabilities: MlsCapabilities): Uint8Array<ArrayBuffer> {
	return encodeStructure(capabilities, writeCapabilities);
}

export function decodeCapabilities(data: Uint8Array, maximumVectorLength?: number): MlsCapabilities {
	return decodeStructure(data, readCapabilities, maximumVectorLength);
}

export function encodeLeafNode(leafNode: MlsLeafNode): Uint8Array<ArrayBuffer> {
	return encodeStructure(leafNode, writeLeafNode);
}

export function decodeLeafNode(data: Uint8Array, maximumVectorLength?: number): MlsLeafNode {
	return decodeStructure(data, readLeafNode, maximumVectorLength);
}

export function encodeLeafNodeTbs(leafNode: MlsLeafNodeTbs, context?: MlsLeafNodeTbsContext): Uint8Array<ArrayBuffer> {
	return encodeStructure({ leafNode, context }, writeLeafNodeTbsInput);
}

export function encodeKeyPackage(keyPackage: MlsKeyPackage): Uint8Array<ArrayBuffer> {
	return encodeStructure(keyPackage, writeKeyPackage);
}

export function decodeKeyPackage(data: Uint8Array, maximumVectorLength?: number): MlsKeyPackage {
	return decodeStructure(data, readKeyPackage, maximumVectorLength);
}

export function encodeKeyPackageTbs(keyPackage: MlsKeyPackageTbs): Uint8Array<ArrayBuffer> {
	return encodeStructure(keyPackage, writeKeyPackageTbs);
}

export function encodeParentNode(parentNode: MlsParentNode): Uint8Array<ArrayBuffer> {
	return encodeStructure(parentNode, writeParentNode);
}

export function decodeParentNode(data: Uint8Array, maximumVectorLength?: number): MlsParentNode {
	return decodeStructure(data, readParentNode, maximumVectorLength);
}

export function encodeNode(node: MlsNode): Uint8Array<ArrayBuffer> {
	return encodeStructure(node, writeNode);
}

export function decodeNode(data: Uint8Array, maximumVectorLength?: number): MlsNode {
	return decodeStructure(data, readNode, maximumVectorLength);
}

export function encodeRatchetTree(nodes: readonly (MlsNode | undefined)[]): Uint8Array<ArrayBuffer> {
	assertRatchetTreeEncoding(nodes);
	return encodeStructure(nodes, writeRatchetTree);
}

export function decodeRatchetTree(data: Uint8Array, maximumVectorLength?: number): readonly (MlsNode | undefined)[] {
	const nodes = decodeStructure(data, readRatchetTree, maximumVectorLength);
	assertRatchetTreeEncoding(nodes);
	return nodes;
}

export function encodeSender(sender: MlsSender): Uint8Array<ArrayBuffer> {
	return encodeStructure(sender, writeSender);
}

export function decodeSender(data: Uint8Array, maximumVectorLength?: number): MlsSender {
	return decodeStructure(data, readSender, maximumVectorLength);
}

export function encodeProposal(proposal: MlsProposal): Uint8Array<ArrayBuffer> {
	return encodeStructure(proposal, writeProposal);
}

export function decodeProposal(data: Uint8Array, maximumVectorLength?: number): MlsProposal {
	return decodeStructure(data, readProposal, maximumVectorLength);
}

export function encodeCommit(commit: MlsCommit): Uint8Array<ArrayBuffer> {
	return encodeStructure(commit, writeCommit);
}

export function decodeCommit(data: Uint8Array, maximumVectorLength?: number): MlsCommit {
	return decodeStructure(data, readCommit, maximumVectorLength);
}

export function encodeUpdatePath(path: MlsUpdatePath): Uint8Array<ArrayBuffer> {
	return encodeStructure(path, writeUpdatePath);
}

export function decodeUpdatePath(data: Uint8Array, maximumVectorLength?: number): MlsUpdatePath {
	return decodeStructure(data, readUpdatePath, maximumVectorLength);
}

export function encodeFramedContent(content: MlsFramedContent): Uint8Array<ArrayBuffer> {
	return encodeStructure(content, writeFramedContent);
}

export function decodeFramedContent(data: Uint8Array, maximumVectorLength?: number): MlsFramedContent {
	return decodeStructure(data, readFramedContent, maximumVectorLength);
}

export function encodePublicMessage(message: MlsPublicMessage): Uint8Array<ArrayBuffer> {
	return encodeStructure(message, writePublicMessage);
}

export function decodePublicMessage(data: Uint8Array, maximumVectorLength?: number): MlsPublicMessage {
	return decodeStructure(data, readPublicMessage, maximumVectorLength);
}

export function encodeAuthenticatedContent(content: MlsAuthenticatedContent): Uint8Array<ArrayBuffer> {
	return encodeStructure(content, writeAuthenticatedContent);
}

export function decodeAuthenticatedContent(data: Uint8Array, maximumVectorLength?: number): MlsAuthenticatedContent {
	return decodeStructure(data, readAuthenticatedContent, maximumVectorLength);
}

export function encodeFramedContentTbs(
	content: MlsFramedContentTbs,
	groupContext?: MlsGroupContext,
): Uint8Array<ArrayBuffer> {
	return encodeStructure({ content, groupContext }, writeFramedContentTbsInput);
}

export function encodeAuthenticatedContentTbm(
	content: MlsAuthenticatedContent,
	groupContext?: MlsGroupContext,
): Uint8Array<ArrayBuffer> {
	return encodeStructure({ content, groupContext }, writeAuthenticatedContentTbmInput);
}

export function encodeConfirmedTranscriptHashInput(content: MlsAuthenticatedContent): Uint8Array<ArrayBuffer> {
	return encodeStructure(content, writeConfirmedTranscriptHashInput);
}

export function encodeInterimTranscriptHashInput(confirmationTag: Uint8Array): Uint8Array<ArrayBuffer> {
	return encodeStructure(confirmationTag, (writer, tag) => writer.vector(tag));
}

export function encodeGroupContext(context: MlsGroupContext): Uint8Array<ArrayBuffer> {
	return encodeStructure(context, writeGroupContext);
}

export function decodeGroupContext(data: Uint8Array, maximumVectorLength?: number): MlsGroupContext {
	return decodeStructure(data, readGroupContext, maximumVectorLength);
}

export function encodeGroupInfo(groupInfo: MlsGroupInfo): Uint8Array<ArrayBuffer> {
	return encodeStructure(groupInfo, writeGroupInfo);
}

export function decodeGroupInfo(data: Uint8Array, maximumVectorLength?: number): MlsGroupInfo {
	return decodeStructure(data, readGroupInfo, maximumVectorLength);
}

export function encodeGroupInfoTbs(groupInfo: MlsGroupInfoTbs): Uint8Array<ArrayBuffer> {
	return encodeStructure(groupInfo, writeGroupInfoTbs);
}

export function encodeGroupSecrets(groupSecrets: MlsGroupSecrets): Uint8Array<ArrayBuffer> {
	return encodeStructure(groupSecrets, writeGroupSecrets);
}

export function decodeGroupSecrets(data: Uint8Array, maximumVectorLength?: number): MlsGroupSecrets {
	return decodeStructure(data, readGroupSecrets, maximumVectorLength);
}

export function encodeWelcome(welcome: MlsWelcome): Uint8Array<ArrayBuffer> {
	return encodeStructure(welcome, writeWelcome);
}

export function decodeWelcome(data: Uint8Array, maximumVectorLength?: number): MlsWelcome {
	return decodeStructure(data, readWelcome, maximumVectorLength);
}

export function encodeMlsMessage(message: MlsMessage): Uint8Array<ArrayBuffer> {
	return encodeStructure(message, writeMlsMessage);
}

export function decodeMlsMessage(data: Uint8Array, maximumVectorLength?: number): MlsMessage {
	return decodeStructure(data, readMlsMessage, maximumVectorLength);
}

export function encodeMlsMessages(messages: readonly MlsMessage[]): Uint8Array<ArrayBuffer> {
	const writer = new MlsWriter();
	for (const message of messages) writeMlsMessage(writer, message);
	return writer.finish();
}

export function decodeMlsMessages(data: Uint8Array, maximumVectorLength?: number): readonly MlsMessage[] {
	const reader = new MlsReader(data, maximumVectorLength);
	const messages: MlsMessage[] = [];
	while (reader.remaining > 0) messages.push(readMlsMessage(reader));
	return messages;
}

export function splitMlsMessages(data: Uint8Array, maximumVectorLength?: number): readonly Uint8Array[] {
	const reader = new MlsReader(data, maximumVectorLength);
	const messages: Uint8Array[] = [];
	let offset = 0;
	while (reader.remaining > 0) {
		readMlsMessage(reader);
		const nextOffset = data.byteLength - reader.remaining;
		messages.push(Uint8Array.from(data.subarray(offset, nextOffset)));
		offset = nextOffset;
	}
	return messages;
}

function writeCredential(writer: MlsWriter, credential: MlsCredential): void {
	requireValue(credential.type, CredentialType.Basic, 'CredentialType');
	writer.uint16(credential.type).vector(credential.identity);
}

function readCredential(reader: MlsReader): MlsCredential {
	const type = reader.uint16();
	requireValue(type, CredentialType.Basic, 'CredentialType');
	return { type, identity: reader.vector() };
}

function writeExternalSender(writer: MlsWriter, sender: MlsExternalSender): void {
	writer.vector(sender.signatureKey);
	writeCredential(writer, sender.credential);
}

function readExternalSender(reader: MlsReader): MlsExternalSender {
	return { signatureKey: reader.vector(), credential: readCredential(reader) };
}

function writeExternalSenders(writer: MlsWriter, senders: readonly MlsExternalSender[]): void {
	writeItemVector(writer, senders, writeExternalSender);
}

function readExternalSenders(reader: MlsReader): readonly MlsExternalSender[] {
	return reader.vectorItems(readExternalSender);
}

function writeExtension(writer: MlsWriter, extension: MlsExtension): void {
	writer.uint16(extension.type).vector(extension.data);
}

function readExtension(reader: MlsReader): MlsExtension {
	return { type: reader.uint16(), data: reader.vector() };
}

function writeExtensions(writer: MlsWriter, extensions: readonly MlsExtension[]): void {
	writeItemVector(writer, extensions, writeExtension);
}

function readExtensions(reader: MlsReader): readonly MlsExtension[] {
	return reader.vectorItems(readExtension);
}

function writeCapabilities(writer: MlsWriter, capabilities: MlsCapabilities): void {
	writeUint16Vector(writer, capabilities.versions);
	writeUint16Vector(writer, capabilities.cipherSuites);
	writeUint16Vector(writer, capabilities.extensions);
	writeUint16Vector(writer, capabilities.proposals);
	writeUint16Vector(writer, capabilities.credentials);
}

function readCapabilities(reader: MlsReader): MlsCapabilities {
	return {
		versions: readUint16Vector(reader),
		cipherSuites: readUint16Vector(reader),
		extensions: readUint16Vector(reader),
		proposals: readUint16Vector(reader),
		credentials: readUint16Vector(reader),
	};
}

function writeLeafNode(writer: MlsWriter, leafNode: MlsLeafNode): void {
	writeLeafNodeTbs(writer, leafNode);
	writer.vector(leafNode.signature);
}

function writeLeafNodeTbsInput(
	writer: MlsWriter,
	input: { readonly leafNode: MlsLeafNodeTbs; readonly context: MlsLeafNodeTbsContext | undefined },
): void {
	writeLeafNodeTbs(writer, input.leafNode);
	if (input.leafNode.source.type === LeafNodeSource.KeyPackage) {
		if (input.context === undefined) return;
		throw new TypeError('MLS key_package LeafNodeTBS cannot contain group context.');
	}
	if (input.context === undefined) throw new TypeError('MLS update and commit LeafNodeTBS require group context.');
	writer.vector(input.context.groupId).uint32(input.context.leafIndex);
}

function writeLeafNodeTbs(writer: MlsWriter, leafNode: MlsLeafNodeTbs): void {
	writer.vector(leafNode.encryptionKey).vector(leafNode.signatureKey);
	writeCredential(writer, leafNode.credential);
	writeCapabilities(writer, leafNode.capabilities);
	writer.uint8(leafNode.source.type);
	switch (leafNode.source.type) {
		case LeafNodeSource.KeyPackage:
			writer.uint64(leafNode.source.lifetime.notBefore).uint64(leafNode.source.lifetime.notAfter);
			break;
		case LeafNodeSource.Update:
			break;
		case LeafNodeSource.Commit:
			writer.vector(leafNode.source.parentHash);
			break;
		default:
			unsupportedValue('LeafNodeSource', (leafNode.source as { readonly type: number }).type);
	}
	writeExtensions(writer, leafNode.extensions);
}

function readLeafNode(reader: MlsReader): MlsLeafNode {
	const encryptionKey = reader.vector();
	const signatureKey = reader.vector();
	const credential = readCredential(reader);
	const capabilities = readCapabilities(reader);
	const source = readLeafNodeSource(reader);
	const extensions = readExtensions(reader);
	const signature = reader.vector();
	return { encryptionKey, signatureKey, credential, capabilities, source, extensions, signature };
}

function readLeafNodeSource(reader: MlsReader): MlsLeafNodeSource {
	switch (reader.uint8()) {
		case LeafNodeSource.KeyPackage:
			return {
				type: LeafNodeSource.KeyPackage,
				lifetime: { notBefore: reader.uint64(), notAfter: reader.uint64() },
			};
		case LeafNodeSource.Update:
			return { type: LeafNodeSource.Update };
		case LeafNodeSource.Commit:
			return { type: LeafNodeSource.Commit, parentHash: reader.vector() };
		default:
			return unsupportedValue('LeafNodeSource');
	}
}

function writeKeyPackage(writer: MlsWriter, keyPackage: MlsKeyPackage): void {
	writeKeyPackageTbs(writer, keyPackage);
	writer.vector(keyPackage.signature);
}

function writeKeyPackageTbs(writer: MlsWriter, keyPackage: MlsKeyPackageTbs): void {
	requireMls10(keyPackage.version);
	requireDaveCipherSuite(keyPackage.cipherSuite);
	if (keyPackage.leafNode.source.type !== LeafNodeSource.KeyPackage) {
		throw new TypeError('MLS KeyPackage leaf node must use the key_package source.');
	}
	writer.uint16(keyPackage.version).uint16(keyPackage.cipherSuite).vector(keyPackage.initKey);
	writeLeafNode(writer, keyPackage.leafNode);
	writeExtensions(writer, keyPackage.extensions);
}

function readKeyPackage(reader: MlsReader): MlsKeyPackage {
	const version = reader.uint16();
	requireMls10(version);
	const cipherSuite = reader.uint16();
	requireDaveCipherSuite(cipherSuite);
	const initKey = reader.vector();
	const leafNode = readLeafNode(reader);
	if (leafNode.source.type !== LeafNodeSource.KeyPackage) {
		throw new TypeError('MLS KeyPackage leaf node must use the key_package source.');
	}
	const extensions = readExtensions(reader);
	const signature = reader.vector();
	return { version, cipherSuite, initKey, leafNode, extensions, signature };
}

function writeParentNode(writer: MlsWriter, parentNode: MlsParentNode): void {
	assertIncreasing(parentNode.unmergedLeaves, 'ParentNode unmerged leaves');
	writer.vector(parentNode.encryptionKey).vector(parentNode.parentHash);
	writer.vectorWith(vector => {
		for (const leaf of parentNode.unmergedLeaves) vector.uint32(leaf);
	});
}

function readParentNode(reader: MlsReader): MlsParentNode {
	const encryptionKey = reader.vector();
	const parentHash = reader.vector();
	const unmergedLeaves = reader.vectorItems(item => item.uint32());
	assertIncreasing(unmergedLeaves, 'ParentNode unmerged leaves');
	return { encryptionKey, parentHash, unmergedLeaves };
}

function writeNode(writer: MlsWriter, node: MlsNode): void {
	writer.uint8(node.type);
	switch (node.type) {
		case NodeType.Leaf:
			writeLeafNode(writer, node.leafNode);
			break;
		case NodeType.Parent:
			writeParentNode(writer, node.parentNode);
			break;
		default:
			unsupportedValue('NodeType', (node as { readonly type: number }).type);
	}
}

function readNode(reader: MlsReader): MlsNode {
	switch (reader.uint8()) {
		case NodeType.Leaf:
			return { type: NodeType.Leaf, leafNode: readLeafNode(reader) };
		case NodeType.Parent:
			return { type: NodeType.Parent, parentNode: readParentNode(reader) };
		default:
			return unsupportedValue('NodeType');
	}
}

function writeRatchetTree(writer: MlsWriter, nodes: readonly (MlsNode | undefined)[]): void {
	writer.vectorWith(vector => {
		for (const node of nodes) vector.optional(node, writeNode);
	});
}

function readRatchetTree(reader: MlsReader): readonly (MlsNode | undefined)[] {
	return reader.vectorItems(item => item.optional(readNode));
}

function writeSender(writer: MlsWriter, sender: MlsSender): void {
	writer.uint8(sender.type);
	switch (sender.type) {
		case SenderType.Member:
			writer.uint32(sender.leafIndex);
			break;
		case SenderType.External:
			writer.uint32(sender.senderIndex);
			break;
		default:
			unsupportedValue('SenderType', (sender as { readonly type: number }).type);
	}
}

function readSender(reader: MlsReader): MlsSender {
	switch (reader.uint8()) {
		case SenderType.Member:
			return { type: SenderType.Member, leafIndex: reader.uint32() };
		case SenderType.External:
			return { type: SenderType.External, senderIndex: reader.uint32() };
		case SenderType.NewMemberProposal:
		case SenderType.NewMemberCommit:
			return unsupportedValue('DAVE SenderType');
		default:
			return unsupportedValue('SenderType');
	}
}

function writeProposal(writer: MlsWriter, proposal: MlsProposal): void {
	writer.uint16(proposal.type);
	switch (proposal.type) {
		case ProposalType.Add:
			writeKeyPackage(writer, proposal.keyPackage);
			break;
		case ProposalType.Remove:
			writer.uint32(proposal.removed);
			break;
		default:
			unsupportedValue('DAVE ProposalType', (proposal as { readonly type: number }).type);
	}
}

function readProposal(reader: MlsReader): MlsProposal {
	switch (reader.uint16()) {
		case ProposalType.Add:
			return { type: ProposalType.Add, keyPackage: readKeyPackage(reader) };
		case ProposalType.Remove:
			return { type: ProposalType.Remove, removed: reader.uint32() };
		default:
			return unsupportedValue('DAVE ProposalType');
	}
}

function writeHpkeCiphertext(writer: MlsWriter, ciphertext: MlsHpkeCiphertext): void {
	writer.vector(ciphertext.kemOutput).vector(ciphertext.ciphertext);
}

function readHpkeCiphertext(reader: MlsReader): MlsHpkeCiphertext {
	return { kemOutput: reader.vector(), ciphertext: reader.vector() };
}

function writeUpdatePathNode(writer: MlsWriter, node: MlsUpdatePathNode): void {
	writer.vector(node.encryptionKey);
	writeItemVector(writer, node.encryptedPathSecrets, writeHpkeCiphertext);
}

function readUpdatePathNode(reader: MlsReader): MlsUpdatePathNode {
	return {
		encryptionKey: reader.vector(),
		encryptedPathSecrets: reader.vectorItems(readHpkeCiphertext),
	};
}

function writeUpdatePath(writer: MlsWriter, path: MlsUpdatePath): void {
	if (path.leafNode.source.type !== LeafNodeSource.Commit) {
		throw new TypeError('MLS UpdatePath leaf node must use the commit source.');
	}
	writeLeafNode(writer, path.leafNode);
	writeItemVector(writer, path.nodes, writeUpdatePathNode);
}

function readUpdatePath(reader: MlsReader): MlsUpdatePath {
	const leafNode = readLeafNode(reader);
	if (leafNode.source.type !== LeafNodeSource.Commit) {
		throw new TypeError('MLS UpdatePath leaf node must use the commit source.');
	}
	return { leafNode, nodes: reader.vectorItems(readUpdatePathNode) };
}

function writeProposalOrRef(writer: MlsWriter, proposal: MlsProposalOrRef): void {
	writer.uint8(proposal.type);
	switch (proposal.type) {
		case ProposalOrRefType.Proposal:
			writeProposal(writer, proposal.proposal);
			break;
		case ProposalOrRefType.Reference:
			writer.vector(proposal.reference);
			break;
		default:
			unsupportedValue('ProposalOrRefType', (proposal as { readonly type: number }).type);
	}
}

function readProposalOrRef(reader: MlsReader): MlsProposalOrRef {
	switch (reader.uint8()) {
		case ProposalOrRefType.Proposal:
			return { type: ProposalOrRefType.Proposal, proposal: readProposal(reader) };
		case ProposalOrRefType.Reference:
			return { type: ProposalOrRefType.Reference, reference: reader.vector() };
		default:
			return unsupportedValue('ProposalOrRefType');
	}
}

function writeCommit(writer: MlsWriter, commit: MlsCommit): void {
	writeItemVector(writer, commit.proposals, writeProposalOrRef);
	writer.optional(commit.path, writeUpdatePath);
}

function readCommit(reader: MlsReader): MlsCommit {
	return {
		proposals: reader.vectorItems(readProposalOrRef),
		path: reader.optional(readUpdatePath),
	};
}

function writeFramedContent(writer: MlsWriter, content: MlsFramedContent): void {
	assertDaveSenderContent(content);
	writer.vector(content.groupId).uint64(content.epoch);
	writeSender(writer, content.sender);
	writer.vector(content.authenticatedData).uint8(content.type);
	switch (content.type) {
		case ContentType.Proposal:
			writeProposal(writer, content.proposal);
			break;
		case ContentType.Commit:
			writeCommit(writer, content.commit);
			break;
		default:
			unsupportedValue('DAVE ContentType', (content as { readonly type: number }).type);
	}
}

function readFramedContent(reader: MlsReader): MlsFramedContent {
	const groupId = reader.vector();
	const epoch = reader.uint64();
	const sender = readSender(reader);
	const authenticatedData = reader.vector();
	switch (reader.uint8()) {
		case ContentType.Proposal:
			return validateDaveSenderContent({
				groupId,
				epoch,
				sender,
				authenticatedData,
				type: ContentType.Proposal,
				proposal: readProposal(reader),
			});
		case ContentType.Commit:
			return validateDaveSenderContent({
				groupId,
				epoch,
				sender,
				authenticatedData,
				type: ContentType.Commit,
				commit: readCommit(reader),
			});
		case ContentType.Application:
			return unsupportedValue('DAVE ContentType');
		default:
			return unsupportedValue('ContentType');
	}
}

function writeFramedContentAuthData(
	writer: MlsWriter,
	contentType: MlsFramedContent['type'],
	auth: MlsFramedContentAuthData,
): void {
	writer.vector(auth.signature);
	if (contentType === ContentType.Commit) {
		if (auth.confirmationTag === undefined) {
			throw new TypeError('MLS commit authentication data requires a confirmation tag.');
		}
		writer.vector(auth.confirmationTag);
	} else if (auth.confirmationTag !== undefined) {
		throw new TypeError('MLS proposal authentication data cannot contain a confirmation tag.');
	}
}

function readFramedContentAuthData(reader: MlsReader, contentType: MlsFramedContent['type']): MlsFramedContentAuthData {
	const signature = reader.vector();
	return contentType === ContentType.Commit ? { signature, confirmationTag: reader.vector() } : { signature };
}

function writePublicMessage(writer: MlsWriter, message: MlsPublicMessage): void {
	writeFramedContent(writer, message.content);
	writeFramedContentAuthData(writer, message.content.type, message.auth);
	if (message.content.sender.type === SenderType.Member) {
		if (message.membershipTag === undefined) {
			throw new TypeError('MLS member PublicMessage requires a membership tag.');
		}
		writer.vector(message.membershipTag);
	} else if (message.membershipTag !== undefined) {
		throw new TypeError('MLS external PublicMessage cannot contain a membership tag.');
	}
}

function readPublicMessage(reader: MlsReader): MlsPublicMessage {
	const content = readFramedContent(reader);
	const auth = readFramedContentAuthData(reader, content.type);
	return content.sender.type === SenderType.Member
		? { content, auth, membershipTag: reader.vector() }
		: { content, auth };
}

function writeAuthenticatedContent(writer: MlsWriter, content: MlsAuthenticatedContent): void {
	requireValue(content.wireFormat, WireFormat.PublicMessage, 'DAVE WireFormat');
	writer.uint16(content.wireFormat);
	writeFramedContent(writer, content.content);
	writeFramedContentAuthData(writer, content.content.type, content.auth);
}

function readAuthenticatedContent(reader: MlsReader): MlsAuthenticatedContent {
	const wireFormat = reader.uint16();
	requireValue(wireFormat, WireFormat.PublicMessage, 'DAVE WireFormat');
	const content = readFramedContent(reader);
	return { wireFormat, content, auth: readFramedContentAuthData(reader, content.type) };
}

function writeFramedContentTbsInput(
	writer: MlsWriter,
	input: {
		readonly content: MlsFramedContentTbs;
		readonly groupContext: MlsGroupContext | undefined;
	},
): void {
	writeFramedContentTbs(writer, input.content, input.groupContext);
}

function writeFramedContentTbs(
	writer: MlsWriter,
	content: MlsFramedContentTbs,
	groupContext: MlsGroupContext | undefined,
): void {
	requireValue(content.wireFormat, WireFormat.PublicMessage, 'DAVE WireFormat');
	writer.uint16(ProtocolVersion.Mls10).uint16(content.wireFormat);
	writeFramedContent(writer, content.content);
	if (content.content.sender.type === SenderType.Member) {
		if (groupContext === undefined) throw new TypeError('MLS member FramedContentTBS requires a GroupContext.');
		writeGroupContext(writer, groupContext);
	} else if (groupContext !== undefined) {
		throw new TypeError('MLS external FramedContentTBS cannot contain a GroupContext.');
	}
}

function writeAuthenticatedContentTbmInput(
	writer: MlsWriter,
	input: {
		readonly content: MlsAuthenticatedContent;
		readonly groupContext: MlsGroupContext | undefined;
	},
): void {
	writeFramedContentTbs(writer, input.content, input.groupContext);
	writeFramedContentAuthData(writer, input.content.content.type, input.content.auth);
}

function writeConfirmedTranscriptHashInput(writer: MlsWriter, content: MlsAuthenticatedContent): void {
	requireValue(content.wireFormat, WireFormat.PublicMessage, 'DAVE WireFormat');
	if (content.content.type !== ContentType.Commit) {
		throw new TypeError('MLS ConfirmedTranscriptHashInput requires commit content.');
	}
	writer.uint16(content.wireFormat);
	writeFramedContent(writer, content.content);
	writer.vector(content.auth.signature);
}

function writeGroupContext(writer: MlsWriter, context: MlsGroupContext): void {
	requireMls10(context.version);
	requireDaveCipherSuite(context.cipherSuite);
	writer
		.uint16(context.version)
		.uint16(context.cipherSuite)
		.vector(context.groupId)
		.uint64(context.epoch)
		.vector(context.treeHash)
		.vector(context.confirmedTranscriptHash);
	writeExtensions(writer, context.extensions);
}

function readGroupContext(reader: MlsReader): MlsGroupContext {
	const version = reader.uint16();
	requireMls10(version);
	const cipherSuite = reader.uint16();
	requireDaveCipherSuite(cipherSuite);
	const groupId = reader.vector();
	const epoch = reader.uint64();
	const treeHash = reader.vector();
	const confirmedTranscriptHash = reader.vector();
	const extensions = readExtensions(reader);
	return { version, cipherSuite, groupId, epoch, treeHash, confirmedTranscriptHash, extensions };
}

function writeGroupInfo(writer: MlsWriter, groupInfo: MlsGroupInfo): void {
	writeGroupInfoTbs(writer, groupInfo);
	writer.vector(groupInfo.signature);
}

function writeGroupInfoTbs(writer: MlsWriter, groupInfo: MlsGroupInfoTbs): void {
	writeGroupContext(writer, groupInfo.groupContext);
	writeExtensions(writer, groupInfo.extensions);
	writer.vector(groupInfo.confirmationTag).uint32(groupInfo.signer);
}

function readGroupInfo(reader: MlsReader): MlsGroupInfo {
	return {
		groupContext: readGroupContext(reader),
		extensions: readExtensions(reader),
		confirmationTag: reader.vector(),
		signer: reader.uint32(),
		signature: reader.vector(),
	};
}

function writeEncryptedGroupSecrets(writer: MlsWriter, secrets: MlsEncryptedGroupSecrets): void {
	writer.vector(secrets.newMember);
	writeHpkeCiphertext(writer, secrets.encryptedGroupSecrets);
}

function readEncryptedGroupSecrets(reader: MlsReader): MlsEncryptedGroupSecrets {
	return {
		newMember: reader.vector(),
		encryptedGroupSecrets: readHpkeCiphertext(reader),
	};
}

function writeGroupSecrets(writer: MlsWriter, groupSecrets: MlsGroupSecrets): void {
	writer.vector(groupSecrets.joinerSecret);
	writer.optional(groupSecrets.pathSecret, (output, pathSecret) => output.vector(pathSecret));
	writer.vector(new Uint8Array());
}

function readGroupSecrets(reader: MlsReader): MlsGroupSecrets {
	const joinerSecret = reader.vector();
	const pathSecret = reader.optional(value => value.vector());
	if (reader.vector().byteLength !== 0) throw new TypeError('DAVE GroupSecrets does not support pre-shared keys.');
	return { joinerSecret, pathSecret };
}

function writeWelcome(writer: MlsWriter, welcome: MlsWelcome): void {
	requireDaveCipherSuite(welcome.cipherSuite);
	writer.uint16(welcome.cipherSuite);
	writeItemVector(writer, welcome.secrets, writeEncryptedGroupSecrets);
	writer.vector(welcome.encryptedGroupInfo);
}

function readWelcome(reader: MlsReader): MlsWelcome {
	const cipherSuite = reader.uint16();
	requireDaveCipherSuite(cipherSuite);
	return {
		cipherSuite,
		secrets: reader.vectorItems(readEncryptedGroupSecrets),
		encryptedGroupInfo: reader.vector(),
	};
}

function writeMlsMessage(writer: MlsWriter, message: MlsMessage): void {
	requireMls10(message.version);
	writer.uint16(message.version).uint16(message.wireFormat);
	switch (message.wireFormat) {
		case WireFormat.PublicMessage:
			writePublicMessage(writer, message.publicMessage);
			break;
		case WireFormat.Welcome:
			writeWelcome(writer, message.welcome);
			break;
		case WireFormat.GroupInfo:
			writeGroupInfo(writer, message.groupInfo);
			break;
		case WireFormat.KeyPackage:
			writeKeyPackage(writer, message.keyPackage);
			break;
		default:
			unsupportedValue('DAVE WireFormat', (message as { readonly wireFormat: number }).wireFormat);
	}
}

function readMlsMessage(reader: MlsReader): MlsMessage {
	const version = reader.uint16();
	requireMls10(version);
	switch (reader.uint16()) {
		case WireFormat.PublicMessage:
			return { version, wireFormat: WireFormat.PublicMessage, publicMessage: readPublicMessage(reader) };
		case WireFormat.Welcome:
			return { version, wireFormat: WireFormat.Welcome, welcome: readWelcome(reader) };
		case WireFormat.GroupInfo:
			return { version, wireFormat: WireFormat.GroupInfo, groupInfo: readGroupInfo(reader) };
		case WireFormat.KeyPackage:
			return { version, wireFormat: WireFormat.KeyPackage, keyPackage: readKeyPackage(reader) };
		case WireFormat.PrivateMessage:
			return unsupportedValue('DAVE WireFormat');
		default:
			return unsupportedValue('WireFormat');
	}
}

function encodeStructure<T>(value: T, write: (writer: MlsWriter, value: T) => void): Uint8Array<ArrayBuffer> {
	const writer = new MlsWriter();
	write(writer, value);
	return writer.finish();
}

function decodeStructure<T>(data: Uint8Array, read: (reader: MlsReader) => T, maximumVectorLength?: number): T {
	const reader = new MlsReader(data, maximumVectorLength);
	const value = read(reader);
	reader.assertEnd();
	return value;
}

function writeItemVector<T>(
	writer: MlsWriter,
	values: readonly T[],
	write: (writer: MlsWriter, value: T) => void,
): void {
	writer.vectorWith(vector => {
		for (const value of values) write(vector, value);
	});
}

function writeUint16Vector(writer: MlsWriter, values: readonly number[]): void {
	writer.vectorWith(vector => {
		for (const value of values) vector.uint16(value);
	});
}

function readUint16Vector(reader: MlsReader): readonly number[] {
	return reader.vectorItems(item => item.uint16());
}

function requireMls10(value: number): asserts value is typeof ProtocolVersion.Mls10 {
	requireValue(value, ProtocolVersion.Mls10, 'ProtocolVersion');
}

function requireDaveCipherSuite(value: number): asserts value is typeof CipherSuite.Dave {
	requireValue(value, CipherSuite.Dave, 'DAVE CipherSuite');
}

function requireValue<T extends number>(value: number, expected: T, name: string): asserts value is T {
	if (value === expected) return;
	unsupportedValue(name, value);
}

function unsupportedValue(name: string, value?: number): never {
	const suffix = value === undefined ? '' : ` ${value}`;
	throw new TypeError(`MLS ${name}${suffix} is unsupported.`);
}

function assertIncreasing(values: readonly number[], name: string): void {
	for (let index = 1; index < values.length; index++) {
		if ((values[index - 1] as number) < (values[index] as number)) continue;
		throw new TypeError(`${name} must be strictly increasing.`);
	}
}

function assertRatchetTreeEncoding(nodes: readonly (MlsNode | undefined)[]): void {
	if (nodes.length > 0 && nodes.at(-1) !== undefined) return;
	throw new TypeError('MLS ratchet tree must end in a non-blank node.');
}

function assertDaveSenderContent(content: MlsFramedContent): void {
	if (content.sender.type !== SenderType.External || content.type === ContentType.Proposal) return;
	throw new TypeError('A DAVE external sender can only send proposals.');
}

function validateDaveSenderContent<T extends MlsFramedContent>(content: T): T {
	assertDaveSenderContent(content);
	return content;
}
