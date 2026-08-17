import type { VoiceConnection } from './connection';
import type { VoiceError } from './errors';

export interface VoicePluginOptions {
	operationTimeoutMs?: number;
}

export interface VoiceConnectOptions {
	guildId: string;
	channelId: string;
	move?: boolean;
	selfMute?: boolean;
	selfDeaf?: boolean;
}

export interface VoiceSelfStateOptions {
	selfMute?: boolean;
	selfDeaf?: boolean;
}

export interface VoiceConfirmedState {
	readonly channelId: string;
	readonly mute: boolean;
	readonly deaf: boolean;
	readonly selfMute: boolean;
	readonly selfDeaf: boolean;
	readonly suppress: boolean;
	readonly requestToSpeakTimestamp: string | null;
}

export interface VoiceConnectionTarget {
	readonly channelId: string;
	readonly selfMute: boolean;
	readonly selfDeaf: boolean;
}

export interface VoiceConnectingState {
	readonly status: 'connecting';
	readonly confirmed: VoiceConfirmedState | null;
	readonly target: VoiceConnectionTarget;
}

export interface VoiceReadyState {
	readonly status: 'ready';
	readonly confirmed: VoiceConfirmedState;
}

export interface VoiceMovingState {
	readonly status: 'moving';
	readonly confirmed: VoiceConfirmedState;
	readonly target: VoiceConnectionTarget;
}

export interface VoiceDisconnectingState {
	readonly status: 'disconnecting';
	readonly confirmed: VoiceConfirmedState | null;
}

export interface VoiceRecoveringState {
	readonly status: 'recovering';
	readonly confirmed: VoiceConfirmedState;
}

export type VoiceConnectionDestroyReason =
	| 'explicit-disconnect'
	| 'external-disconnect'
	| 'terminal-failure'
	| 'plugin-teardown';

export interface VoiceDestroyedState {
	readonly status: 'destroyed';
	readonly confirmed: VoiceConfirmedState | null;
	readonly reason: VoiceConnectionDestroyReason;
	readonly error?: VoiceError;
}

export type VoiceConnectionState =
	| VoiceConnectingState
	| VoiceReadyState
	| VoiceMovingState
	| VoiceDisconnectingState
	| VoiceRecoveringState
	| VoiceDestroyedState;

export interface VoiceCustomEvents {
	voiceConnectionStateChange: (
		connection: VoiceConnection,
		next: VoiceConnectionState,
		previous: VoiceConnectionState,
	) => void;
	voicePrivacyCodeChange: (connection: VoiceConnection, next: string | null, previous: string | null) => void;
}
