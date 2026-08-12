import { concatenateBytes } from '../bytes';
import type { VoiceCryptoProvider } from '../crypto/provider';
import type { VoiceTransportEncryptionMode } from '../voice-gateway/protocol';

const RTP_HEADER_SIZE = 12;
const RTP_OPUS_PAYLOAD_TYPE = 0x78;
const TRANSPORT_NONCE_SUFFIX_SIZE = 4;

/** @internal */
export class VoiceRtpPacketizer {
	readonly #provider: VoiceCryptoProvider;
	readonly #mode: VoiceTransportEncryptionMode;
	readonly #ssrc: number;
	readonly #nonce: Uint8Array;
	#secretKey: Uint8Array;
	#sequence: number;
	#timestamp: number;
	#nonceCounter = 0;
	#closed = false;

	constructor(options: {
		readonly provider: VoiceCryptoProvider;
		readonly mode: VoiceTransportEncryptionMode;
		readonly secretKey: Uint8Array;
		readonly ssrc: number;
		readonly random: () => number;
	}) {
		if (options.secretKey.byteLength !== 32) {
			throw new TypeError('A voice transport encryption key must contain 32 bytes.');
		}
		if (!Number.isInteger(options.ssrc) || options.ssrc < 0 || options.ssrc > 0xffff_ffff) {
			throw new RangeError('A voice RTP SSRC must be an unsigned 32-bit integer.');
		}
		this.#provider = options.provider;
		this.#mode = options.mode;
		this.#secretKey = options.secretKey.slice();
		this.#ssrc = options.ssrc;
		this.#nonce = new Uint8Array(options.mode === 'aead_aes256_gcm_rtpsize' ? 12 : 24);
		this.#sequence = randomUnsigned(options.random, 16);
		this.#timestamp = randomUnsigned(options.random, 32);
	}

