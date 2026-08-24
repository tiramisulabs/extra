import { equalBytes } from '../bytes';
import { VoiceCryptoProvider } from '../crypto/provider';
import { isOpusSilenceFrame, MAX_OPUS_PACKET_SIZE } from '../media/opus';
import { DaveMlsGroup, type DaveMlsOutboundCommit } from '../mls/group';
import type { MlsExternalSender } from '../mls/protocol';
import { copyDaveExternalSender, equalDaveExternalSenders } from '../mls/state';
import { unrefTimer } from '../runtime/adapter';
import { DaveAudioDecryptor, DaveAudioEncryptor, parseDaveAudioFrame } from './audio';
import { DaveIdentity } from './identity';
import {
	type DavePrepareEpochData,
	parseDaveExternalSenderPayload,
	parseDaveJsonData,
	parseDaveMlsProposalsPayload,
	parseDaveMlsTransitionPayload,
} from './protocol';
import type { DaveSession, DaveSessionCallbacks, DaveSessionFactoryResource, DaveSessionInput } from './types';
import {
	createDaveEpochAuthenticatorCode,
	deriveDavePairwiseVerificationCode,
	encodeSnowflakeBigEndian,
	encodeSnowflakeLittleEndian,
} from './verification';
import { DaveVerificationError } from './verification-error';

/**
 * Shares one ephemeral identity while a manager has active sessions or recovery leases. Once the
 * last reference is released, a later connection starts with a new protocol identity.
 *
 * @internal
 */
export function createDaveSessionFactory(): DaveSessionFactoryResource {
	const provider = new VoiceCryptoProvider();
	let identity: DaveIdentity | undefined;
	let references = 0;
	let closed = false;
	const releaseReference = () => {
		references--;
		if (references !== 0) return;
		identity?.close();
		identity = undefined;
	};
	const retain = () => {
		if (closed) throw new Error('The DAVE session factory is closed.');
		if (!identity || references === 0) throw new Error('No active DAVE identity is available to retain.');
		references++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			releaseReference();
		};
	};

	const factory = ((input: DaveSessionInput, callbacks: DaveSessionCallbacks): DaveSession => {
		if (closed) throw new Error('The DAVE session factory is closed.');
		identity ??= new DaveIdentity(provider);
		references++;
		let session: DaveSession;
		try {
			session = new DaveSessionEngine(provider, identity, input, callbacks, releaseReference);
		} catch (error) {
			releaseReference();
			throw error;
		}
		return session;
	}) as DaveSessionFactoryResource;

	factory.retain = retain;
	factory.close = () => {
		closed = true;
		if (references !== 0) return;
		identity?.close();
		identity = undefined;
	};
	return factory;
}

interface DavePreparedTransition {
	readonly protocolVersion: number;
	readonly epoch: bigint | undefined;
	readonly group: DaveMlsGroup | undefined;
	readonly removed: boolean;
}

interface DaveEpochPreparation {
	readonly protocolVersion: number;
	readonly epoch: bigint;
	readonly transitionId: number | undefined;
	readonly generation: number;
}

interface DaveReceiveEpochContext {
	readonly group: DaveMlsGroup;
	readonly epoch: bigint;
	readonly decryptors: Map<string, DaveAudioDecryptor>;
	expiresAt?: number;
}

const DAVE_TRANSITION_RETENTION_MS = 10_000;

