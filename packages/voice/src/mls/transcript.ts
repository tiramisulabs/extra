import { concatenateBytes } from '../bytes';
import type { VoiceCryptoProvider } from '../crypto/provider';
import { mac, verifyMac } from './crypto';
import {
	encodeConfirmedTranscriptHashInput,
	encodeInterimTranscriptHashInput,
	type MlsAuthenticatedContent,
} from './protocol';

export interface MlsTranscriptHashes {
	readonly confirmed: Uint8Array;
	readonly interim: Uint8Array;
}

export function updateConfirmedTranscriptHash(
	provider: VoiceCryptoProvider,
	previousInterimTranscriptHash: Uint8Array,
	content: MlsAuthenticatedContent,
): Uint8Array {
	if (previousInterimTranscriptHash.byteLength !== 32) {
		throw new TypeError('The previous MLS interim transcript hash must contain 32 bytes.');
	}
	return provider.sha256(concatenateBytes(previousInterimTranscriptHash, encodeConfirmedTranscriptHashInput(content)));
}

export function updateInterimTranscriptHash(
	provider: VoiceCryptoProvider,
	confirmedTranscriptHash: Uint8Array,
	confirmationTag: Uint8Array,
): Uint8Array {
	if (confirmedTranscriptHash.byteLength !== 0 && confirmedTranscriptHash.byteLength !== 32) {
		throw new TypeError('The MLS confirmed transcript hash must be empty for epoch zero or contain 32 bytes.');
	}
	if (confirmationTag.byteLength !== 32) throw new TypeError('The MLS confirmation tag must contain 32 bytes.');
	return provider.sha256(concatenateBytes(confirmedTranscriptHash, encodeInterimTranscriptHashInput(confirmationTag)));
}

export function computeConfirmationTag(
	provider: VoiceCryptoProvider,
	confirmationKey: Uint8Array,
	confirmedTranscriptHash: Uint8Array,
): Uint8Array {
	if (confirmationKey.byteLength !== 32) throw new TypeError('The MLS confirmation key must contain 32 bytes.');
	if (confirmedTranscriptHash.byteLength !== 0 && confirmedTranscriptHash.byteLength !== 32) {
		throw new TypeError('The MLS confirmed transcript hash must be empty for epoch zero or contain 32 bytes.');
	}
	return mac(provider, confirmationKey, confirmedTranscriptHash);
}

export function verifyConfirmationTag(
	provider: VoiceCryptoProvider,
	confirmationKey: Uint8Array,
	confirmedTranscriptHash: Uint8Array,
	confirmationTag: Uint8Array,
): boolean {
	if (
		confirmationKey.byteLength !== 32 ||
		(confirmedTranscriptHash.byteLength !== 0 && confirmedTranscriptHash.byteLength !== 32)
	) {
		return false;
	}
	return verifyMac(provider, confirmationKey, confirmedTranscriptHash, confirmationTag);
}

export function updateTranscriptHashes(
	provider: VoiceCryptoProvider,
	previousInterimTranscriptHash: Uint8Array,
	content: MlsAuthenticatedContent,
	confirmationKey: Uint8Array,
): MlsTranscriptHashes {
	const confirmed = updateConfirmedTranscriptHash(provider, previousInterimTranscriptHash, content);
	const confirmationTag = content.auth.confirmationTag;
	if (confirmationTag === undefined || !verifyConfirmationTag(provider, confirmationKey, confirmed, confirmationTag)) {
		throw new TypeError('The MLS commit confirmation tag is invalid.');
	}
	return Object.freeze({
		confirmed,
		interim: updateInterimTranscriptHash(provider, confirmed, confirmationTag),
	});
}
