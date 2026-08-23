import { bytesStartWith, concatenateBytes } from '../bytes';
import { AsyncByteReader, type VoiceByteInput } from './input';
import { assertDiscordOpusHead, MAX_OPUS_PACKET_SIZE } from './opus';
import type { VoicePlaybackSource } from './playback';

const OGG_CAPTURE_PATTERN = Uint8Array.of(0x4f, 0x67, 0x67, 0x53);
const OPUS_TAGS = new TextEncoder().encode('OpusTags');
const OGG_CRC_TABLE = createOggCrcTable();
const MAX_OGG_HEADER_PACKET_SIZE = 1_048_576;

export function demuxOggOpus(input: VoiceByteInput): VoicePlaybackSource {
	return {
		async *[Symbol.asyncIterator]() {
			const reader = new AsyncByteReader(input);
			try {
				yield* readOggOpusPackets(reader);
			} finally {
				await reader.close();
			}
		},
	};
}

async function* readOggOpusPackets(reader: AsyncByteReader): AsyncGenerator<Uint8Array> {
	let serial: number | undefined;
	let sequence: number | undefined;
	let pageCount = 0;
	let packetCount = 0;
	let ended = false;
	let packetSegments: Uint8Array[] = [];
	let packetSize = 0;

	while (!ended) {
		const fixedHeader = await reader.readExactlyOrEof(27);
		if (!fixedHeader) break;
		pageCount++;
		if (!bytesStartWith(fixedHeader, OGG_CAPTURE_PATTERN) || fixedHeader[4] !== 0) {
			throw new TypeError('The input is not a supported Ogg bitstream.');
		}
		const flags = fixedHeader[5] as number;
		if ((flags & ~0x07) !== 0) throw new TypeError('An Ogg page contains unsupported header flags.');
		const view = new DataView(fixedHeader.buffer, fixedHeader.byteOffset, fixedHeader.byteLength);
		const pageSerial = view.getUint32(14, true);
		const pageSequence = view.getUint32(18, true);
		const expectedChecksum = view.getUint32(22, true);
		const segmentTable = await reader.readExactly(fixedHeader[26] as number);
		const payloadLength = segmentTable.reduce((total, value) => total + value, 0);
		const payload = await reader.readExactly(payloadLength);
		const checksumHeader = fixedHeader.slice();
		checksumHeader.fill(0, 22, 26);
		if (oggCrc(concatenateBytes(checksumHeader, segmentTable, payload)) !== expectedChecksum) {
			throw new TypeError('An Ogg page checksum is invalid.');
		}

		if (serial === undefined) {
			if ((flags & 0x02) === 0 || (flags & 0x01) !== 0) {
				throw new TypeError('The first Ogg Opus page must begin a logical bitstream.');
			}
			serial = pageSerial;
			sequence = pageSequence;
		} else {
			if (pageSerial !== serial) throw new TypeError('Chained or multiplexed Ogg streams are not supported.');
			const expectedSequence = ((sequence as number) + 1) >>> 0;
			if (pageSequence !== expectedSequence) throw new TypeError('The Ogg page sequence is discontinuous.');
			sequence = pageSequence;
			if ((flags & 0x02) !== 0) throw new TypeError('An Ogg logical stream contains a second beginning page.');
		}
		const continued = (flags & 0x01) !== 0;
		if (continued !== packetSegments.length > 0) {
			throw new TypeError('An Ogg packet continuation flag does not match its lacing data.');
		}

		let payloadOffset = 0;
		for (const segmentLength of segmentTable) {
			packetSize += segmentLength;
			const maximumPacketSize = packetCount < 2 ? MAX_OGG_HEADER_PACKET_SIZE : MAX_OPUS_PACKET_SIZE;
			if (packetSize > maximumPacketSize) {
				throw new TypeError('An Ogg Opus packet exceeds the supported size limit.');
			}
			packetSegments.push(payload.slice(payloadOffset, payloadOffset + segmentLength));
			payloadOffset += segmentLength;
			if (segmentLength === 255) continue;
			const packet = concatenateBytes(...packetSegments);
			packetSegments = [];
			packetSize = 0;
			if (packetCount === 0) assertDiscordOpusHead(packet);
			else if (packetCount === 1) validateOpusTags(packet);
			else {
				if (packet.byteLength === 0) throw new TypeError('An Ogg Opus audio packet cannot be empty.');
				yield packet;
			}
			packetCount++;
		}

		ended = (flags & 0x04) !== 0;
		if (ended && packetSegments.length > 0) throw new TypeError('The Ogg stream ended inside an Opus packet.');
	}

	if (pageCount === 0) throw new TypeError('The Ogg Opus input is empty.');
	if (!ended) throw new TypeError('The Ogg Opus stream is missing its end page.');
	if (packetCount < 2) throw new TypeError('The Ogg Opus stream is missing its identification or comment header.');
	if (await reader.readExactlyOrEof(1)) throw new TypeError('Chained Ogg streams are not supported.');
}

function validateOpusTags(packet: Uint8Array): void {
	if (!bytesStartWith(packet, OPUS_TAGS) || packet.byteLength < 16) {
		throw new TypeError('The Ogg Opus stream is missing its OpusTags packet.');
	}
	const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
	const vendorLength = view.getUint32(8, true);
	let offset = 12 + vendorLength;
	if (offset + 4 > packet.byteLength) throw new TypeError('The Ogg OpusTags vendor field is truncated.');
	const commentCount = view.getUint32(offset, true);
	offset += 4;
	for (let index = 0; index < commentCount; index++) {
		if (offset + 4 > packet.byteLength) throw new TypeError('An Ogg OpusTags comment is truncated.');
		const length = view.getUint32(offset, true);
		offset += 4 + length;
		if (offset > packet.byteLength) throw new TypeError('An Ogg OpusTags comment is truncated.');
	}
}

function createOggCrcTable(): Uint32Array {
	const table = new Uint32Array(256);
	for (let index = 0; index < table.length; index++) {
		let value = index << 24;
		for (let bit = 0; bit < 8; bit++) value = value & 0x8000_0000 ? (value << 1) ^ 0x04c1_1db7 : value << 1;
		table[index] = value >>> 0;
	}
	return table;
}

function oggCrc(value: Uint8Array): number {
	let checksum = 0;
	for (const byte of value)
		checksum = ((checksum << 8) ^ (OGG_CRC_TABLE[((checksum >>> 24) ^ byte) & 0xff] as number)) >>> 0;
	return checksum;
}
