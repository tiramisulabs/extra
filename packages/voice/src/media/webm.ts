import { concatenateBytes } from '../bytes';
import { AsyncByteReader, type VoiceByteInput } from './input';
import { assertDiscordOpusHead, MAX_OPUS_PACKET_SIZE } from './opus';
import type { VoicePlaybackSource } from './playback';

const WebmElementId = Object.freeze({
	Ebml: 0x1a45dfa3,
	Segment: 0x18538067,
	Tracks: 0x1654ae6b,
	TrackEntry: 0xae,
	TrackNumber: 0xd7,
	TrackType: 0x83,
	CodecId: 0x86,
	CodecPrivate: 0x63a2,
	Audio: 0xe1,
	Channels: 0x9f,
	Cluster: 0x1f43b675,
	SimpleBlock: 0xa3,
	BlockGroup: 0xa0,
	Block: 0xa1,
} as const);

const WebmLimit = Object.freeze({
	tracksSize: 1_048_576,
	clusterSize: 67_108_864,
	trackElements: 4_096,
	clusterElements: 65_536,
	blockGroupElements: 1_024,
} as const);

interface EbmlElementHeader {
	readonly id: number;
	readonly size: number | undefined;
}

interface ParsedElement extends EbmlElementHeader {
	readonly dataStart: number;
	readonly dataEnd: number;
}

export function demuxWebmOpus(input: VoiceByteInput): VoicePlaybackSource {
	return {
		async *[Symbol.asyncIterator]() {
			const reader = new AsyncByteReader(input);
			try {
				yield* readWebmOpusPackets(reader);
			} finally {
				await reader.close();
			}
		},
	};
}

async function* readWebmOpusPackets(reader: AsyncByteReader): AsyncGenerator<Uint8Array> {
	const ebml = await readElementHeader(reader);
	if (!ebml || ebml.id !== WebmElementId.Ebml || ebml.size === undefined)
		throw new TypeError('The input is not a supported WebM file.');
	await reader.skip(ebml.size);
	const segment = await readElementHeader(reader);
	if (!segment || segment.id !== WebmElementId.Segment)
		throw new TypeError('The WebM file is missing its Segment element.');
	const segmentEnd = segment.size === undefined ? undefined : reader.position + segment.size;
	let opusTrack: number | undefined;
	let foundCluster = false;

	while (segmentEnd === undefined || reader.position < segmentEnd) {
		const header = await readElementHeader(reader);
		if (!header) break;
		if (header.size === undefined) throw new TypeError('Only an unknown-sized WebM Segment element is supported.');
		if (segmentEnd !== undefined && reader.position + header.size > segmentEnd) {
			throw new TypeError('A WebM element exceeds its containing Segment.');
		}
		if (header.id === WebmElementId.Tracks) {
			if (header.size > WebmLimit.tracksSize) throw new TypeError('The WebM Tracks element is unreasonably large.');
			opusTrack = parseOpusTrack(await reader.readExactly(header.size));
			continue;
		}
		if (header.id === WebmElementId.Cluster) {
			if (opusTrack === undefined) throw new TypeError('A WebM Cluster appeared before its Opus track declaration.');
			if (header.size > WebmLimit.clusterSize)
				throw new TypeError('A WebM Cluster exceeds the supported streaming bound.');
			foundCluster = true;
			const cluster = await reader.readExactly(header.size);
			for (const packet of parseCluster(cluster, opusTrack)) yield packet;
			continue;
		}
		await reader.skip(header.size);
	}

	if (segmentEnd !== undefined && reader.position !== segmentEnd) throw new TypeError('The WebM Segment is truncated.');
	if (opusTrack === undefined) throw new TypeError('The WebM file does not contain a stereo Opus audio track.');
	if (!foundCluster) throw new TypeError('The WebM file does not contain a media Cluster.');
}

async function readElementHeader(reader: AsyncByteReader): Promise<EbmlElementHeader | undefined> {
	const first = await reader.readExactlyOrEof(1);
	if (!first) return undefined;
	const idLength = vintLength(first[0] as number, 4);
	const idBytes = idLength === 1 ? first : concatenateBytes(first, await reader.readExactly(idLength - 1));
	const sizeFirst = await reader.readExactly(1);
	const sizeLength = vintLength(sizeFirst[0] as number, 8);
	const sizeBytes =
		sizeLength === 1 ? sizeFirst : concatenateBytes(sizeFirst, await reader.readExactly(sizeLength - 1));
	return { id: readElementId(idBytes), size: readVintValue(sizeBytes) };
}

