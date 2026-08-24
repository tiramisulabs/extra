import { describe, expect, test } from 'vitest';
import { concatenateBytes as concatenate } from '../src/bytes';
import { demuxOggOpus } from '../src/media/ogg';
import { OPUS_SILENCE_FRAME } from '../src/media/opus';
import { demuxWebmOpus } from '../src/media/webm';

const encoder = new TextEncoder();

describe('Opus container demultiplexing', () => {
	test('restores Ogg Opus packet boundaries across arbitrary input chunks', async () => {
		const input = createOggOpus([OPUS_SILENCE_FRAME, Uint8Array.of(0xf8, 1, 2)]);
		const packets = await collect(demuxOggOpus(chunk(input, 7)));
		expect(packets).toEqual([OPUS_SILENCE_FRAME, Uint8Array.of(0xf8, 1, 2)]);
	});

	test('rejects an Ogg page whose checksum was changed', async () => {
		const input = createOggOpus([OPUS_SILENCE_FRAME]);
		input[input.byteLength - 1] ^= 1;
		await expect(collect(demuxOggOpus(input))).rejects.toThrow('checksum');
	});

	test('bounds a continued Ogg Opus packet before accumulating untrusted pages', async () => {
		const input = createOggOpus([new Uint8Array(61_441)]);
		await expect(collect(demuxOggOpus(input))).rejects.toThrow('size limit');
	});

	test('rejects Ogg Opus channel mappings that require remapping', async () => {
		await expect(collect(demuxOggOpus(createOggOpus([OPUS_SILENCE_FRAME], 1)))).rejects.toThrow('mapping family zero');
	});

	test('extracts fixed-laced Opus frames from a chunked WebM Cluster', async () => {
		const input = createWebmOpus([OPUS_SILENCE_FRAME, Uint8Array.of(0xf8, 1, 2)]);
		const packets = await collect(demuxWebmOpus(chunk(input, 5)));
		expect(packets).toEqual([OPUS_SILENCE_FRAME, Uint8Array.of(0xf8, 1, 2)]);
	});

	test('bounds WebM Cluster element traversal without materializing an object per element', async () => {
		const elements = new Uint8Array(65_537 * 2);
		for (let offset = 0; offset < elements.byteLength; offset += 2) {
			elements[offset] = 0xec;
			elements[offset + 1] = 0x80;
		}
		await expect(collect(demuxWebmOpus(createWebmWithClusterPayload(elements)))).rejects.toThrow('element limit');
	});

	test('rejects WebM Opus channel mappings that require remapping', async () => {
		await expect(collect(demuxWebmOpus(createWebmOpus([OPUS_SILENCE_FRAME], 1)))).rejects.toThrow(
			'identification data',
		);
	});

	test('rejects a WebM Opus packet that cannot fit the supported media bound', async () => {
		await expect(collect(demuxWebmOpus(createWebmOpus([new Uint8Array(61_441)])))).rejects.toThrow('size limit');
	});
});

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
	const values: Uint8Array[] = [];
	for await (const value of source) values.push(value);
	return values;
}

async function* chunk(value: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
	for (let offset = 0; offset < value.byteLength; offset += size) yield value.subarray(offset, offset + size);
}

function createOpusHead(mappingFamily = 0): Uint8Array {
	const packet = new Uint8Array(19);
	packet.set(encoder.encode('OpusHead'));
	packet[8] = 1;
	packet[9] = 2;
	new DataView(packet.buffer).setUint32(12, 48_000, true);
	packet[18] = mappingFamily;
	return packet;
}

function createOggOpus(audioPackets: readonly Uint8Array[], mappingFamily = 0): Uint8Array {
	const tags = concatenate(encoder.encode('OpusTags'), new Uint8Array(8));
	const packets = [createOpusHead(mappingFamily), tags, ...audioPackets];
	const lacing = Uint8Array.from(
		packets.flatMap(packet => {
			const segments = Array.from({ length: Math.floor(packet.byteLength / 255) }, () => 255);
			segments.push(packet.byteLength % 255);
			return segments;
		}),
	);
	if (lacing.byteLength > 255) throw new Error('The compact Ogg test fixture supports one page only.');
	const payload = concatenate(...packets);
	const header = new Uint8Array(27);
	header.set(encoder.encode('OggS'));
	header[5] = 0x06;
	const view = new DataView(header.buffer);
	view.setUint32(14, 1, true);
	header[26] = lacing.byteLength;
	const page = concatenate(header, lacing, payload);
	view.setUint32(22, oggCrc(page), true);
	return concatenate(header, lacing, payload);
}

function createWebmOpus(frames: readonly Uint8Array[], mappingFamily = 0): Uint8Array {
	if (frames.some(frame => frame.byteLength !== frames[0]?.byteLength)) {
		throw new Error('The compact WebM test fixture requires equal frame sizes.');
	}
	const trackEntry = createWebmOpusTrack(mappingFamily);
	const tracks = element([0x16, 0x54, 0xae, 0x6b], trackEntry);
	const blockPayload = concatenate(Uint8Array.of(0x81, 0, 0, 0x04, frames.length - 1), ...frames);
	const cluster = element([0x1f, 0x43, 0xb6, 0x75], element([0xa3], blockPayload));
	const ebml = element([0x1a, 0x45, 0xdf, 0xa3], new Uint8Array());
	return concatenate(ebml, Uint8Array.of(0x18, 0x53, 0x80, 0x67, 0xff), tracks, cluster);
}

function createWebmWithClusterPayload(payload: Uint8Array): Uint8Array {
	const tracks = element([0x16, 0x54, 0xae, 0x6b], createWebmOpusTrack());
	const cluster = element([0x1f, 0x43, 0xb6, 0x75], payload);
	const ebml = element([0x1a, 0x45, 0xdf, 0xa3], new Uint8Array());
	return concatenate(ebml, Uint8Array.of(0x18, 0x53, 0x80, 0x67, 0xff), tracks, cluster);
}

function createWebmOpusTrack(mappingFamily = 0): Uint8Array {
	return element(
		[0xae],
		concatenate(
			element([0xd7], Uint8Array.of(1)),
			element([0x83], Uint8Array.of(2)),
			element([0x86], encoder.encode('A_OPUS')),
			element([0x63, 0xa2], createOpusHead(mappingFamily)),
			element([0xe1], element([0x9f], Uint8Array.of(2))),
		),
	);
}

function element(id: readonly number[], payload: Uint8Array): Uint8Array {
	return concatenate(Uint8Array.from(id), encodeEbmlSize(payload.byteLength), payload);
}

function encodeEbmlSize(size: number): Uint8Array {
	let length = 1;
	while (size >= 2 ** (7 * length) - 1) length++;
	if (length > 8) throw new Error('The EBML test fixture size is too large.');
	const output = new Uint8Array(length);
	let remaining = size;
	for (let index = length - 1; index >= 0; index--) {
		output[index] = remaining & 0xff;
		remaining = Math.floor(remaining / 256);
	}
	output[0] |= 1 << (8 - length);
	return output;
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