class DaveSessionEngine implements DaveSession {
	readonly maxProtocolVersion = 1;
	readonly #provider: VoiceCryptoProvider;
	readonly #identity: DaveIdentity;
	readonly #input: DaveSessionInput;
	readonly #callbacks: DaveSessionCallbacks;
	readonly #release: () => void;
	readonly #groupId: Uint8Array;
	#activeProtocolVersion = 0;
	#activeEpoch: bigint | undefined;
	#groupProtocolVersion: number | undefined;
	#ready = true;
	#closed = false;
	#released = false;
	#externalSender?: MlsExternalSender;
	#group?: DaveMlsGroup;
	#authoritativeGroup?: DaveMlsGroup;
	#groupGeneration = 0;
	#epochPreparation?: DaveEpochPreparation;
	#expectedUserIds = new Set<string>();
	#preparedTransitions = new Map<number, DavePreparedTransition>();
	#audioEncryptor?: DaveAudioEncryptor;
	#audioGroup?: DaveMlsGroup;
	#audioEpoch?: bigint;
	#receiveEpochs: DaveReceiveEpochContext[] = [];
	#receivePassthroughUntil = Number.POSITIVE_INFINITY;
	#receiveExpiryTimer?: ReturnType<typeof setTimeout>;

	constructor(
		provider: VoiceCryptoProvider,
		identity: DaveIdentity,
		input: DaveSessionInput,
		callbacks: DaveSessionCallbacks,
		release: () => void,
	) {
		this.#provider = provider;
		this.#identity = identity;
		this.#input = input;
		this.#callbacks = callbacks;
		this.#release = release;
		this.#groupId = encodeSnowflakeBigEndian(input.channelId);
		this.#expectedUserIds.add(input.userId);
		callbacks.onReady();
	}

	get ready(): boolean {
		return this.#ready;
	}

	async setProtocolVersion(version: number): Promise<void> {
		this.assertOpen();
		this.assertProtocolVersion(version);
		if (version === 0) {
			this.#activeProtocolVersion = 0;
			this.#activeEpoch = undefined;
			this.#groupProtocolVersion = undefined;
			this.clearAudioEncryptor();
			this.markReceiveEpochsExpiring();
			this.#receivePassthroughUntil = Number.POSITIVE_INFINITY;
			this.clearAllGroupState();
			this.#callbacks.onVoicePrivacyCodeChange(null);
			this.markReady();
			return;
		}

		this.#groupProtocolVersion = version;
		this.replaceWorkingGroup();
		this.#callbacks.onVoicePrivacyCodeChange(null);
		this.sendFreshKeyPackage();
	}