function parseOpusTrack(data: Uint8Array): number {
	const tracks = parseElements(data, 0, data.byteLength, WebmLimit.trackElements);
	let opusTrack: number | undefined;
	for (const entry of tracks) {
		if (entry.id !== WebmElementId.TrackEntry) continue;
		let number: number | undefined;
		let type: number | undefined;
		let codec: string | undefined;
		let codecPrivate: Uint8Array | undefined;
		let channels: number | undefined;
		for (const child of parseElements(data, entry.dataStart, entry.dataEnd, WebmLimit.trackElements)) {
			const value = data.subarray(child.dataStart, child.dataEnd);
			if (child.id === WebmElementId.TrackNumber) number = readUnsigned(value);
			else if (child.id === WebmElementId.TrackType) type = readUnsigned(value);
			else if (child.id === WebmElementId.CodecId) codec = new TextDecoder().decode(value);
			else if (child.id === WebmElementId.CodecPrivate) codecPrivate = value;
			else if (child.id === WebmElementId.Audio) {
				for (const audioChild of parseElements(data, child.dataStart, child.dataEnd, WebmLimit.trackElements)) {
					if (audioChild.id === WebmElementId.Channels)
						channels = readUnsigned(data.subarray(audioChild.dataStart, audioChild.dataEnd));
				}
			}
		}
		if (type !== 2 || codec !== 'A_OPUS') continue;
		if (number === undefined || number === 0 || !codecPrivate) {
			throw new TypeError('The WebM Opus track has invalid identification data.');
		}
		try {
			assertDiscordOpusHead(codecPrivate);
		} catch (cause) {
			throw new TypeError('The WebM Opus track has invalid identification data.', { cause });
		}
		if (channels !== undefined && channels !== 2)
			throw new TypeError('Discord playback requires a stereo Opus stream.');
		if (opusTrack !== undefined) throw new TypeError('A WebM file with multiple Opus audio tracks is ambiguous.');
		opusTrack = number;
	}
	if (opusTrack === undefined) throw new TypeError('The WebM file does not contain a stereo Opus audio track.');
	return opusTrack;
}

function* parseCluster(data: Uint8Array, trackNumber: number): Generator<Uint8Array> {
	for (const element of parseElements(data, 0, data.byteLength, WebmLimit.clusterElements)) {
		if (element.id === WebmElementId.SimpleBlock) {
			yield* parseBlock(data.subarray(element.dataStart, element.dataEnd), trackNumber);
		} else if (element.id === WebmElementId.BlockGroup) {
			for (const child of parseElements(data, element.dataStart, element.dataEnd, WebmLimit.blockGroupElements)) {
				if (child.id === WebmElementId.Block)
					yield* parseBlock(data.subarray(child.dataStart, child.dataEnd), trackNumber);
			}
		}
	}
}

function parseBlock(block: Uint8Array, expectedTrack: number): Uint8Array[] {
	if (block.byteLength < 4) throw new TypeError('A WebM Block is truncated.');
	const trackLength = vintLength(block[0] as number, 8);
	if (trackLength + 3 > block.byteLength) throw new TypeError('A WebM Block header is truncated.');
	const track = readVintValue(block.subarray(0, trackLength));
	if (track === undefined) throw new TypeError('A WebM Block has an invalid track number.');
	if (track !== expectedTrack) return [];
	const flags = block[trackLength + 2] as number;
	const payload = block.subarray(trackLength + 3);
	return splitLacedFrames(payload, (flags & 0x06) >>> 1);
}

