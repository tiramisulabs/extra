import type { VoiceCryptoProvider } from '../crypto/provider';
import { deriveSecret, expandWithLabel } from './crypto';

const ZERO_SECRET = new Uint8Array(32);

export interface MlsEpochSecrets {
	readonly joinerSecret: Uint8Array;
	readonly welcomeSecret: Uint8Array;
	readonly initSecret: Uint8Array;
	readonly senderDataSecret: Uint8Array;
	readonly encryptionSecret: Uint8Array;
	readonly exporterSecret: Uint8Array;
	readonly externalSecret: Uint8Array;
	readonly confirmationKey: Uint8Array;
	readonly membershipKey: Uint8Array;
	readonly resumptionPsk: Uint8Array;
	readonly epochAuthenticator: Uint8Array;
}

export function deriveEpochSecretsFromJoiner(
	provider: VoiceCryptoProvider,
	joinerSecret: Uint8Array,
	encodedGroupContext: Uint8Array,
	pskSecret: Uint8Array = ZERO_SECRET,
): Omit<MlsEpochSecrets, 'joinerSecret'> {
	assertSecret(joinerSecret, 'joinerSecret');
	assertSecret(pskSecret, 'pskSecret');
	const epochInput = provider.hkdfExtract(pskSecret, joinerSecret);
	let epochSecret: Uint8Array | undefined;
	try {
		epochSecret = expandWithLabel(provider, epochInput, 'epoch', encodedGroupContext, 32);
		return {
			welcomeSecret: deriveWelcomeSecretFromEpochInput(provider, epochInput),
			...deriveInitialEpochSecrets(provider, epochSecret),
		};
	} finally {
		epochInput.fill(0);
		epochSecret?.fill(0);
	}
}

export function deriveWelcomeSecret(
	provider: VoiceCryptoProvider,
	joinerSecret: Uint8Array,
	pskSecret: Uint8Array = ZERO_SECRET,
): Uint8Array {
	assertSecret(joinerSecret, 'joinerSecret');
	assertSecret(pskSecret, 'pskSecret');
	const epochInput = provider.hkdfExtract(pskSecret, joinerSecret);
	try {
		return deriveWelcomeSecretFromEpochInput(provider, epochInput);
	} finally {
		epochInput.fill(0);
	}
}

export function deriveWelcomeKeyNonce(
	provider: VoiceCryptoProvider,
	joinerSecret: Uint8Array,
	pskSecret: Uint8Array = ZERO_SECRET,
): { readonly key: Uint8Array; readonly nonce: Uint8Array } {
	const welcomeSecret = deriveWelcomeSecret(provider, joinerSecret, pskSecret);
	try {
		return {
			key: expandWithLabel(provider, welcomeSecret, 'key', new Uint8Array(), 16),
			nonce: expandWithLabel(provider, welcomeSecret, 'nonce', new Uint8Array(), 12),
		};
	} finally {
		welcomeSecret.fill(0);
	}
}

export function deriveEpochSecrets(
	provider: VoiceCryptoProvider,
	previousInitSecret: Uint8Array,
	commitSecret: Uint8Array,
	encodedGroupContext: Uint8Array,
	pskSecret: Uint8Array = ZERO_SECRET,
): MlsEpochSecrets {
	assertSecret(previousInitSecret, 'previousInitSecret');
	assertSecret(commitSecret, 'commitSecret');
	assertSecret(pskSecret, 'pskSecret');
	const extractedJoinerSecret = provider.hkdfExtract(commitSecret, previousInitSecret);
	try {
		const joinerSecret = expandWithLabel(provider, extractedJoinerSecret, 'joiner', encodedGroupContext, 32);
		return { joinerSecret, ...deriveEpochSecretsFromJoiner(provider, joinerSecret, encodedGroupContext, pskSecret) };
	} finally {
		extractedJoinerSecret.fill(0);
	}
}

export function exportMlsSecret(
	provider: VoiceCryptoProvider,
	exporterSecret: Uint8Array,
	label: string,
	context: Uint8Array,
	length: number,
): Uint8Array {
	assertSecret(exporterSecret, 'exporterSecret');
	const labelSecret = expandWithLabel(provider, exporterSecret, label, new Uint8Array(), 32);
	try {
		return expandWithLabel(provider, labelSecret, 'exported', provider.sha256(context), length);
	} finally {
		labelSecret.fill(0);
	}
}

export function deriveInitialEpochSecrets(
	provider: VoiceCryptoProvider,
	epochSecret: Uint8Array,
): Omit<MlsEpochSecrets, 'joinerSecret' | 'welcomeSecret'> {
	assertSecret(epochSecret, 'epochSecret');
	return {
		initSecret: deriveSecret(provider, epochSecret, 'init'),
		senderDataSecret: deriveSecret(provider, epochSecret, 'sender data'),
		encryptionSecret: deriveSecret(provider, epochSecret, 'encryption'),
		exporterSecret: deriveSecret(provider, epochSecret, 'exporter'),
		externalSecret: deriveSecret(provider, epochSecret, 'external'),
		confirmationKey: deriveSecret(provider, epochSecret, 'confirm'),
		membershipKey: deriveSecret(provider, epochSecret, 'membership'),
		resumptionPsk: deriveSecret(provider, epochSecret, 'resumption'),
		epochAuthenticator: deriveSecret(provider, epochSecret, 'authentication'),
	};
}

function assertSecret(value: Uint8Array, name: string): void {
	if (value.byteLength === 32) return;
	throw new TypeError(`${name} must contain 32 bytes.`);
}

function deriveWelcomeSecretFromEpochInput(provider: VoiceCryptoProvider, epochInput: Uint8Array): Uint8Array {
	return deriveSecret(provider, epochInput, 'welcome');
}
