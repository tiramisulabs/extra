import { bytesStartWith, equalBytes } from '../bytes';

export const OPUS_SAMPLE_RATE = 48_000;
export const OPUS_SILENCE_FRAME = Uint8Array.of(0xf8, 0xff, 0xfe);
export const OPUS_SILENCE_SAMPLES = 960;
export const MAX_OPUS_PACKET_SIZE = 61_440;

const OPUS_HEAD = new TextEncoder().encode('OpusHead');

export function assertDiscordOpusHead(packet: Uint8Array): void {
	if (packet.byteLength < 19 || !bytesStartWith(packet, OPUS_HEAD) || packet[8] !== 1) {
		throw new TypeError('The media stream does not contain a supported OpusHead packet.');
	}
	if (packet[9] !== 2) throw new TypeError('Discord playback requires a stereo Opus stream.');
	if (packet[18] !== 0) throw new TypeError('Discord playback requires Opus channel mapping family zero.');
}

export function isOpusSilenceFrame(frame: Uint8Array): boolean {
	return equalBytes(frame, OPUS_SILENCE_FRAME);
}

export function getOpusPacketSamples(packet: Uint8Array): number {
	if (packet.byteLength === 0) throw new TypeError('An Opus packet cannot be empty.');
	const toc = packet[0] as number;
	const config = toc >>> 3;
	const frameCountCode = toc & 0x03;
	let frameCount: number;
	if (frameCountCode === 0) frameCount = 1;
	else if (frameCountCode === 1 || frameCountCode === 2) frameCount = 2;
	else {
		if (packet.byteLength < 2) throw new TypeError('An Opus code 3 packet is missing its frame count byte.');
		frameCount = (packet[1] as number) & 0x3f;
		if (frameCount === 0 || frameCount > 48) throw new TypeError('An Opus packet has an invalid frame count.');
	}

	let samplesPerFrame: number;
	if (config >= 16) samplesPerFrame = 120 << (config & 0x03);
	else if (config >= 12) samplesPerFrame = 480 << (config & 0x01);
	else samplesPerFrame = (config & 0x03) === 3 ? 2_880 : 480 << (config & 0x03);
	const samples = frameCount * samplesPerFrame;
	if (samples > 5_760) throw new TypeError('An Opus packet duration cannot exceed 120 milliseconds.');
	return samples;
}
