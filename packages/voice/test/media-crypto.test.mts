import { describe, expect, test } from 'vitest';
import { concatenateBytes } from '../src/bytes';
import { VoiceCryptoProvider } from '../src/crypto/provider';
import { DaveAudioDecryptor, DaveAudioEncryptor, parseDaveAudioFrame, resolveDaveNonce } from '../src/dave/audio';
import { VoiceRtpDepacketizer, VoiceRtpPacketizer } from '../src/media/rtp';
import { deriveTreeSecret } from '../src/mls/crypto';

describe('voice media encryption', () => {
	test('encodes the DAVE Opus frame format with its sender ratchet and supplemental data', () => {
		const provider = new VoiceCryptoProvider();
		const baseSecret = Uint8Array.from({ length: 16 }, (_, index) => index);
		const frame = Uint8Array.of(1, 2, 3);
		const encryptor = new DaveAudioEncryptor(provider, baseSecret);

		const encrypted = encryptor.encrypt(frame);
		expect(encrypted.subarray(-4)).toEqual(Uint8Array.of(1, 12, 0xfa, 0xfa));
		const key = deriveTreeSecret(provider, baseSecret, 'key', 0, 16);
		const nonce = new Uint8Array(12);
		new DataView(nonce.buffer).setUint32(8, 1, true);
		expect(provider.aesGcmOpen(key, nonce, new Uint8Array(), encrypted.subarray(0, -4), 8)).toEqual(frame);

		const second = encryptor.encrypt(frame);
		expect(second.subarray(-4)).toEqual(Uint8Array.of(2, 12, 0xfa, 0xfa));
		encryptor.close();
		expect(() => encryptor.encrypt(frame)).toThrow('closed');
	});

	test('continues the DAVE sender generation when the truncated nonce wraps', () => {
		expect(resolveDaveNonce(0xffff_ffffn)).toEqual({ generation: 255, truncatedNonce: 0xffff_ffff });
		expect(resolveDaveNonce(0x1_0000_0000n)).toEqual({ generation: 256, truncatedNonce: 0 });
	});

	test('decrypts authenticated DAVE frames once and always passes the Opus silence packet', () => {
		const provider = new VoiceCryptoProvider();
		const baseSecret = Uint8Array.from({ length: 16 }, (_, index) => index);
		const encryptor = new DaveAudioEncryptor(provider, baseSecret);
		const decryptor = new DaveAudioDecryptor(provider, baseSecret);
		const frame = Uint8Array.of(1, 2, 3, 4);
		const encrypted = encryptor.encrypt(frame);
		const tampered = encrypted.slice();
		tampered[0] = (tampered[0] as number) ^ 1;

		expect(decryptor.decrypt(parseDaveAudioFrame(tampered)!)).toBeUndefined();
		expect(decryptor.decrypt(parseDaveAudioFrame(encrypted)!)).toEqual(frame);
		expect(decryptor.decrypt(parseDaveAudioFrame(encrypted)!)).toBeUndefined();
		const silence = Uint8Array.of(0xf8, 0xff, 0xfe);
		const passthrough = encryptor.encrypt(silence);
		expect(passthrough).toEqual(silence);
		expect(passthrough).not.toBe(silence);

		encryptor.close();
		decryptor.close();
	});

	test.each([
		'aead_aes256_gcm_rtpsize',
		'aead_xchacha20_poly1305_rtpsize',
	] as const)('creates and authenticates %s RTP packets', mode => {
		const provider = new VoiceCryptoProvider();
		const secretKey = Uint8Array.from({ length: 32 }, (_, index) => index);
		const packetizer = new VoiceRtpPacketizer({
			provider,
			mode,
			secretKey,
			ssrc: 42,
			random: () => 0,
		});
		const frame = Uint8Array.of(1, 2, 3, 4);

		const packet = packetizer.createPacket(frame, 960);
		expect(packet.subarray(0, 12)).toEqual(Uint8Array.of(0x80, 0x78, 0, 0, 0, 0, 0, 0, 0, 0, 0, 42));
		expect(packet.subarray(-4)).toEqual(Uint8Array.of(0, 0, 0, 1));
		const nonce = new Uint8Array(mode === 'aead_aes256_gcm_rtpsize' ? 12 : 24);
		nonce.set(packet.subarray(-4));
		const encrypted = packet.subarray(12, -4);
		const decrypted =
			mode === 'aead_aes256_gcm_rtpsize'
				? provider.aesGcmOpen(secretKey, nonce, packet.subarray(0, 12), encrypted)
				: provider.xchacha20Poly1305Open(secretKey, nonce, packet.subarray(0, 12), encrypted);
		expect(decrypted).toEqual(frame);
		const depacketizer = new VoiceRtpDepacketizer({ provider, mode, secretKey });
		expect(depacketizer.openPacket(packet)).toMatchObject({
			sequence: 0,
			timestamp: 0,
			ssrc: 42,
			marker: false,
			opus: frame,
		});

		const second = packetizer.createPacket(frame, 960);
		expect(new DataView(second.buffer, second.byteOffset).getUint16(2)).toBe(1);
		expect(new DataView(second.buffer, second.byteOffset).getUint32(4)).toBe(960);
		packetizer.close();
		depacketizer.close();
	});

	test('opens RTP packets with CSRC-free encrypted extensions and padding', () => {
		const provider = new VoiceCryptoProvider();
		const secretKey = Uint8Array.from({ length: 32 }, (_, index) => index);
		const header = Uint8Array.of(0xb0, 0xf8, 0x12, 0x34, 0, 0, 0, 9, 0, 0, 0, 42, 0xbe, 0xde, 0, 1);
		const plaintext = Uint8Array.of(0x10, 1, 2, 0, 9, 8, 0, 2);
		const suffix = Uint8Array.of(0, 0, 0, 1);
		const nonce = new Uint8Array(12);
		nonce.set(suffix);
		const packet = concatenateBytes(header, provider.aesGcmSeal(secretKey, nonce, header, plaintext), suffix);
		const depacketizer = new VoiceRtpDepacketizer({
			provider,
			mode: 'aead_aes256_gcm_rtpsize',
			secretKey,
		});

		expect(depacketizer.openPacket(packet)).toEqual({
			sequence: 0x1234,
			timestamp: 9,
			ssrc: 42,
			marker: true,
			opus: Uint8Array.of(9, 8),
		});
		const tampered = packet.slice();
		tampered[4] = 1;
		expect(() => depacketizer.openPacket(tampered)).toThrow();
		depacketizer.close();
	});
});