	async handleJsonMessage(opcode: number, data: unknown): Promise<void> {
		this.assertOpen();
		switch (opcode) {
			case 11: {
				const message = parseDaveJsonData(11, data);
				for (const userId of message.userIds) this.#expectedUserIds.add(userId);
				break;
			}
			case 13: {
				const userId = parseDaveJsonData(13, data).userId;
				if (userId !== this.#input.userId) this.#expectedUserIds.delete(userId);
				break;
			}
			case 21: {
				const message = parseDaveJsonData(21, data);
				this.prepareAnnouncedTransition(message.transitionId, message.protocolVersion);
				break;
			}
			case 22:
				this.executeTransition(parseDaveJsonData(22, data).transitionId);
				break;
			case 24:
				this.prepareEpoch(parseDaveJsonData(24, data));
				break;
			default:
				throw new TypeError(`Unsupported DAVE JSON opcode ${opcode}.`);
		}
	}

	async handleBinaryMessage(opcode: number, data: Uint8Array): Promise<void> {
		this.assertOpen();
		switch (opcode) {
			case 25:
				this.installExternalSender(parseDaveExternalSenderPayload(data, this.#provider));
				break;
			case 27:
				this.processProposals(data);
				break;
			case 29:
				await this.processCommitTransition(data);
				break;
			case 30:
				await this.processWelcomeTransition(data);
				break;
			default:
				throw new TypeError(`Unsupported DAVE binary opcode ${opcode}.`);
		}
	}

	async getVerificationCode(userId: string): Promise<string> {
		this.assertOpen();
		const group = this.#authoritativeGroup;
		if (!group || group.epoch === undefined || group.epoch === 0n) {
			throw new DaveVerificationError('participant_not_present');
		}
		let participantKey: Uint8Array;
		try {
			participantKey = group.getVerificationKey(userId);
		} catch (error) {
			throw new DaveVerificationError('participant_not_present', { cause: error });
		}
		let code: string;
		try {
			code = await deriveDavePairwiseVerificationCode(
				this.#provider,
				{ userId: this.#input.userId, publicKey: this.#identity.publicKey },
				{ userId, publicKey: participantKey },
			);
		} catch (error) {
			throw new DaveVerificationError('derivation_failed', { cause: error });
		}
		// Pairwise derivation is asynchronous, so the group and participant key must still be current.
		if (this.#authoritativeGroup !== group) {
			throw new DaveVerificationError('participant_changed');
		}
		let currentKey: Uint8Array;
		try {
			currentKey = group.getVerificationKey(userId);
		} catch (error) {
			throw new DaveVerificationError('participant_changed', { cause: error });
		}
		if (!equalBytes(currentKey, participantKey)) {
			throw new DaveVerificationError('participant_changed');
		}
		return code;
	}

	transformAudioFrame(frame: Uint8Array): Uint8Array {
		this.assertOpen();
		if (this.#activeProtocolVersion === 0) return frame.slice();
		if (!this.#ready || !this.#audioEncryptor) {
			throw new Error('The active DAVE protocol context cannot encrypt audio.');
		}
		return this.#audioEncryptor.encrypt(frame);
	}

	transformReceivedAudioFrame(userId: string, frame: Uint8Array): Uint8Array | undefined {
		this.assertOpen();
		if (isOpusSilenceFrame(frame)) return frame.slice();
		const parsed = parseDaveAudioFrame(frame);
		if (!parsed) {
			return this.receivePassthroughAllowed() && frame.byteLength <= MAX_OPUS_PACKET_SIZE ? frame.slice() : undefined;
		}
		this.cleanupReceiveEpochs();
		for (const context of this.#receiveEpochs) {
			const decrypted = context.decryptors.get(userId)?.decrypt(parsed);
			if (decrypted && decrypted.byteLength <= MAX_OPUS_PACKET_SIZE) return decrypted;
			decrypted?.fill(0);
		}
		return undefined;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#ready = false;
		const errors: unknown[] = [];
		try {
			this.#callbacks.onVoicePrivacyCodeChange(null);
		} catch (error) {
			errors.push(error);
		}
		try {
			this.clearAudioEncryptor();
			this.clearReceiveEpochs();
			this.clearAllGroupState();
		} catch (error) {
			errors.push(error);
		}
		try {
			this.releaseFactory();
		} catch (error) {
			errors.push(error);
		}
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, 'Failed to close the DAVE session.');
	}

	private installExternalSender(externalSender: MlsExternalSender): void {
		if (this.#externalSender && !equalDaveExternalSenders(this.#externalSender, externalSender)) {
			throw new TypeError('The Voice Gateway sent conflicting DAVE external senders.');
		}
		this.#externalSender ??= copyDaveExternalSender(externalSender);
		this.#group?.installExternalSender(this.#externalSender);
	}

	private processProposals(data: Uint8Array): void {
		const message = parseDaveMlsProposalsPayload(data);
		const group = this.#group;
		if (!group) return;
		let outbound: DaveMlsOutboundCommit | undefined;
		try {
			outbound =
				message.operation === 'append'
					? group.appendProposals(message.encodedProposalMessages, this.#expectedUserIds)
					: group.revokeProposals(message.proposalRefs);
		} catch {
			// DAVE treats an unprocessable proposal as a no-op; malformed opcode framing fails above.
			return;
		}
		this.sendCommitWelcome(outbound);
	}

	private async processCommitTransition(data: Uint8Array): Promise<void> {
		const message = parseDaveMlsTransitionPayload(data);
		const group = this.#group;
		if (!group) return;
		const previousEpoch = group.epoch;
		let result: ReturnType<DaveMlsGroup['acceptCommit']>;
		let epoch: bigint;
		try {
			result = group.acceptCommit(message.encodedMessage);
			if (result === 'ignored') return;
			epoch = result === 'accepted' ? this.requireEstablishedEpoch(group) : this.nextEpoch(previousEpoch);
			this.assertExpectedEpoch(message.transitionId, epoch);
		} catch {
			await this.recoverInvalidTransition(message.transitionId);
			return;
		}

		this.#epochPreparation = undefined;
		if (result === 'removed') {
			this.handleLocalRemoval(group, message.transitionId, epoch);
			return;
		}
		this.adoptAuthoritativeGroup(group);
		this.prepareProcessedTransition(message.transitionId, epoch, group);
	}

	private async processWelcomeTransition(data: Uint8Array): Promise<void> {
		const message = parseDaveMlsTransitionPayload(data);
		const group = this.#group;
		let epoch: bigint;
		try {
			if (!group) throw new Error('A DAVE Welcome requires a pending local MLS group.');
			group.processWelcome(message.encodedMessage);
			epoch = this.requireEstablishedEpoch(group);
			this.assertExpectedEpoch(message.transitionId, epoch);
		} catch {
			await this.recoverInvalidTransition(message.transitionId);
			return;
		}

		this.#epochPreparation = undefined;
		this.adoptAuthoritativeGroup(group);
		this.prepareProcessedTransition(message.transitionId, epoch, group);
	}

	private prepareEpoch(message: DavePrepareEpochData): void {
		this.assertProtocolVersion(message.protocolVersion);
		if (message.protocolVersion === 0) {
			throw new TypeError('DAVE prepare_epoch cannot select protocol version zero.');
		}
		const authoritativeEpoch = this.#authoritativeGroup?.epoch;
		if (message.epoch === 1) {
			// Epoch one announces a group rebuild, so the old roster and verification state are discarded.
			this.#groupProtocolVersion = message.protocolVersion;
			this.replaceWorkingGroup();
			this.#callbacks.onVoicePrivacyCodeChange(null);
			this.#epochPreparation = {
				protocolVersion: message.protocolVersion,
				epoch: 1n,
				transitionId: message.transitionId,
				generation: this.#groupGeneration,
			};
			this.sendFreshKeyPackage();
			return;
		}

		const group = this.#authoritativeGroup;
		const epoch = authoritativeEpoch;
		if (!group || epoch === undefined || epoch !== BigInt(message.epoch)) {
			throw new TypeError('A retained DAVE epoch must match the established MLS group.');
		}
		if (message.transitionId === undefined) throw new TypeError('A retained DAVE epoch requires a transition ID.');
		this.#groupProtocolVersion = message.protocolVersion;
		this.#epochPreparation = undefined;
		this.prepareTransition(message.transitionId, {
			protocolVersion: message.protocolVersion,
			epoch,
			group,
			removed: false,
		});
	}

	private prepareAnnouncedTransition(transitionId: number, protocolVersion: number): void {
		this.assertProtocolVersion(protocolVersion);
		// A downgrade accepts plaintext frames before Discord executes it so packets already in flight survive.
		if (protocolVersion === 0) this.#receivePassthroughUntil = Number.POSITIVE_INFINITY;
		if (transitionId === 0 && protocolVersion !== 0) {
			const group = this.#group;
			if (!group) throw new TypeError('A DAVE v1 initialization requires a local MLS group.');
			if (!group.established) group.activatePending();
			this.#epochPreparation = undefined;
			this.adoptAuthoritativeGroup(group);
		}
		const group = protocolVersion === 0 ? undefined : this.#authoritativeGroup;
		const epoch = group?.epoch;
		if (protocolVersion !== 0 && (!group || epoch === undefined)) {
			throw new TypeError('A DAVE v1 transition requires an established MLS group.');
		}
		this.prepareTransition(transitionId, {
			protocolVersion,
			epoch,
			group,
			removed: false,
		});
	}

	private prepareProcessedTransition(transitionId: number, epoch: bigint, group: DaveMlsGroup): void {
		const protocolVersion = this.#groupProtocolVersion;
		if (protocolVersion === undefined || protocolVersion === 0) {
			throw new TypeError('A processed DAVE MLS transition requires a nonzero protocol version.');
		}
		this.prepareTransition(transitionId, { protocolVersion, epoch, group, removed: false });
	}

	private prepareTransition(transitionId: number, transition: DavePreparedTransition): void {
		if (transitionId === 0) {
			this.applyTransition(transition);
			return;
		}
		const previous = this.#preparedTransitions.get(transitionId);
		if (previous && !equalTransitions(previous, transition)) {
			throw new TypeError('A DAVE transition ID cannot identify conflicting transitions.');
		}
		if (previous) return;
		this.#preparedTransitions.set(transitionId, transition);
		this.#callbacks.sendJson(23, { transition_id: transitionId });
	}

	private executeTransition(transitionId: number): void {
		const transition = this.#preparedTransitions.get(transitionId);
		if (!transition) throw new TypeError('The Voice Gateway executed an unknown DAVE transition.');
		this.#preparedTransitions.delete(transitionId);
		this.applyTransition(transition);
	}

	private applyTransition(transition: DavePreparedTransition): void {
		if (transition.protocolVersion === 0) {
			const changed = this.#activeProtocolVersion !== 0 || this.#activeEpoch !== undefined;
			this.#activeProtocolVersion = 0;
			this.#activeEpoch = undefined;
			this.#groupProtocolVersion = undefined;
			this.clearAudioEncryptor();
			this.markReceiveEpochsExpiring();
			this.#receivePassthroughUntil = Number.POSITIVE_INFINITY;
			this.clearAllGroupState();
			this.#callbacks.onVoicePrivacyCodeChange(null);
			if (changed || !this.#ready) this.markReady();
			return;
		}
		if (transition.removed) {
			this.#activeProtocolVersion = transition.protocolVersion;
			this.#activeEpoch = transition.epoch;
			return;
		}
		if (
			!transition.group ||
			this.#authoritativeGroup !== transition.group ||
			transition.group.epoch !== transition.epoch
		) {
			throw new TypeError('The Voice Gateway executed a stale DAVE MLS transition.');
		}
		const previousProtocolVersion = this.#activeProtocolVersion;
		const changed =
			this.#activeProtocolVersion !== transition.protocolVersion || this.#activeEpoch !== transition.epoch;
		this.#activeProtocolVersion = transition.protocolVersion;
		this.#activeEpoch = transition.epoch;
		if (!this.#audioEncryptor || this.#audioGroup !== transition.group || this.#audioEpoch !== transition.epoch) {
			this.installAudioEncryptor(transition.group);
		}
		if (previousProtocolVersion === 0) {
			this.#receivePassthroughUntil = Date.now() + DAVE_TRANSITION_RETENTION_MS;
		}
		if (changed || !this.#ready) this.markReady();
	}

	private adoptAuthoritativeGroup(group: DaveMlsGroup): void {
		const epoch = this.requireEstablishedEpoch(group);
		this.installReceiveEpoch(group, epoch);
		const previous = this.#authoritativeGroup;
		this.#authoritativeGroup = group;
		if (previous && previous !== group) previous.close();
		this.#callbacks.onVoicePrivacyCodeChange(
			epoch === 0n ? null : createDaveEpochAuthenticatorCode(group.epochAuthenticator),
		);
	}

	private handleLocalRemoval(group: DaveMlsGroup, transitionId: number, epoch: bigint): void {
		if (this.#authoritativeGroup === group) this.#authoritativeGroup = undefined;
		if (this.#group === group) this.#group = undefined;
		group.close();
		this.#preparedTransitions.clear();
		this.#callbacks.onVoicePrivacyCodeChange(null);
		this.enterRecovering();
		const protocolVersion = this.#groupProtocolVersion ?? 1;
		this.prepareTransition(transitionId, {
			protocolVersion,
			epoch,
			group: undefined,
			removed: true,
		});
	}

	private assertExpectedEpoch(transitionId: number, epoch: bigint): void {
		const expected = this.#epochPreparation;
		if (!expected) return;
		if (expected.generation !== this.#groupGeneration || expected.protocolVersion !== this.#groupProtocolVersion) {
			throw new TypeError('The DAVE MLS transition does not match the prepared group generation.');
		}
		if (expected.epoch !== epoch) throw new TypeError('The DAVE MLS transition has an unexpected epoch.');
		if (expected.transitionId !== undefined && expected.transitionId !== transitionId) {
			throw new TypeError('The DAVE MLS transition has an unexpected transition ID.');
		}
	}

	private replaceWorkingGroup(): void {
		this.markReceiveEpochsExpiring();
		const previousGroups = new Set([this.#group, this.#authoritativeGroup]);
		this.#authoritativeGroup = undefined;
		for (const group of previousGroups) group?.close();
		this.#group = new DaveMlsGroup(this.#provider, this.#identity, {
			groupId: this.#groupId,
			userId: this.#input.userId,
		});
		this.#groupGeneration++;
		this.#preparedTransitions.clear();
		this.#epochPreparation = undefined;
		if (this.#externalSender) this.#group.installExternalSender(this.#externalSender);
	}

	private async recoverInvalidTransition(transitionId: number): Promise<void> {
		// Recovery rejoins with fresh MLS state without lowering the protocol version selected by Discord.
		this.enterRecovering();
		this.#callbacks.sendJson(31, { transition_id: transitionId });
		this.#groupProtocolVersion ??= 1;
		this.replaceWorkingGroup();
		this.#callbacks.onVoicePrivacyCodeChange(null);
		this.sendFreshKeyPackage();
	}

	private sendFreshKeyPackage(): void {
		const group = this.#group;
		if (!group) throw new Error('DAVE join material is unavailable.');
		this.#callbacks.sendBinary(26, group.createKeyPackage());
	}

	private sendCommitWelcome(outbound: DaveMlsOutboundCommit | undefined): void {
		if (!outbound) return;
		this.#callbacks.sendBinary(28, outbound.payload);
	}

	private enterRecovering(): void {
		this.#ready = false;
		this.clearAudioEncryptor();
		this.markReceiveEpochsExpiring();
		this.#callbacks.onRecovering();
	}

	private markReady(): void {
		this.#ready = true;
		this.#callbacks.onReady();
	}

	private clearAllGroupState(): void {
		const groups = new Set([this.#group, this.#authoritativeGroup]);
		for (const group of groups) group?.close();
		this.#group = undefined;
		this.#authoritativeGroup = undefined;
		this.#epochPreparation = undefined;
		this.#preparedTransitions.clear();
	}

	private installAudioEncryptor(group: DaveMlsGroup): void {
		const context = encodeSnowflakeLittleEndian(this.#input.userId);
		const baseSecret = group.exportSecret('Discord Secure Frames v0', context, 16);
		try {
			this.clearAudioEncryptor();
			this.#audioEncryptor = new DaveAudioEncryptor(this.#provider, baseSecret);
			this.#audioGroup = group;
			this.#audioEpoch = group.epoch;
		} finally {
			baseSecret.fill(0);
		}
	}

	private clearAudioEncryptor(): void {
		this.#audioEncryptor?.close();
		this.#audioEncryptor = undefined;
		this.#audioGroup = undefined;
		this.#audioEpoch = undefined;
	}

	private installReceiveEpoch(group: DaveMlsGroup, epoch: bigint): void {
		const existing = this.#receiveEpochs.find(context => context.group === group && context.epoch === epoch);
		if (existing) {
			existing.expiresAt = undefined;
			this.scheduleReceiveExpiry();
			return;
		}
		// Receivers try the newest ratchet first, but DAVE keeps the previous epoch for in-flight media.
		this.markReceiveEpochsExpiring();
		const decryptors = new Map<string, DaveAudioDecryptor>();
		try {
			for (const userId of group.roster.keys()) {
				const baseSecret = group.exportSecret('Discord Secure Frames v0', encodeSnowflakeLittleEndian(userId), 16);
				try {
					decryptors.set(userId, new DaveAudioDecryptor(this.#provider, baseSecret));
				} finally {
					baseSecret.fill(0);
				}
			}
		} catch (error) {
			for (const decryptor of decryptors.values()) decryptor.close();
			throw error;
		}
		this.#receiveEpochs.unshift({ group, epoch, decryptors });
		this.scheduleReceiveExpiry();
	}

	private markReceiveEpochsExpiring(): void {
		const expiresAt = Date.now() + DAVE_TRANSITION_RETENTION_MS;
		for (const context of this.#receiveEpochs) {
			context.expiresAt = Math.min(context.expiresAt ?? Number.POSITIVE_INFINITY, expiresAt);
		}
		this.scheduleReceiveExpiry();
	}

	private cleanupReceiveEpochs(): void {
		const now = Date.now();
		const retained: DaveReceiveEpochContext[] = [];
		for (const context of this.#receiveEpochs) {
			if (context.expiresAt === undefined || context.expiresAt > now) retained.push(context);
			else for (const decryptor of context.decryptors.values()) decryptor.close();
		}
		this.#receiveEpochs = retained;
	}

	private scheduleReceiveExpiry(): void {
		if (this.#receiveExpiryTimer) clearTimeout(this.#receiveExpiryTimer);
		let nextExpiry = Number.POSITIVE_INFINITY;
		for (const context of this.#receiveEpochs) {
			if (context.expiresAt !== undefined) nextExpiry = Math.min(nextExpiry, context.expiresAt);
		}
		if (!Number.isFinite(nextExpiry)) {
			this.#receiveExpiryTimer = undefined;
			return;
		}
		this.#receiveExpiryTimer = setTimeout(
			() => {
				this.#receiveExpiryTimer = undefined;
				this.cleanupReceiveEpochs();
				this.scheduleReceiveExpiry();
			},
			Math.max(0, nextExpiry - Date.now()),
		);
		unrefTimer(this.#receiveExpiryTimer);
	}

	private clearReceiveEpochs(): void {
		if (this.#receiveExpiryTimer) clearTimeout(this.#receiveExpiryTimer);
		this.#receiveExpiryTimer = undefined;
		for (const context of this.#receiveEpochs) {
			for (const decryptor of context.decryptors.values()) decryptor.close();
		}
		this.#receiveEpochs = [];
	}

	private receivePassthroughAllowed(): boolean {
		return this.#receivePassthroughUntil === Number.POSITIVE_INFINITY || Date.now() < this.#receivePassthroughUntil;
	}

	private nextEpoch(epoch: bigint | undefined): bigint {
		if (epoch === undefined) throw new TypeError('A removing DAVE commit requires an established MLS epoch.');
		return epoch + 1n;
	}

	private requireEstablishedEpoch(group: DaveMlsGroup): bigint {
		const epoch = group.epoch;
		if (!group.established || epoch === undefined) throw new Error('The DAVE MLS group is not established.');
		return epoch;
	}

	private assertProtocolVersion(version: number): void {
		if (version !== 0 && version !== 1) throw new TypeError('DAVE protocol version must be zero or one.');
	}

	private assertOpen(): void {
		if (!this.#closed) return;
		throw new Error('The DAVE session is closed.');
	}

	private releaseFactory(): void {
		if (this.#released) return;
		this.#released = true;
		this.#release();
	}
}

function equalTransitions(left: DavePreparedTransition, right: DavePreparedTransition): boolean {
	return (
		left.protocolVersion === right.protocolVersion &&
		left.epoch === right.epoch &&
		left.group === right.group &&
		left.removed === right.removed
	);
}
