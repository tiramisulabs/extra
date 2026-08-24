import type { VoiceError } from './errors';
import type { VoicePlayback, VoicePlaybackSource } from './media/playback';
import type { VoiceReceivedPacket } from './media/receiver';

/** @internal */
export interface VoiceTransportInput {
	readonly guildId: string;
	readonly channelId: string;
	readonly userId: string;
	readonly sessionId: string;
	readonly token: string;
	readonly endpoint: string;
}

/** @internal */
export interface VoiceTransportCallbacks {
	onRecovering(): void;
	onRecovered(): void;
	onNeedsServer(): void;
	onTerminalFailure(error: VoiceError): void;
	onVoicePrivacyCodeChange(code: string | null): void;
	onAudioPacket(packet: VoiceReceivedPacket): void;
}

/** @internal */
export interface VoiceTransportSession {
	readonly ready: Promise<void>;
	play(source: VoicePlaybackSource): VoicePlayback;
	abortPlayback(error: VoiceError): void;
	close(): Promise<void>;
	getVerificationCode(userId: string): Promise<string>;
}

/** @internal */
export interface VoiceTransportFactory {
	(input: VoiceTransportInput, callbacks: VoiceTransportCallbacks): VoiceTransportSession;
	retainResourcesForReplacement?(): () => void;
}