function splitLacedFrames(payload: Uint8Array, lacing: number): Uint8Array[] {
	if (lacing === 0) return [copyNonEmptyFrame(payload)];
	if (payload.byteLength === 0) throw new TypeError('A laced WebM Block is missing its lace count.');
	const frameCount = (payload[0] as number) + 1;
	let offset = 1;
	const sizes: number[] = [];
	if (lacing === 1) {
		for (let frame = 0; frame < frameCount - 1; frame++) {
			let size = 0;
			while (true) {
				if (offset >= payload.byteLength) throw new TypeError('A WebM Xiph lace is truncated.');
				const value = payload[offset++] as number;
				size += value;
				if (value !== 255) break;
			}
			sizes.push(size);
		}
	} else if (lacing === 2) {
		const remaining = payload.byteLength - offset;
		if (remaining % frameCount !== 0) throw new TypeError('A fixed WebM lace does not divide into equal frames.');
		for (let frame = 0; frame < frameCount - 1; frame++) sizes.push(remaining / frameCount);
	} else {
		const first = readVintAt(payload, offset);
		offset += first.length;
		if (first.value === undefined) throw new TypeError('A WebM EBML lace has an invalid first frame size.');
		sizes.push(first.value);
		for (let frame = 1; frame < frameCount - 1; frame++) {
			const difference = readVintAt(payload, offset);
			offset += difference.length;
			if (difference.value === undefined) throw new TypeError('A WebM EBML lace has an invalid size difference.');
			const bias = 2 ** (7 * difference.length - 1) - 1;
			const size = (sizes.at(-1) as number) + difference.value - bias;
			if (size < 0) throw new TypeError('A WebM EBML lace has a negative frame size.');
			sizes.push(size);
		}
	}
	const declared = sizes.reduce((total, size) => total + size, 0);
	const finalSize = payload.byteLength - offset - declared;
	if (finalSize < 0) throw new TypeError('A WebM lace declares more data than its Block contains.');
	sizes.push(finalSize);
	const frames: Uint8Array[] = [];
	for (const size of sizes) {
		frames.push(copyNonEmptyFrame(payload.subarray(offset, offset + size)));
		offset += size;
	}
	return frames;
}

function* parseElements(
	data: Uint8Array,
	start = 0,
	end = data.byteLength,
	maximumElements = Number.POSITIVE_INFINITY,
): Generator<ParsedElement> {
	let offset = start;
	let count = 0;
	while (offset < end) {
		if (++count > maximumElements) throw new TypeError('A WebM container exceeds the supported element limit.');
		const idLength = vintLength(data[offset] as number, 4);
		if (offset + idLength >= end) throw new TypeError('An EBML element header is truncated.');
		const id = readElementId(data.subarray(offset, offset + idLength));
		offset += idLength;
		const size = readVintAt(data, offset);
		offset += size.length;
		if (size.value === undefined) throw new TypeError('An unknown-sized nested WebM element is not supported.');
		const dataEnd = offset + size.value;
		if (dataEnd > end) throw new TypeError('An EBML element exceeds its containing element.');
		yield { id, size: size.value, dataStart: offset, dataEnd };
		offset = dataEnd;
	}
}

function readVintAt(data: Uint8Array, offset: number): { readonly value: number | undefined; readonly length: number } {
	if (offset >= data.byteLength) throw new TypeError('An EBML variable-length integer is truncated.');
	const length = vintLength(data[offset] as number, 8);
	if (offset + length > data.byteLength) throw new TypeError('An EBML variable-length integer is truncated.');
	return { value: readVintValue(data.subarray(offset, offset + length)), length };
}

function vintLength(first: number, maximum: number): number {
	if (first === 0) throw new TypeError('An EBML variable-length integer cannot begin with zero.');
	let mask = 0x80;
	let length = 1;
	while ((first & mask) === 0) {
		mask >>>= 1;
		length++;
	}
	if (length > maximum) throw new TypeError('An EBML variable-length integer is too long.');
	return length;
}

function readElementId(bytes: Uint8Array): number {
	let value = 0;
	for (const byte of bytes) value = value * 256 + byte;
	return value;
}

function readVintValue(bytes: Uint8Array): number | undefined {
	const marker = 1 << (8 - bytes.byteLength);
	let value = (bytes[0] as number) & (marker - 1);
	for (let index = 1; index < bytes.byteLength; index++) value = value * 256 + (bytes[index] as number);
	const unknown = 2 ** (7 * bytes.byteLength) - 1;
	if (value === unknown) return undefined;
	if (!Number.isSafeInteger(value)) throw new TypeError('An EBML element size exceeds JavaScript safe integers.');
	return value;
}

function readUnsigned(bytes: Uint8Array): number {
	if (bytes.byteLength === 0 || bytes.byteLength > 8)
		throw new TypeError('An EBML unsigned integer has an invalid size.');
	let value = 0;
	for (const byte of bytes) value = value * 256 + byte;
	if (!Number.isSafeInteger(value)) throw new TypeError('An EBML unsigned integer exceeds JavaScript safe integers.');
	return value;
}

function copyNonEmptyFrame(frame: Uint8Array): Uint8Array {
	if (frame.byteLength === 0) throw new TypeError('A WebM Opus frame cannot be empty.');
	if (frame.byteLength > MAX_OPUS_PACKET_SIZE) {
		throw new TypeError('A WebM Opus frame exceeds the supported size limit.');
	}
	return frame.slice();
}
