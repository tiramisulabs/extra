import { bytesToHex, clearByteMap, concatenateBytes, equalBytes, zeroByteRecord, zeroBytes } from '../bytes';
import type { VoiceCryptoProvider } from '../crypto/provider';
import type { DaveIdentity } from '../dave/identity';
import {
	createSignedMemberCommit,
	finalizeMemberCommitPublicMessage,
	verifyMemberCommitPublicMessage,
} from './handshake';
import { deriveEpochSecrets, exportMlsSecret, type MlsEpochSecrets } from './key-schedule';
import {
	createDaveJoinKeyPackage,
	createDaveLeafMaterial,
	type DaveKeyPackageMaterial,
	type DaveLeafMaterial,
} from './profile';
import {
	type AppliedDaveProposals,
	applyDaveProposals,
	type DaveCachedProposal,
	decodeDaveProposalMessages,
	mergeDaveProposalQueue,
	proposalReferences,
	revokeDaveProposals,
} from './proposals';
import {
	CipherSuite,
	ContentType,
	decodeMlsMessage,
	encodeGroupContext,
	encodeKeyPackage,
	encodeMlsMessage,
	type MlsAuthenticatedContent,
	type MlsCommit,
	type MlsExtension,
	type MlsExternalSender,
	type MlsGroupContext,
	type MlsMessage,
	NodeType,
	ProposalOrRefType,
	ProtocolVersion,
	SenderType,
	WireFormat,
} from './protocol';
import {
	copyDaveExternalSender,
	createInitialDaveMlsGroupState,
	DaveMlsGroupState,
	type DaveMlsRosterEntry,
	equalDaveExternalSenders,
	validateDaveExternalSender,
} from './state';
import {
	computeConfirmationTag,
	updateConfirmedTranscriptHash,
	updateInterimTranscriptHash,
	verifyConfirmationTag,
} from './transcript';
import { leafNodeIndex, type MlsRatchetTree, treeHash } from './tree';
import {
	type CreatedMlsUpdatePath,
	createUpdatePath,
	type MlsProvisionalGroupContextInput,
	mergeUpdatePath,
	type ProcessedMlsUpdatePath,
	processUpdatePath,
} from './treekem';
import { createDaveMlsWelcome, processDaveMlsWelcome } from './welcome';

const ZERO_SECRET = new Uint8Array(32);

export interface DaveMlsGroupInput {
	readonly groupId: Uint8Array;
	readonly userId: string;
}

export type DaveMlsCommitResult = 'accepted' | 'ignored' | 'removed';

export interface DaveMlsOutboundCommit {
	readonly encodedCommit: Uint8Array;
	readonly encodedWelcome: Uint8Array | undefined;
	readonly payload: Uint8Array;
}

interface PreparedDaveMlsCommit {
	readonly encodedCommit: Uint8Array;
	readonly nextState: DaveMlsGroupState;
	readonly outbound: DaveMlsOutboundCommit;
}

export class DaveMlsGroup {
	readonly #provider: VoiceCryptoProvider;
	readonly #identity: DaveIdentity;
	readonly #groupId: Uint8Array;
	readonly #leafMaterial: DaveLeafMaterial;
	#externalSender?: MlsExternalSender;
	#joinKeyPackage?: DaveKeyPackageMaterial;
	#pending?: DaveMlsGroupState;
	#current?: DaveMlsGroupState;
	#proposals: readonly DaveCachedProposal[] = Object.freeze([]);
	#prepared?: PreparedDaveMlsCommit;
	#joinMaterialClosed = false;
	#closed = false;

	constructor(provider: VoiceCryptoProvider, identity: DaveIdentity, input: DaveMlsGroupInput) {
		if (input.groupId.byteLength === 0) throw new TypeError('A DAVE MLS group ID cannot be empty.');
		this.#provider = provider;
		this.#identity = identity;
		this.#groupId = input.groupId.slice();
		this.#leafMaterial = createDaveLeafMaterial(provider, identity, input.userId);
	}

	get established(): boolean {
		return this.#current !== undefined;
	}

	get hasPendingGroup(): boolean {
		return this.#pending !== undefined;
	}

