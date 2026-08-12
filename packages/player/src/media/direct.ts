import { createReadStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import { demuxOggOpus, demuxWebmOpus, type VoiceByteInput, type VoicePlaybackSource } from '@slipher/voice';
import { PlayerError } from '../errors';
import type { MediaResource } from '../types';
import { forwardAbort, type MediaBackendOpenOptions, type MediaSource, readNodeByteStream } from './source';

export async function openDirectMediaSource(
	source: MediaSource,
	options: MediaBackendOpenOptions,
): Promise<MediaResource> {
	options.signal.throwIfAborted();
	const controller = new AbortController();
	const detachAbort = forwardAbort(options.signal, controller);

	let input: VoiceByteInput;
	let closeInput: () => Promise<void>;
	try {
		if (source.kind === 'file') {
			const stream = createReadStream(source.path, { signal: controller.signal });
			input = readNodeByteStream(stream);
			closeInput = async () => {
				stream.destroy();
				await finished(stream).catch(() => undefined);
			};
		} else if (source.kind === 'remote') {
			const response = await fetch(source.url, { signal: controller.signal });
			const finalUrl = new URL(response.url || source.url);
			if (finalUrl.protocol !== 'http:' && finalUrl.protocol !== 'https:') {
				await response.body?.cancel().catch(() => undefined);
				throw new PlayerError('PLAYER_MEDIA_FAILED', {
					metadata: { detail: 'The remote media request redirected outside HTTP or HTTPS.' },
				});
			}
			if (!response.ok) {
				await response.body?.cancel().catch(() => undefined);
				throw new PlayerError('PLAYER_MEDIA_FAILED', {
					metadata: {
						detail: `The remote media request failed with HTTP ${response.status}.`,
						status: response.status,
					},
				});
			}
			if (!response.body) {
				throw new PlayerError('PLAYER_MEDIA_FAILED', {
					metadata: { detail: 'The remote media response did not contain a body.' },
				});
			}
			const body = createWebByteInput(response.body);
			input = body.input;
			closeInput = body.close;
		} else {
			input = source.data;
			closeInput = () => Promise.resolve();
		}
	} catch (error) {
		detachAbort();
		controller.abort();
		if (options.signal.aborted) throw options.signal.reason;
		if (PlayerError.is(error, 'PLAYER_MEDIA_FAILED')) throw error;
		throw new PlayerError('PLAYER_MEDIA_FAILED', {
			cause: error,
			metadata: { detail: 'Failed to open the media source.' },
		});
	}

	let consumed = false;
	let closing = false;
	let closePromise: Promise<void> | undefined;
	const close = () => {
		if (closePromise) return closePromise;
		closing = true;
		controller.abort();
		detachAbort();
		closePromise = closeInput();
		return closePromise;
	};
	const packets: VoicePlaybackSource = {
		async *[Symbol.asyncIterator]() {
			if (consumed) throw new TypeError('A media resource can only be consumed once.');
			consumed = true;
			try {
				const demuxed = source.format === 'ogg-opus' ? demuxOggOpus(input) : demuxWebmOpus(input);
				yield* demuxed;
			} catch (error) {
				if (options.signal.aborted) throw options.signal.reason;
				if (closing) return;
				throw new PlayerError('PLAYER_MEDIA_FAILED', {
					cause: error,
					metadata: { detail: `Failed to read the ${source.format} media source.` },
				});
			} finally {
				await close();
			}
		},
	};
	return Object.freeze({ packets, close });
}

function createWebByteInput(stream: ReadableStream<Uint8Array>): ClosableByteInput {
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let consumed = false;
	let closed = false;
	const input: VoiceByteInput = {
		async *[Symbol.asyncIterator]() {
			if (consumed) throw new TypeError('A media response body can only be consumed once.');
			consumed = true;
			reader = stream.getReader();
			let ended = false;
			try {
				while (true) {
					const result = await reader.read();
					if (result.done) {
						ended = true;
						return;
					}
					yield result.value;
				}
			} finally {
				if (!ended && !closed) await reader.cancel().catch(() => undefined);
				reader.releaseLock();
			}
		},
	};
	let closePromise: Promise<void> | undefined;
	return {
		input,
		close() {
			if (closePromise) return closePromise;
			closed = true;
			closePromise = reader ? reader.cancel().catch(() => undefined) : stream.cancel().catch(() => undefined);
			return closePromise;
		},
	};
}

interface ClosableByteInput {
	readonly input: VoiceByteInput;
	close(): Promise<void>;
}
