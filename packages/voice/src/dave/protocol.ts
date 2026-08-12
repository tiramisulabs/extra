import type { VoiceCryptoProvider } from '../crypto/provider';
import { MlsReader } from '../mls/codec';

export const DaveMlsProposalOperation = Object.freeze({
	Append: 0,
	Revoke: 1,
} as const);

export type DaveJsonOpcode = 11 | 13 | 21 | 22 | 24;

export interface DaveClientsConnectData {
	readonly userIds: readonly string[];
}

export interface DaveClientDisconnectData {
	readonly userId: string;
}

export interface DavePrepareTransitionData {
	readonly protocolVersion: number;
	readonly transitionId: number;
}

export interface DaveTransitionData {
	readonly transitionId: number;
}

export interface DavePrepareEpochData {
	readonly protocolVersion: number;
	readonly epoch: number;
	readonly transitionId: number | undefined;
}

export type DaveJsonData =
	| DaveClientsConnectData
	| DaveClientDisconnectData
	| DavePrepareTransitionData
	| DaveTransitionData
	| DavePrepareEpochData;

interface DaveClientsConnectPayload {
	readonly user_ids: readonly string[];
}

interface DaveClientDisconnectPayload {
	readonly user_id: string;
}

interface DavePrepareTransitionPayload {
	readonly protocol_version: number;
	readonly transition_id: number;
}

interface DaveTransitionPayload {
	readonly transition_id: number;
}

interface DavePrepareEpochPayload {
	readonly protocol_version: number;
	readonly epoch: number;
	readonly transition_id?: number;
}

export interface DaveBasicCredential {
	readonly type: 1;
	readonly identity: Uint8Array;
}

export interface DaveExternalSender {
	readonly signatureKey: Uint8Array;
	readonly credential: DaveBasicCredential;
}

export type DaveMlsProposalsPayload =
	| { readonly operation: 'append'; readonly encodedProposalMessages: Uint8Array }
	| { readonly operation: 'revoke'; readonly proposalRefs: readonly Uint8Array[] };

export interface DaveMlsTransitionPayload {
	readonly transitionId: number;
	readonly encodedMessage: Uint8Array;
}

export function parseDaveJsonData(opcode: 11, data: unknown): DaveClientsConnectData;
export function parseDaveJsonData(opcode: 13, data: unknown): DaveClientDisconnectData;
export function parseDaveJsonData(opcode: 21, data: unknown): DavePrepareTransitionData;
export function parseDaveJsonData(opcode: 22, data: unknown): DaveTransitionData;
export function parseDaveJsonData(opcode: 24, data: unknown): DavePrepareEpochData;
export function parseDaveJsonData(opcode: DaveJsonOpcode, data: unknown): DaveJsonData;
export function parseDaveJsonData(opcode: DaveJsonOpcode, data: unknown): DaveJsonData {
	switch (opcode) {
		case 11: {
			const payload = data as DaveClientsConnectPayload;
			return { userIds: payload.user_ids };
		}
		case 13: {
			const payload = data as DaveClientDisconnectPayload;
			return { userId: payload.user_id };
		}
		case 21: {
			const payload = data as DavePrepareTransitionPayload;
			return {
				protocolVersion: payload.protocol_version,
				transitionId: payload.transition_id,
			};
		}
		case 22: {
			const payload = data as DaveTransitionPayload;
			return { transitionId: payload.transition_id };
		}
		case 24: {
			const payload = data as DavePrepareEpochPayload;
			return {
				protocolVersion: payload.protocol_version,
				epoch: payload.epoch,
				transitionId: payload.transition_id,
			};
		}
	}
}

export function parseDaveExternalSenderPayload(payload: Uint8Array, provider: VoiceCryptoProvider): DaveExternalSender {
	const reader = new MlsReader(payload);
	const signatureKey = reader.vector();
	provider.validateP256PublicKey(signatureKey);
	const credentialType = reader.uint16();
	if (credentialType !== 1) throw new TypeError('The DAVE external sender must use a Basic credential.');
	const identity = reader.vector();
	reader.assertEnd();
	return { signatureKey, credential: { type: 1, identity } };
}

export function parseDaveMlsProposalsPayload(payload: Uint8Array): DaveMlsProposalsPayload {
	const reader = new MlsReader(payload);
	const operation = reader.uint8();
	if (operation === DaveMlsProposalOperation.Append) {
		const encodedProposalMessages = reader.vector();
		reader.assertEnd();
		return { operation: 'append', encodedProposalMessages };
	}
	if (operation === DaveMlsProposalOperation.Revoke) {
		const proposalRefs = reader.vectorItems(itemReader => itemReader.vector());
		reader.assertEnd();
		return { operation: 'revoke', proposalRefs };
	}
	throw new TypeError('DAVE MLS proposals contain an unsupported operation.');
}

export function parseDaveMlsTransitionPayload(payload: Uint8Array): DaveMlsTransitionPayload {
	const reader = new MlsReader(payload);
	const transitionId = reader.uint16();
	if (reader.remaining === 0) throw new TypeError('A DAVE MLS transition must contain an MLS message.');
	return { transitionId, encodedMessage: reader.bytes(reader.remaining) };
}