	get epoch(): bigint | undefined {
		return this.#current?.context.epoch;
	}

	get roster(): ReadonlyMap<string, DaveMlsRosterEntry> {
		this.assertOpen();
		const roster = this.requireCurrent().roster;
		return new Map(
			[...roster].map(([userId, entry]) => [
				userId,
				Object.freeze({
					...entry,
					signatureKey: entry.signatureKey.slice(),
					encryptionKey: entry.encryptionKey.slice(),
				}),
			]),
		);
	}

	get epochAuthenticator(): Uint8Array {
		this.assertOpen();
		return this.requireCurrent().secrets.epochAuthenticator.slice();
	}

	installExternalSender(externalSender: MlsExternalSender): void {
		this.assertOpen();
		validateDaveExternalSender(this.#provider, externalSender);
		if (this.#externalSender !== undefined) {
			if (equalDaveExternalSenders(this.#externalSender, externalSender)) return;
			throw new TypeError('The DAVE external sender cannot change during an MLS group lifetime.');
		}
		const installedSender = copyDaveExternalSender(externalSender);
		const pending = createInitialDaveMlsGroupState(this.#provider, this.#leafMaterial, this.#groupId, installedSender);
		this.#externalSender = installedSender;
		this.#pending = pending;
	}

	createKeyPackage(): Uint8Array {
		this.assertOpen();
		this.assertJoinMaterialOpen();
		const next = createDaveJoinKeyPackage(this.#provider, this.#identity, this.#leafMaterial);
		this.#joinKeyPackage?.close();
		this.#joinKeyPackage = next;
		// Discord's deployed Voice Gateway validates opcode 26 as a bare KeyPackage, despite the
		// current DAVE whitepaper describing an MLSMessage wrapper. Keep the wrapper in the MLS model.
		return encodeKeyPackage(next.keyPackage);
	}

	appendProposals(
		encodedMessages: Uint8Array,
		expectedUserIds: ReadonlySet<string>,
	): DaveMlsOutboundCommit | undefined {
		this.assertOpen();
		const base = this.requireBaseState();
		const externalSender = this.requireExternalSender();
		const appended = decodeDaveProposalMessages(
			this.#provider,
			encodedMessages,
			base.context,
			externalSender,
			expectedUserIds,
		);
		const proposals = mergeDaveProposalQueue(this.#proposals, appended);
		const prepared = this.createPreparedCommit(base, proposals);
		this.replaceProposalState(proposals, prepared);
		return prepared === undefined ? undefined : copyOutbound(prepared.outbound);
	}

	revokeProposals(references: readonly Uint8Array[]): DaveMlsOutboundCommit | undefined {
		this.assertOpen();
		const proposals = revokeDaveProposals(this.#proposals, references);
		if (proposals.length === 0) {
			this.replaceProposalState(proposals, undefined);
			return undefined;
		}
		const prepared = this.createPreparedCommit(this.requireBaseState(), proposals);
		this.replaceProposalState(proposals, prepared);
		return prepared === undefined ? undefined : copyOutbound(prepared.outbound);
	}

	prepareCommit(): DaveMlsOutboundCommit {
		this.assertOpen();
		if (this.#proposals.length === 0) throw new Error('A DAVE commit requires at least one queued proposal.');
		const prepared = this.createPreparedCommit(this.requireBaseState(), this.#proposals);
		if (prepared === undefined) throw new Error('A DAVE member cannot prepare a commit that removes itself.');
		this.replacePrepared(prepared);
		return copyOutbound(prepared.outbound);
	}

	activatePending(): void {
		this.assertOpen();
		if (this.#current !== undefined) throw new Error('The DAVE MLS group is already established.');
		if (this.#pending === undefined) throw new Error('No pending DAVE MLS epoch-zero group is available.');
		if (this.#proposals.length !== 0 || this.#prepared !== undefined) {
			throw new Error('A DAVE MLS group with queued proposals cannot activate epoch zero directly.');
		}
		this.#current = this.#pending;
		this.#pending = undefined;
		this.closeJoinMaterial();
	}

	acceptCommit(encodedCommit: Uint8Array): DaveMlsCommitResult {
		this.assertOpen();
		if (this.#proposals.length === 0) return 'ignored';
		const cached = this.#prepared;
		if (cached !== undefined && equalBytes(cached.encodedCommit, encodedCommit)) {
			this.#prepared = undefined;
			this.promote(cached.nextState);
			return 'accepted';
		}
		const message = decodeMlsMessage(encodedCommit);
		if (
			message.wireFormat === WireFormat.PublicMessage &&
			!equalBytes(message.publicMessage.content.groupId, this.#groupId)
		) {
			return 'ignored';
		}
		if (this.#current === undefined) this.assertCommitReferencesAllQueued(message);
		const nextState = this.processRemoteCommit(this.#current, message);
		if (nextState === undefined) {
			this.clearGroupState();
			return 'removed';
		}
		this.promote(nextState);
		return 'accepted';
	}

	processWelcome(encodedWelcome: Uint8Array): void {
		this.assertOpen();
		if (this.#current !== undefined) throw new Error('An established DAVE MLS group cannot process a Welcome.');
		const joinKeyPackage = this.#joinKeyPackage;
		if (joinKeyPackage === undefined) throw new Error('A DAVE Welcome requires the latest local KeyPackage.');
		const state = processDaveMlsWelcome(this.#provider, {
			encodedWelcome,
			externalSender: this.requireExternalSender(),
			groupId: this.#groupId,
			joinKeyPackage,
		});
		this.promote(state);
	}

	exportSecret(label: string, context: Uint8Array, length: number): Uint8Array {
		this.assertOpen();
		return exportMlsSecret(this.#provider, this.requireCurrent().secrets.exporterSecret, label, context, length);
	}

	getVerificationKey(userId: string): Uint8Array {
		this.assertOpen();
		const entry = this.requireCurrent().roster.get(userId);
		if (entry === undefined) throw new Error('The requested DAVE participant is unavailable.');
		return entry.signatureKey.slice();
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#prepared?.nextState.close();
		this.#prepared = undefined;
		this.#pending?.close();
		this.#pending = undefined;
		this.#current?.close();
		this.#current = undefined;
		this.#proposals = Object.freeze([]);
		this.closeJoinMaterial();
	}

	private createPreparedCommit(
		base: DaveMlsGroupState,
		proposals: readonly DaveCachedProposal[],
	): PreparedDaveMlsCommit | undefined {
		const applied = applyDaveProposals(this.#provider, base.tree, proposals, base.context.groupId);
		assertAddInitKeys(this.#provider, applied.tree, applied.added);
		if (applied.removedLeafIndexes.has(base.selfLeafIndex)) return undefined;
		const requiresPath = applied.removedLeafIndexes.size > 0;
		let createdPath: CreatedMlsUpdatePath | undefined;
		let commitSecret: Uint8Array = ZERO_SECRET.slice();
		let privateKeys: Map<number, Uint8Array> | undefined;
		let basePrivateKeys: readonly (readonly [number, Uint8Array])[] | undefined;
		let pathPrivateKeys: ReadonlyMap<number, Uint8Array> | undefined;
		let epochSecrets: MlsEpochSecrets | undefined;
		let nextState: DaveMlsGroupState | undefined;
		try {
			if (requiresPath) {
				createdPath = createUpdatePath(this.#provider, {
					tree: applied.tree,
					senderLeafIndex: base.selfLeafIndex,
					identity: this.#identity,
					groupContext: nextProvisionalContext(base),
					excludedNewLeafIndices: applied.added.map(add => add.leafIndex),
				});
				commitSecret.fill(0);
				commitSecret = createdPath.secrets.commitSecret;
			}
			const commit: MlsCommit = {
				proposals: proposalReferences(proposals),
				path: createdPath?.updatePath,
			};
			const signed = createSignedMemberCommit(this.#identity, {
				groupContext: base.context,
				leafIndex: base.selfLeafIndex,
				commit,
			});
			const authenticatedContent: MlsAuthenticatedContent = {
				wireFormat: signed.wireFormat,
				content: signed.content,
				auth: { signature: signed.signature },
			};
			const confirmedTranscriptHash = updateConfirmedTranscriptHash(
				this.#provider,
				base.interimTranscriptHash,
				authenticatedContent,
			);
			const tree = createdPath?.tree ?? applied.tree;
			const context = createNextGroupContext(this.#provider, base, tree, confirmedTranscriptHash);
			epochSecrets = deriveEpochSecrets(
				this.#provider,
				base.secrets.initSecret,
				commitSecret,
				encodeGroupContext(context),
			);
			const confirmationTag = computeConfirmationTag(
				this.#provider,
				epochSecrets.confirmationKey,
				confirmedTranscriptHash,
			);
			const publicMessage = finalizeMemberCommitPublicMessage(
				this.#provider,
				signed,
				base.context,
				confirmationTag,
				base.secrets.membershipKey,
			);
			basePrivateKeys = base.getPrivateKeyEntries();
			pathPrivateKeys = createdPath?.secrets.privateKeys;
			privateKeys = mergeMatchingPrivateKeys(this.#provider, tree, basePrivateKeys, pathPrivateKeys ?? []);
			const { joinerSecret: _joinerSecret, welcomeSecret: _welcomeSecret, ...stateSecrets } = epochSecrets;
			nextState = DaveMlsGroupState.create(this.#provider, {
				tree,
				selfLeafIndex: base.selfLeafIndex,
				privateKeys,
				context,
				interimTranscriptHash: updateInterimTranscriptHash(this.#provider, confirmedTranscriptHash, confirmationTag),
				confirmationTag,
				secrets: stateSecrets,
			});
			const commitMessage: MlsMessage = {
				version: ProtocolVersion.Mls10,
				wireFormat: WireFormat.PublicMessage,
				publicMessage,
			};
			const encodedCommit = encodeMlsMessage(commitMessage);
			const encodedWelcome = createDaveMlsWelcome(this.#provider, this.#identity, {
				state: nextState,
				secrets: epochSecrets,
				added: applied.added,
				createdPath,
			});
			const outbound = createOutbound(encodedCommit, encodedWelcome);
			const prepared = Object.freeze({ encodedCommit: encodedCommit.slice(), nextState, outbound });
			nextState = undefined;
			return prepared;
		} finally {
			commitSecret.fill(0);
			createdPath?.secrets.close();
			zeroPrivateKeyEntries(basePrivateKeys);
			zeroBytes(pathPrivateKeys?.values() ?? []);
			if (privateKeys !== undefined) clearByteMap(privateKeys);
			if (epochSecrets !== undefined) zeroByteRecord(epochSecrets);
			nextState?.close();
		}
	}

	private processRemoteCommit(base: DaveMlsGroupState, message: MlsMessage): DaveMlsGroupState | undefined {
		if (message.wireFormat !== WireFormat.PublicMessage) throw new TypeError('Expected an MLS PublicMessage commit.');
		const publicMessage = message.publicMessage;
		if (publicMessage.content.type !== ContentType.Commit || publicMessage.content.sender.type !== SenderType.Member) {
			throw new TypeError('Expected a DAVE MLS member Commit.');
		}
		if (publicMessage.content.authenticatedData.byteLength !== 0) {
			throw new TypeError('DAVE commit authenticated data must be empty.');
		}
		const senderLeafIndex = publicMessage.content.sender.leafIndex;
		const senderNode = base.tree[leafNodeIndex(senderLeafIndex)];
		if (senderNode?.type !== NodeType.Leaf) throw new TypeError('The DAVE commit sender is not in the roster.');
		const authenticatedContent = verifyMemberCommitPublicMessage(
			this.#provider,
			publicMessage,
			base.context,
			senderNode.leafNode.signatureKey,
			base.secrets.membershipKey,
		);
		const selectedProposals = selectReferencedProposals(publicMessage.content.commit, this.#proposals);
		const applied = applyDaveProposals(this.#provider, base.tree, selectedProposals, base.context.groupId);
		assertAddInitKeys(this.#provider, applied.tree, applied.added);
		if (applied.removedLeafIndexes.has(senderLeafIndex)) {
			throw new TypeError('A DAVE committer cannot remove its own leaf.');
		}
		if (applied.removedLeafIndexes.size > 0 && publicMessage.content.commit.path === undefined) {
			throw new TypeError('A DAVE commit containing a Remove proposal requires an UpdatePath.');
		}
		if (applied.removedLeafIndexes.has(base.selfLeafIndex)) {
			mergeUpdatePath(this.#provider, {
				tree: applied.tree,
				senderLeafIndex,
				updatePath: publicMessage.content.commit.path as NonNullable<MlsCommit['path']>,
				groupId: base.context.groupId,
				excludedNewLeafIndices: applied.added.map(add => add.leafIndex),
			});
			return undefined;
		}

		let processedPath: ProcessedMlsUpdatePath | undefined;
		let commitSecret: Uint8Array = ZERO_SECRET.slice();
		let privateKeys: Map<number, Uint8Array> | undefined;
		let basePrivateKeys: readonly (readonly [number, Uint8Array])[] | undefined;
		let pathPrivateKeys: ReadonlyMap<number, Uint8Array> | undefined;
		let epochSecrets: MlsEpochSecrets | undefined;
		try {
			basePrivateKeys = base.getPrivateKeyEntries();
			const oldKeys = matchingPrivateKeyEntries(this.#provider, applied.tree, basePrivateKeys);
			try {
				if (publicMessage.content.commit.path !== undefined) {
					processedPath = processUpdatePath(this.#provider, {
						tree: applied.tree,
						senderLeafIndex,
						updatePath: publicMessage.content.commit.path,
						groupContext: nextProvisionalContext(base),
						privateKeys: oldKeys,
						excludedNewLeafIndices: applied.added.map(add => add.leafIndex),
					});
					commitSecret.fill(0);
					commitSecret = processedPath.secrets.commitSecret;
				}
			} finally {
				clearByteMap(oldKeys);
				zeroPrivateKeyEntries(basePrivateKeys);
				basePrivateKeys = undefined;
			}
			const confirmedTranscriptHash = updateConfirmedTranscriptHash(
				this.#provider,
				base.interimTranscriptHash,
				authenticatedContent,
			);
			const tree = processedPath?.tree ?? applied.tree;
			const context = createNextGroupContext(this.#provider, base, tree, confirmedTranscriptHash);
			epochSecrets = deriveEpochSecrets(
				this.#provider,
				base.secrets.initSecret,
				commitSecret,
				encodeGroupContext(context),
			);
			const confirmationTag = publicMessage.auth.confirmationTag as Uint8Array;
			if (
				!verifyConfirmationTag(this.#provider, epochSecrets.confirmationKey, confirmedTranscriptHash, confirmationTag)
			) {
				throw new TypeError('The DAVE commit confirmation tag is invalid.');
			}
			basePrivateKeys = base.getPrivateKeyEntries();
			pathPrivateKeys = processedPath?.secrets.privateKeys;
			privateKeys = mergeMatchingPrivateKeys(this.#provider, tree, basePrivateKeys, pathPrivateKeys ?? []);
			const { joinerSecret: _joinerSecret, welcomeSecret: _welcomeSecret, ...stateSecrets } = epochSecrets;
			return DaveMlsGroupState.create(this.#provider, {
				tree,
				selfLeafIndex: base.selfLeafIndex,
				privateKeys,
				context,
				interimTranscriptHash: updateInterimTranscriptHash(this.#provider, confirmedTranscriptHash, confirmationTag),
				confirmationTag,
				secrets: stateSecrets,
			});
		} finally {
			commitSecret.fill(0);
			processedPath?.secrets.close();
			zeroPrivateKeyEntries(basePrivateKeys);
			zeroBytes(pathPrivateKeys?.values() ?? []);
			if (privateKeys !== undefined) clearByteMap(privateKeys);
			if (epochSecrets !== undefined) zeroByteRecord(epochSecrets);
		}
	}

	private assertCommitReferencesAllQueued(message: MlsMessage): never {
		if (message.wireFormat !== WireFormat.PublicMessage || message.publicMessage.content.type !== ContentType.Commit) {
			throw new TypeError('A pending DAVE group only accepts an MLS PublicMessage commit.');
		}
		selectReferencedProposals(message.publicMessage.content.commit, this.#proposals);
		throw new TypeError('A pending DAVE group only accepts its exact cached epoch-zero commit.');
	}

	private replaceProposalState(
		proposals: readonly DaveCachedProposal[],
		prepared: PreparedDaveMlsCommit | undefined,
	): void {
		this.#proposals = proposals;
		this.replacePrepared(prepared);
	}

	private replacePrepared(prepared: PreparedDaveMlsCommit | undefined): void {
		const previous = this.#prepared;
		this.#prepared = prepared;
		previous?.nextState.close();
	}

	private promote(nextState: DaveMlsGroupState): void {
		const previousCurrent = this.#current;
		const previousPending = this.#pending;
		const stalePrepared = this.#prepared;
		this.#current = nextState;
		this.#pending = undefined;
		this.#prepared = undefined;
		this.#proposals = Object.freeze([]);
		if (previousCurrent !== nextState) previousCurrent?.close();
		if (previousPending !== nextState) previousPending?.close();
		if (stalePrepared?.nextState !== nextState) stalePrepared?.nextState.close();
		this.closeJoinMaterial();
	}

	private clearGroupState(): void {
		this.#current?.close();
		this.#current = undefined;
		this.#pending?.close();
		this.#pending = undefined;
		this.#prepared?.nextState.close();
		this.#prepared = undefined;
		this.#proposals = Object.freeze([]);
		this.closeJoinMaterial();
	}

	private closeJoinMaterial(): void {
		if (this.#joinMaterialClosed) return;
		this.#joinMaterialClosed = true;
		this.#joinKeyPackage?.close();
		this.#joinKeyPackage = undefined;
		this.#leafMaterial.close();
	}

	private requireBaseState(): DaveMlsGroupState {
		const state = this.#pending ?? this.#current;
		if (state !== undefined) return state;
		throw new Error('DAVE proposals require a pending or established MLS group.');
	}

	private requireCurrent(): DaveMlsGroupState {
		if (this.#current !== undefined) return this.#current;
		throw new Error('The DAVE MLS group is not established.');
	}

	private requireExternalSender(): MlsExternalSender {
		if (this.#externalSender !== undefined) return this.#externalSender;
		throw new Error('The DAVE MLS external sender is unavailable.');
	}

	private assertJoinMaterialOpen(): void {
		if (!this.#joinMaterialClosed) return;
		throw new Error('DAVE join material is unavailable after the group is established.');
	}

	private assertOpen(): void {
		if (!this.#closed) return;
		throw new Error('The DAVE MLS group is closed.');
	}
}

function createNextGroupContext(
	provider: VoiceCryptoProvider,
	base: DaveMlsGroupState,
	tree: MlsRatchetTree,
	confirmedTranscriptHash: Uint8Array,
): MlsGroupContext {
	return Object.freeze({
		version: ProtocolVersion.Mls10,
		cipherSuite: CipherSuite.Dave,
		groupId: base.context.groupId.slice(),
		epoch: base.context.epoch + 1n,
		treeHash: treeHash(provider, tree),
		confirmedTranscriptHash,
		extensions: copyExtensions(base.context.extensions),
	});
}

function nextProvisionalContext(base: DaveMlsGroupState): MlsProvisionalGroupContextInput {
	return {
		version: ProtocolVersion.Mls10,
		cipherSuite: CipherSuite.Dave,
		groupId: base.context.groupId,
		epoch: base.context.epoch + 1n,
		confirmedTranscriptHash: base.context.confirmedTranscriptHash,
		extensions: base.context.extensions,
	};
}

function createOutbound(encodedCommit: Uint8Array, encodedWelcome: Uint8Array | undefined): DaveMlsOutboundCommit {
	return Object.freeze({
		encodedCommit: encodedCommit.slice(),
		encodedWelcome: encodedWelcome?.slice(),
		payload: encodedWelcome === undefined ? encodedCommit.slice() : concatenateBytes(encodedCommit, encodedWelcome),
	});
}

function copyOutbound(outbound: DaveMlsOutboundCommit): DaveMlsOutboundCommit {
	return Object.freeze({
		encodedCommit: outbound.encodedCommit.slice(),
		encodedWelcome: outbound.encodedWelcome?.slice(),
		payload: outbound.payload.slice(),
	});
}

function selectReferencedProposals(
	commit: MlsCommit,
	queued: readonly DaveCachedProposal[],
): readonly DaveCachedProposal[] {
	if (commit.proposals.length === 0) throw new TypeError('A DAVE commit must contain at least one ProposalRef.');
	if (commit.proposals.length !== queued.length) {
		throw new TypeError('A DAVE commit must reference every queued unrevoked proposal exactly once.');
	}
	const selected: DaveCachedProposal[] = [];
	const seen = new Set<string>();
	for (const proposal of commit.proposals) {
		if (proposal.type !== ProposalOrRefType.Reference) {
			throw new TypeError('A DAVE commit can only contain ProposalRef entries.');
		}
		const key = bytesToHex(proposal.reference);
		if (seen.has(key)) throw new TypeError('A DAVE commit cannot repeat a ProposalRef.');
		const cached = queued.find(candidate => equalBytes(candidate.reference, proposal.reference));
		if (cached === undefined) throw new TypeError('A DAVE commit references an unknown or revoked proposal.');
		seen.add(key);
		selected.push(cached);
	}
	return Object.freeze(selected);
}

function mergeMatchingPrivateKeys(
	provider: VoiceCryptoProvider,
	tree: MlsRatchetTree,
	...sources: readonly Iterable<readonly [number, Uint8Array]>[]
): Map<number, Uint8Array> {
	const merged = new Map<number, Uint8Array>();
	for (const source of sources) {
		for (const [nodeIndex, privateKey] of source) {
			if (!privateKeyMatchesNode(provider, tree, nodeIndex, privateKey)) continue;
			merged.get(nodeIndex)?.fill(0);
			merged.set(nodeIndex, privateKey.slice());
		}
	}
	return merged;
}

function matchingPrivateKeyEntries(
	provider: VoiceCryptoProvider,
	tree: MlsRatchetTree,
	entries: readonly (readonly [number, Uint8Array])[],
): Map<number, Uint8Array> {
	return mergeMatchingPrivateKeys(provider, tree, entries);
}

function privateKeyMatchesNode(
	provider: VoiceCryptoProvider,
	tree: MlsRatchetTree,
	nodeIndex: number,
	privateKey: Uint8Array,
): boolean {
	const node = tree[nodeIndex];
	if (node === undefined) return false;
	const publicKey = node.type === NodeType.Leaf ? node.leafNode.encryptionKey : node.parentNode.encryptionKey;
	try {
		return equalBytes(provider.getP256PublicKey(privateKey), publicKey);
	} catch {
		return false;
	}
}

function assertAddInitKeys(
	provider: VoiceCryptoProvider,
	baseTree: MlsRatchetTree,
	added: AppliedDaveProposals['added'],
): void {
	const usedKeys: Uint8Array[] = [];
	for (const node of baseTree) {
		if (node === undefined) continue;
		usedKeys.push(node.type === NodeType.Leaf ? node.leafNode.encryptionKey : node.parentNode.encryptionKey);
		if (node.type === NodeType.Leaf) usedKeys.push(node.leafNode.signatureKey);
	}
	for (const member of added) {
		provider.validateP256PublicKey(member.keyPackage.initKey);
		if (usedKeys.some(key => equalBytes(key, member.keyPackage.initKey))) {
			throw new TypeError('A DAVE Add KeyPackage init key must be unique within the group.');
		}
		usedKeys.push(member.keyPackage.initKey);
	}
}

function copyExtensions(extensions: readonly MlsExtension[]): readonly MlsExtension[] {
	return Object.freeze(
		extensions.map(extension => Object.freeze({ type: extension.type, data: extension.data.slice() })),
	);
}

function zeroPrivateKeyEntries(entries: readonly (readonly [number, Uint8Array])[] | undefined): void {
	if (entries === undefined) return;
	for (const [, privateKey] of entries) privateKey.fill(0);
}