	createPacket(frame: Uint8Array, samples: number): Uint8Array {
		this.assertOpen();
		if (frame.byteLength === 0) throw new TypeError('A voice RTP packet cannot contain an empty audio frame.');
		assertSampleCount(samples);
		if (this.#nonceCounter === 0xffff_ffff) {
			throw new RangeError('The voice transport encryption nonce is exhausted.');
		}

		const header = createRtpHeader(this.#sequence, this.#timestamp, this.#ssrc);
		const nonceCounter = ++this.#nonceCounter;
		new DataView(this.#nonce.buffer).setUint32(0, nonceCounter);
		const encrypted =
			this.#mode === 'aead_aes256_gcm_rtpsize'
				? this.#provider.aesGcmSeal(this.#secretKey, this.#nonce, header, frame)
				: this.#provider.xchacha20Poly1305Seal(this.#secretKey, this.#nonce, header, frame);
		const nonceSuffix = this.#nonce.slice(0, TRANSPORT_NONCE_SUFFIX_SIZE);
		this.#sequence = (this.#sequence + 1) & 0xffff;
		this.#timestamp = (this.#timestamp + samples) >>> 0;
		return concatenateBytes(header, encrypted, nonceSuffix);
	}

	advanceTimestamp(samples: number): void {
		this.assertOpen();
		if (!Number.isSafeInteger(samples) || samples < 0) {
			throw new RangeError('RTP timestamp advancement must be a non-negative safe integer.');
		}
		this.#timestamp = (this.#timestamp + samples) >>> 0;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#secretKey.fill(0);
		this.#nonce.fill(0);
	}

	private assertOpen(): void {
		if (!this.#closed) return;
		throw new Error('The voice RTP packetizer is closed.');
	}
}

export interface VoiceRtpPacket {
	readonly sequence: number;
	readonly timestamp: number;
	readonly ssrc: number;
	readonly marker: boolean;
	readonly opus: Uint8Array;
}

/** @internal */
export class VoiceRtpDepacketizer {
	readonly #provider: VoiceCryptoProvider;
	readonly #mode: VoiceTransportEncryptionMode;
	readonly #nonce: Uint8Array;
	#secretKey: Uint8Array;
	#closed = false;

	constructor(options: {
		readonly provider: VoiceCryptoProvider;
		readonly mode: VoiceTransportEncryptionMode;
		readonly secretKey: Uint8Array;
	}) {
		if (options.secretKey.byteLength !== 32) {
			throw new TypeError('A voice transport encryption key must contain 32 bytes.');
		}
		this.#provider = options.provider;
		this.#mode = options.mode;
		this.#secretKey = options.secretKey.slice();
		this.#nonce = new Uint8Array(options.mode === 'aead_aes256_gcm_rtpsize' ? 12 : 24);
	}

	openPacket(packet: Uint8Array): VoiceRtpPacket {
		this.assertOpen();
		if (packet.byteLength < RTP_HEADER_SIZE + 16 + TRANSPORT_NONCE_SUFFIX_SIZE) {
			throw new RangeError('An encrypted voice RTP packet is truncated.');
		}
		const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
		const first = packet[0] as number;
		if (first >>> 6 !== 2) throw new TypeError('A voice RTP packet must use RTP version two.');
		const payloadType = (packet[1] as number) & 0x7f;
		if (payloadType !== RTP_OPUS_PAYLOAD_TYPE) throw new TypeError('A voice RTP packet must contain Opus audio.');
		const csrcCount = first & 0x0f;
		const hasExtension = (first & 0x10) !== 0;
		const hasPadding = (first & 0x20) !== 0;
		const extensionPreambleOffset = RTP_HEADER_SIZE + csrcCount * 4;
		// Discord's rtpsize modes authenticate the RTP header and extension preamble; extension data stays encrypted.
		const headerSize = extensionPreambleOffset + (hasExtension ? 4 : 0);
		if (packet.byteLength < headerSize + 16 + TRANSPORT_NONCE_SUFFIX_SIZE) {
			throw new RangeError('An encrypted voice RTP header is truncated.');
		}

		const extensionSize = hasExtension ? view.getUint16(extensionPreambleOffset + 2) * 4 : 0;
		const nonceOffset = packet.byteLength - TRANSPORT_NONCE_SUFFIX_SIZE;
		this.#nonce.fill(0);
		this.#nonce.set(packet.subarray(nonceOffset), 0);
		const authenticatedHeader = packet.subarray(0, headerSize);
		const ciphertext = packet.subarray(headerSize, nonceOffset);
		const plaintext =
			this.#mode === 'aead_aes256_gcm_rtpsize'
				? this.#provider.aesGcmOpen(this.#secretKey, this.#nonce, authenticatedHeader, ciphertext)
				: this.#provider.xchacha20Poly1305Open(this.#secretKey, this.#nonce, authenticatedHeader, ciphertext);
		try {
			if (plaintext.byteLength < extensionSize) throw new RangeError('An RTP header extension is truncated.');
			if (plaintext.byteLength === extensionSize)
				throw new TypeError('A voice RTP packet cannot contain an empty Opus frame.');

			let payloadEnd = plaintext.byteLength;
			if (hasPadding) {
				const paddingSize = plaintext[payloadEnd - 1] as number;
				if (paddingSize === 0 || paddingSize > payloadEnd - extensionSize) {
					throw new RangeError('An RTP padding section is invalid.');
				}
				payloadEnd -= paddingSize;
			}
			if (payloadEnd === extensionSize) throw new TypeError('A voice RTP packet cannot contain an empty Opus frame.');
			return Object.freeze({
				sequence: view.getUint16(2),
				timestamp: view.getUint32(4),
				ssrc: view.getUint32(8),
				marker: ((packet[1] as number) & 0x80) !== 0,
				opus: plaintext.slice(extensionSize, payloadEnd),
			});
		} finally {
			plaintext.fill(0);
		}
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#secretKey.fill(0);
		this.#nonce.fill(0);
	}

	private assertOpen(): void {
		if (!this.#closed) return;
		throw new Error('The voice RTP depacketizer is closed.');
	}
}

function createRtpHeader(sequence: number, timestamp: number, ssrc: number): Uint8Array {
	const header = new Uint8Array(RTP_HEADER_SIZE);
	const view = new DataView(header.buffer);
	header[0] = 0x80;
	header[1] = RTP_OPUS_PAYLOAD_TYPE;
	view.setUint16(2, sequence);
	view.setUint32(4, timestamp);
	view.setUint32(8, ssrc);
	return header;
}

function randomUnsigned(random: () => number, bits: 16 | 32): number {
	const value = random();
	if (!Number.isFinite(value) || value < 0 || value >= 1) {
		throw new RangeError('The runtime random source must return a value from zero inclusive to one exclusive.');
	}
	return Math.floor(value * 2 ** bits) >>> 0;
}

function assertSampleCount(samples: number): void {
	if (Number.isInteger(samples) && samples > 0 && samples <= 5_760) return;
	throw new RangeError('An Opus RTP packet must contain between 1 and 5760 samples.');
}
