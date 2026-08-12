import type { VoicePlaybackSource } from '@slipher/voice';
import { PlayerError } from '../errors';
import type { MediaResource } from '../types';
import { openDirectMediaSource } from './direct';
import { openFfmpegMediaSource } from './ffmpeg';
import type { MediaBackend, MediaBackendOpenOptions, MediaSource } from './source';

export interface MediaBackendOptions {
	readonly ffmpegPath?: string;
}

export function createMediaBackend(options: MediaBackendOptions = {}): MediaBackend {
	return new ManagedMediaBackend(options.ffmpegPath ?? 'ffmpeg');
}

class ManagedMediaBackend implements MediaBackend {
	readonly #ffmpegPath: string;
	readonly #resources = new Set<MediaResource>();
	readonly #shutdown = new AbortController();
	#closed = false;
	#closePromise?: Promise<void>;

	constructor(ffmpegPath: string) {
		if (!ffmpegPath.trim()) throw new TypeError('The FFmpeg executable path cannot be empty.');
		this.#ffmpegPath = ffmpegPath;
	}

	async open(source: MediaSource, options: MediaBackendOpenOptions): Promise<MediaResource> {
		this.assertOpen();
		options.signal.throwIfAborted();
		const startAtMs = validateStartAt(source, options.startAtMs);
		const signal = AbortSignal.any([options.signal, this.#shutdown.signal]);
		const resource = shouldUseDirectPlayback(source, startAtMs)
			? await openDirectMediaSource(source, { signal, startAtMs })
			: await openFfmpegMediaSource(source, { signal, startAtMs }, this.#ffmpegPath);
		if (this.#closed) {
			await resource.close();
			this.assertOpen();
		}
		return this.track(resource);
	}

	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#closed = true;
		this.#shutdown.abort(new PlayerError('PLAYER_DESTROYED', { metadata: { detail: 'The media backend is closed.' } }));
		this.#closePromise = this.closeResources();
		return this.#closePromise;
	}

	private track(resource: MediaResource): MediaResource {
		let closePromise: Promise<void> | undefined;
		const close = () => {
			if (closePromise) return closePromise;
			closePromise = resource.close().finally(() => this.#resources.delete(managed));
			return closePromise;
		};
		const packets: VoicePlaybackSource = {
			async *[Symbol.asyncIterator]() {
				try {
					yield* resource.packets;
				} finally {
					await close();
				}
			},
		};
		const managed = Object.freeze({ packets, close });
		this.#resources.add(managed);
		return managed;
	}

	private async closeResources(): Promise<void> {
		const results = await Promise.allSettled(Array.from(this.#resources, resource => resource.close()));
		const errors = results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []));
		if (errors.length) throw new AggregateError(errors, 'Failed to close media resources.');
	}

	private assertOpen(): void {
		if (!this.#closed) return;
		throw new PlayerError('PLAYER_DESTROYED', {
			metadata: { detail: 'The media backend is closed.' },
		});
	}
}

function validateStartAt(source: MediaSource, startAtMs?: number): number | undefined {
	if (startAtMs === undefined) return undefined;
	if (!Number.isFinite(startAtMs) || startAtMs < 0) {
		throw new PlayerError('PLAYER_INVALID_ARGUMENT', {
			metadata: { detail: 'A media start offset must be a non-negative finite number.', startAtMs },
		});
	}
	if (startAtMs === 0) return 0;
	if (source.timeline.kind === 'live' || !source.timeline.seekable) {
		throw new PlayerError('PLAYER_OPERATION_UNSUPPORTED', {
			metadata: { detail: 'This media source is not seekable.', startAtMs },
		});
	}
	if (source.timeline.durationMs !== null && startAtMs > source.timeline.durationMs) {
		throw new PlayerError('PLAYER_INVALID_ARGUMENT', {
			metadata: {
				detail: 'The media start offset exceeds the track duration.',
				startAtMs,
				durationMs: source.timeline.durationMs,
			},
		});
	}
	return startAtMs;
}

function shouldUseDirectPlayback(source: MediaSource, startAtMs?: number): boolean {
	if (startAtMs !== undefined && startAtMs > 0) return false;
	if (source.timeline.kind === 'live') return false;
	if (source.format === 'unknown') return false;
	return true;
}
