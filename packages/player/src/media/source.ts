import type { MediaFormat, MediaResource, MediaTimeline } from '../types';

/** @internal */
export function forwardAbort(signal: AbortSignal, controller: AbortController): () => void {
	if (signal.aborted) {
		controller.abort(signal.reason);
		return () => undefined;
	}
	const abort = () => controller.abort(signal.reason);
	signal.addEventListener('abort', abort, { once: true });
	return () => signal.removeEventListener('abort', abort);
}

/** @internal */
export async function* readNodeByteStream(stream: NodeJS.ReadableStream): AsyncGenerator<Uint8Array> {
	for await (const chunk of stream) {
		if (!(chunk instanceof Uint8Array)) throw new TypeError('A Node.js media stream yielded a non-byte chunk.');
		yield chunk;
	}
}

export type MediaSource = FileMediaSource | RemoteMediaSource | ByteMediaSource;

interface FileMediaSource {
	readonly kind: 'file';
	readonly path: string;
	readonly format: MediaFormat;
	readonly timeline: MediaTimeline;
}

interface RemoteMediaSource {
	readonly kind: 'remote';
	readonly url: string;
	readonly format: MediaFormat;
	readonly timeline: MediaTimeline;
}

interface ByteMediaSource {
	readonly kind: 'bytes';
	readonly data: Uint8Array;
	readonly format: MediaFormat;
	readonly timeline: MediaTimeline;
}

export interface MediaBackendOpenOptions {
	readonly signal: AbortSignal;
	readonly startAtMs?: number;
}

export interface MediaBackend {
	open(source: MediaSource, options: MediaBackendOpenOptions): Promise<MediaResource>;
	close(): Promise<void>;
}
