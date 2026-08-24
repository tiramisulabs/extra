import { describe, expect, test } from 'vitest';
import { bytes, createMediaTrack, file, getByteTrackData, radio, snapshotMediaTrack, url } from '../src/track';
import type { MediaTrack } from '../src/types';

function finiteTrack(overrides: Partial<MediaTrack> = {}): MediaTrack {
	return {
		provider: 'test',
		identifier: 'id',
		title: 'title',
		timeline: { kind: 'finite', durationMs: null, seekable: false },
		...overrides,
	};
}

describe('media track helpers', () => {
	test('creates immutable tracks and validates finite timelines', () => {
		const track = createMediaTrack(finiteTrack());
		expect(track).toEqual({
			provider: 'test',
			identifier: 'id',
			title: 'title',
			format: 'unknown',
			timeline: { kind: 'finite', durationMs: null, seekable: false },
		});
		expect(Object.isFrozen(track)).toBe(true);
		expect(Object.isFrozen(track.timeline)).toBe(true);
		expect(() =>
			createMediaTrack(finiteTrack({ timeline: { kind: 'finite', durationMs: -1, seekable: false } })),
		).toThrow('non-negative');
		expect(() => createMediaTrack(finiteTrack({ format: 'mp3' as never }))).toThrow('format');
		expect(() =>
			createMediaTrack(finiteTrack({ timeline: { kind: 'finite', durationMs: null, seekable: 'yes' as never } })),
		).toThrow('seekable');
		expect(() => createMediaTrack(finiteTrack({ provider: 1 as never }))).toThrow('provider');
	});

	test('infers only the unambiguous Opus extension', () => {
		expect(file('/music/song.opus').format).toBe('ogg-opus');
		expect(file('/music/song.ogg').format).toBe('unknown');
		expect(file('/music/song.webm').format).toBe('unknown');
		expect(file('/music/song.webm', { format: 'webm-opus' }).format).toBe('webm-opus');
	});

	test('builds remote finite and live tracks without failing on malformed UTF-8 escapes', () => {
		const remote = url('https://example.com/%E0%A4%A.ogg');
		expect(remote.title).toBe('%E0%A4%A.ogg');
		expect(remote.timeline).toEqual({ kind: 'finite', durationMs: null, seekable: false });
		expect(radio('https://example.com/live')).toMatchObject({ provider: 'radio', timeline: { kind: 'live' } });
		expect(() => url('file:///tmp/audio.opus')).toThrow('HTTP or HTTPS');
	});

	test('keeps byte data process-local and immutable from caller mutation', () => {
		const input = Uint8Array.of(1, 2, 3);
		const track = bytes(input, { format: 'ogg-opus' });
		input[0] = 9;
		expect(getByteTrackData(track)).toEqual(Uint8Array.of(1, 2, 3));
		expect(getByteTrackData({ ...track })).toBeUndefined();
	});

	test('snapshots only track fields while retaining process-local byte data', () => {
		const track = bytes(Uint8Array.of(1, 2, 3), { title: 'Original', format: 'ogg-opus' });
		const data = getByteTrackData(track);
		const snapshot = snapshotMediaTrack(track);

		expect(snapshot).not.toBe(track);
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(getByteTrackData(snapshot)).toBe(data);
	});
});
