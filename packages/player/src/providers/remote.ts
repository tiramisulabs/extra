import { PlayerError } from '../errors';
import type { MediaBackend } from '../media/source';
import { url as createUrlTrack, inferMediaFormat } from '../track';
import type { MediaProvider } from '../types';

export function createRadioMediaProvider(backend: MediaBackend): MediaProvider {
	return Object.freeze<MediaProvider>({
		name: 'radio',
		open(track, context) {
			const location = requireHttpUrl(track.identifier);
			return backend.open(
				{
					kind: 'remote',
					url: location,
					format: track.format ?? inferMediaFormat(location),
					timeline: track.timeline,
				},
				context,
			);
		},
	});
}

export function createUrlMediaProvider(backend: MediaBackend): MediaProvider {
	return Object.freeze<MediaProvider>({
		name: 'url',
		async resolve(query, context) {
			context.signal.throwIfAborted();
			const location = parseHttpUrl(query);
			if (!location) return null;
			return { kind: 'track', track: createUrlTrack(location) };
		},
		open(track, context) {
			const location = requireHttpUrl(track.identifier);
			return backend.open(
				{
					kind: 'remote',
					url: location,
					format: track.format ?? inferMediaFormat(location),
					timeline: track.timeline,
				},
				context,
			);
		},
	});
}

function requireHttpUrl(value: string): string {
	const location = parseHttpUrl(value);
	if (location) return location;
	throw new PlayerError('PLAYER_INVALID_ARGUMENT', {
		metadata: { detail: 'A remote media track must identify an HTTP or HTTPS URL.' },
	});
}

function parseHttpUrl(value: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return null;
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
	return parsed.href;
}
