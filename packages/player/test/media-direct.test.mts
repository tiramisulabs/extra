import { describe, expect, test } from 'vitest';
import { createMediaBackend } from '../src/media/backend';
import { buildFfmpegArguments } from '../src/media/ffmpeg';
import { bytes, getByteTrackData, snapshotMediaTrack } from '../src/track';

const encoder = new TextEncoder();

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
	const values: Uint8Array[] = [];
	for await (const value of source) values.push(value);
	return values;
}

function concatenate(...values: readonly Uint8Array[]): Uint8Array {
	const output = new Uint8Array(values.reduce((size, value) => size + value.byteLength, 0));
	let offset = 0;
	for (const value of values) {
		output.set(value, offset);
		offset += value.byteLength;
	}
	return output;
}

function createOggOpus(audioPackets: readonly Uint8Array[]): Uint8Array {
	const opusHead = new Uint8Array(19);
	opusHead.set(encoder.encode('OpusHead'));
	opusHead[8] = 1;
	opusHead[9] = 2;
	new DataView(opusHead.buffer).setUint32(12, 48_000, true);
	const tags = concatenate(encoder.encode('OpusTags'), new Uint8Array(8));
	const packets = [opusHead, tags, ...audioPackets];
	const lacing = Uint8Array.from(packets.flatMap(packet => [packet.byteLength]));
	const payload = concatenate(...packets);
	const header = new Uint8Array(27);
	header.set(encoder.encode('OggS'));
	header[5] = 0x06;
	new DataView(header.buffer).setUint32(14, 1, true);
	header[26] = lacing.byteLength;
	const page = concatenate(header, lacing, payload);
	new DataView(header.buffer).setUint32(22, oggCrc(page), true);
	return concatenate(header, lacing, payload);
}

function oggCrc(value: Uint8Array): number {
	let checksum = 0;
	for (const byte of value) {
		checksum ^= byte << 24;
		for (let bit = 0; bit < 8; bit++) {
			checksum = checksum & 0x8000_0000 ? (checksum << 1) ^ 0x04c1_1db7 : checksum << 1;
		}
	}
	return checksum >>> 0;
}

describe('direct media backend', () => {
	test('demultiplexes an explicitly identified Ogg Opus byte track without FFmpeg', async () => {
		const backend = createMediaBackend({ ffmpegPath: '/missing/ffmpeg' });
		const track = snapshotMediaTrack(bytes(createOggOpus([Uint8Array.of(0xf8, 0xff, 0xfe)]), { format: 'ogg-opus' }));
		const data = getByteTrackData(track)!;
		const resource = await backend.open(
			{ kind: 'bytes', data, format: track.format!, timeline: track.timeline },
			{ signal: new AbortController().signal },
		);
		await expect(collect(resource.packets)).resolves.toEqual([Uint8Array.of(0xf8, 0xff, 0xfe)]);
		await expect(Promise.all([resource.close(), resource.close(), backend.close()])).resolves.toBeDefined();
	});

	test('rejects direct media corruption as a player media failure', async () => {
		const backend = createMediaBackend();
		const resource = await backend.open(
			{
				kind: 'bytes',
				data: Uint8Array.of(1, 2, 3),
				format: 'ogg-opus',
				timeline: { kind: 'finite', durationMs: null, seekable: false },
			},
			{ signal: new AbortController().signal },
		);
		await expect(collect(resource.packets)).rejects.toMatchObject({ code: 'PLAYER_MEDIA_FAILED' });
		await backend.close();
	});

	test('routes live and seeked Opus sources through FFmpeg', async () => {
		const live = buildFfmpegArguments({
			kind: 'remote',
			url: 'https://example.com/radio.opus',
			format: 'ogg-opus',
			timeline: { kind: 'live' },
		});
		expect(live).toContain('-reconnect_streamed');
		const seeked = buildFfmpegArguments(
			{
				kind: 'file',
				path: '/tmp/audio.opus',
				format: 'ogg-opus',
				timeline: { kind: 'finite', durationMs: null, seekable: true },
			},
			1_500,
		);
		expect(seeked.slice(seeked.indexOf('-ss'), seeked.indexOf('-ss') + 2)).toEqual(['-ss', '1.5']);
	});
});
