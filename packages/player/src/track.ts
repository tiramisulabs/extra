import type { MediaFormat, MediaTimeline, MediaTrack } from './types';

const BYTE_TRACK_DATA = new WeakMap<MediaTrack, Uint8Array>();

export interface MediaTrackDetails {
	readonly title?: string;
	readonly author?: string;
	readonly artworkUrl?: string;
	readonly format?: MediaFormat;
}

export interface FiniteMediaTrackDetails extends MediaTrackDetails {
	readonly durationMs?: number | null;
	readonly seekable?: boolean;
}

export function createMediaTrack(init: MediaTrack): MediaTrack {
	if (!init || typeof init !== 'object') throw new TypeError('A media track must be an object.');
	requireNonEmpty(init.provider, 'A media track provider cannot be empty.');
	requireNonEmpty(init.identifier, 'A media track identifier cannot be empty.');
	requireNonEmpty(init.title, 'A media track title cannot be empty.');
	if (
		init.format !== undefined &&
		init.format !== 'ogg-opus' &&
		init.format !== 'webm-opus' &&
		init.format !== 'unknown'
	) {
		throw new TypeError('A media track format must be ogg-opus, webm-opus, or unknown.');
	}

	const timeline = createTimeline(init.timeline);
	return Object.freeze({
		...init,
		format: init.format ?? 'unknown',
		timeline,
	});
}

export function file(path: string, details: FiniteMediaTrackDetails = {}): MediaTrack {
	const identifier = requireNonEmpty(path, 'A media file path cannot be empty.');
	return createMediaTrack({
		provider: 'file',
		identifier,
		title: details.title ?? sourceLabel(identifier, 'Local media'),
		author: details.author,
		uri: identifier,
		artworkUrl: details.artworkUrl,
		format: details.format ?? inferMediaFormat(identifier),
		timeline: {
			kind: 'finite',
			durationMs: details.durationMs ?? null,
			seekable: details.seekable ?? true,
		},
	});
}

export function url(input: string | URL, details: FiniteMediaTrackDetails = {}): MediaTrack {
	const identifier = normalizeHttpUrl(input);
	return createMediaTrack({
		provider: 'url',
		identifier,
		title: details.title ?? urlLabel(identifier),
		author: details.author,
		uri: identifier,
		artworkUrl: details.artworkUrl,
		format: details.format ?? inferMediaFormat(identifier),
		timeline: {
			kind: 'finite',
			durationMs: details.durationMs ?? null,
			seekable: details.seekable ?? false,
		},
	});
}

export function radio(input: string | URL, details: MediaTrackDetails = {}): MediaTrack {
	const identifier = normalizeHttpUrl(input);
	return createMediaTrack({
		provider: 'radio',
		identifier,
		title: details.title ?? urlLabel(identifier),
		author: details.author,
		uri: identifier,
		artworkUrl: details.artworkUrl,
		format: details.format ?? inferMediaFormat(identifier),
		timeline: { kind: 'live' },
	});
}

/**
 * Creates a process-local track backed by an immutable copy of `data`.
 * Byte tracks cannot be serialized, cloned, or reopened by another process.
 */
export function bytes(data: Uint8Array, details: Omit<FiniteMediaTrackDetails, 'seekable'> = {}): MediaTrack {
	if (!(data instanceof Uint8Array)) throw new TypeError('In-memory media must be a Uint8Array.');
	const track = createMediaTrack({
		provider: 'bytes',
		identifier: `memory:${crypto.randomUUID()}`,
		title: details.title ?? 'In-memory media',
		author: details.author,
		artworkUrl: details.artworkUrl,
		format: details.format ?? 'unknown',
		timeline: {
			kind: 'finite',
			durationMs: details.durationMs ?? null,
			seekable: false,
		},
	});
	BYTE_TRACK_DATA.set(track, data.slice());
	return track;
}

export function inferMediaFormat(location: string): MediaFormat {
	const pathname = mediaPathname(location).toLowerCase();
	if (pathname.endsWith('.opus')) return 'ogg-opus';
	return 'unknown';
}

/** @internal */
export function snapshotMediaTrack(track: MediaTrack): MediaTrack {
	const snapshot = createMediaTrack({
		provider: track.provider,
		identifier: track.identifier,
		title: track.title,
		...(track.author === undefined ? {} : { author: track.author }),
		...(track.uri === undefined ? {} : { uri: track.uri }),
		...(track.artworkUrl === undefined ? {} : { artworkUrl: track.artworkUrl }),
		...(track.format === undefined ? {} : { format: track.format }),
		timeline: track.timeline,
	});
	const data = BYTE_TRACK_DATA.get(track);
	if (data) BYTE_TRACK_DATA.set(snapshot, data);
	return snapshot;
}

/** @internal */
export function getByteTrackData(track: MediaTrack): Uint8Array | undefined {
	return BYTE_TRACK_DATA.get(track);
}

function createTimeline(timeline: MediaTimeline): MediaTimeline {
	if (!timeline || typeof timeline !== 'object') throw new TypeError('A media timeline must be an object.');
	if (timeline.kind === 'live') return Object.freeze({ kind: 'live' });
	if (timeline.kind !== 'finite') throw new TypeError('A media timeline kind must be finite or live.');
	if (timeline.durationMs !== null && (!Number.isFinite(timeline.durationMs) || timeline.durationMs < 0)) {
		throw new RangeError('A finite media duration must be null or a non-negative finite number.');
	}
	if (typeof timeline.seekable !== 'boolean')
		throw new TypeError('A finite media timeline seekable value must be boolean.');
	return Object.freeze({
		kind: 'finite',
		durationMs: timeline.durationMs,
		seekable: timeline.seekable,
	});
}

function requireNonEmpty(value: unknown, message: string): string {
	if (typeof value === 'string' && value.trim()) return value;
	throw new TypeError(message);
}

function normalizeHttpUrl(input: string | URL): string {
	const parsed = input instanceof URL ? new URL(input.href) : new URL(input);
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new TypeError('A remote media URL must use HTTP or HTTPS.');
	}
	return parsed.href;
}

function sourceLabel(location: string, fallback: string): string {
	const parts = location.replaceAll('\\', '/').split('/');
	return parts.at(-1) || fallback;
}

function urlLabel(location: string): string {
	const parsed = new URL(location);
	let pathname = parsed.pathname;
	try {
		pathname = decodeURIComponent(pathname);
	} catch {
		// Keep the valid URL's encoded pathname when its bytes are not valid UTF-8.
	}
	return sourceLabel(pathname, parsed.hostname);
}

function mediaPathname(location: string): string {
	try {
		return new URL(location).pathname;
	} catch {
		return location.split(/[?#]/u, 1)[0] ?? location;
	}
}
