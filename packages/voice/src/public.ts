import './seyfert';

export { VoiceConnection } from './connection';
export { VoiceError, type VoiceErrorCode, type VoiceErrorOptions } from './errors';
export type { VoiceManager } from './manager';
export type { VoiceByteInput } from './media/input';
export { demuxOggOpus } from './media/ogg';
export { VoicePlayback, type VoicePlaybackSource } from './media/playback';
export {
	type VoiceReceivedPacket,
	type VoiceReceiveOptions,
	VoiceReceiveStream,
} from './media/receiver';
export { demuxWebmOpus } from './media/webm';
export type { VoicePlugin } from './plugin';
export type {
	VoiceConfirmedState,
	VoiceConnectingState,
	VoiceConnectionDestroyReason,
	VoiceConnectionState,
	VoiceConnectionTarget,
	VoiceConnectOptions,
	VoiceCustomEvents,
	VoiceDestroyedState,
	VoiceDisconnectingState,
	VoiceMovingState,
	VoicePluginOptions,
	VoiceReadyState,
	VoiceRecoveringState,
	VoiceSelfStateOptions,
} from './types';
