import type { VoicePlaybackSource, VoicePlugin } from '@slipher/voice';
import type { GuildPlayer } from './player';

export type MediaFormat = 'ogg-opus' | 'webm-opus' | 'unknown';

export type MediaTimeline =
	| { readonly kind: 'live' }
	| {
			readonly kind: 'finite';
			readonly durationMs: number | null;
			readonly seekable: boolean;
	  };

export interface MediaTrack {
	readonly provider: string;
	readonly identifier: string;
	readonly title: string;
	readonly author?: string;
	readonly uri?: string;
	readonly artworkUrl?: string;
	readonly format?: MediaFormat;
	readonly timeline: MediaTimeline;
}

export type MediaLoadResult =
	| { readonly kind: 'track'; readonly track: MediaTrack }
	| {
			readonly kind: 'playlist';
			readonly name: string;
			readonly tracks: readonly MediaTrack[];
	  }
	| { readonly kind: 'search'; readonly tracks: readonly MediaTrack[] }
	| { readonly kind: 'empty' };

export interface MediaProviderResolveContext {
	readonly signal: AbortSignal;
}

export interface MediaProviderOpenContext {
	readonly signal: AbortSignal;
	readonly startAtMs?: number;
}

export interface MediaResource {
	readonly packets: VoicePlaybackSource;
	close(): Promise<void>;
}

export interface MediaProvider {
	readonly name: string;
	resolve?(query: string, context: MediaProviderResolveContext): Promise<MediaLoadResult | null>;
	open(track: MediaTrack, context: MediaProviderOpenContext): Promise<MediaResource>;
}

export interface PlayerPluginOptions<TVoice extends VoicePlugin = VoicePlugin> {
	readonly voice: TVoice;
	readonly ffmpegPath?: string;
	readonly providers?: readonly MediaProvider[];
	readonly historyLimit?: number;
}

export interface PlayerResolveOptions {
	readonly provider?: string;
	readonly signal?: AbortSignal;
}

export interface PlayerEnqueueOptions {
	readonly metadata?: unknown;
}

export interface PlayerQueueItem {
	readonly id: string;
	readonly track: MediaTrack;
	readonly metadata?: unknown;
}

export type PlayerRepeatMode = 'off' | 'track' | 'queue';

export type GuildPlayerState =
	| { readonly status: 'idle' }
	| { readonly status: 'waiting'; readonly reason: 'voice-unavailable' }
	| { readonly status: 'loading'; readonly item: PlayerQueueItem }
	| { readonly status: 'playing'; readonly item: PlayerQueueItem }
	| { readonly status: 'paused'; readonly item: PlayerQueueItem }
	| { readonly status: 'destroyed' };

export type PlayerTrackEndReason =
	| 'finished'
	| 'skipped'
	| 'stopped'
	| 'load-failed'
	| 'connection-unavailable'
	| 'destroyed';

export interface PlayerHistoryEntry {
	readonly item: PlayerQueueItem;
	readonly reason: PlayerTrackEndReason;
}

export interface PlayerCustomEvents {
	playerStateChange: (player: GuildPlayer, next: GuildPlayerState, previous: GuildPlayerState) => void;
	playerTrackStart: (player: GuildPlayer, item: PlayerQueueItem) => void;
	playerTrackEnd: (player: GuildPlayer, item: PlayerQueueItem, reason: PlayerTrackEndReason) => void;
	playerTrackError: (player: GuildPlayer, item: PlayerQueueItem, error: unknown) => void;
	playerQueueEnd: (player: GuildPlayer) => void;
}
