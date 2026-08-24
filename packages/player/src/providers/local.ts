import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PlayerError } from '../errors';
import type { MediaBackend } from '../media/source';
import { file, getByteTrackData, inferMediaFormat } from '../track';
import type { MediaProvider } from '../types';

export function createByteMediaProvider(backend: MediaBackend): MediaProvider {
	return Object.freeze<MediaProvider>({
		name: 'bytes',
		async open(track, context) {
			const data = getByteTrackData(track);
			if (!data) {
				throw new PlayerError('PLAYER_MEDIA_FAILED', {
					metadata: {
						detail: 'This byte track no longer has process-local media data.',
						identifier: track.identifier,
					},
				});
			}
			return backend.open(
				{
					kind: 'bytes',
					data,
					format: track.format ?? 'unknown',
					timeline: track.timeline,
				},
				context,
			);
		},
	});
}

export function createFileMediaProvider(backend: MediaBackend): MediaProvider {
	return Object.freeze<MediaProvider>({
		name: 'file',
		async resolve(query, context) {
			context.signal.throwIfAborted();
			const path = resolveFilePath(query);
			if (!path) return null;
			try {
				const details = await stat(path);
				context.signal.throwIfAborted();
				if (!details.isFile()) return null;
			} catch (error) {
				if (isMissingPath(error)) return null;
				throw error;
			}
			return { kind: 'track', track: file(path) };
		},
		open(track, context) {
			return backend.open(
				{
					kind: 'file',
					path: track.identifier,
					format: track.format ?? inferMediaFormat(track.identifier),
					timeline: track.timeline,
				},
				context,
			);
		},
	});
}

function resolveFilePath(query: string): string | null {
	if (!query.trim()) return null;
	if (/^file:/iu.test(query)) {
		try {
			return fileURLToPath(query);
		} catch {
			return null;
		}
	}
	if (/^[a-z][a-z\d+.-]*:/iu.test(query) && !/^[a-z]:[\\/]/iu.test(query)) return null;
	return query;
}

function isMissingPath(error: unknown): boolean {
	if (!error || typeof error !== 'object' || !('code' in error)) return false;
	return error.code === 'ENOENT' || error.code === 'ENOTDIR';
}
