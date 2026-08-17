import { describe, expect, test } from 'vitest';
import { createVoiceIpDiscoveryRequest, parseVoiceIpDiscoveryResponse } from '../src/voice-gateway/ip-discovery';
import {
	classifyVoiceGatewayClose,
	createVoiceGatewayUrl,
	decodeVoiceGatewayMessage,
	encodeVoiceGatewayBinaryMessage,
	parseVoiceGatewayClientDisconnect,
	parseVoiceGatewaySessionDescription,
	parseVoiceGatewaySpeaking,
	selectVoiceTransportEncryptionMode,
	VoiceGatewayOpcode,
} from '../src/voice-gateway/protocol';

function createDiscoveryResponse(ssrc: number, address: string, port: number): Uint8Array {
	const packet = new Uint8Array(74);
	const view = new DataView(packet.buffer);
	view.setUint16(0, 2);
	view.setUint16(2, 70);
	view.setUint32(4, ssrc);
	packet.set(new TextEncoder().encode(address), 8);
	view.setUint16(72, port);
	return packet;
}

describe('Voice Gateway protocol', () => {
	test('normalizes Discord Voice Gateway endpoints to version 8', () => {
		expect(createVoiceGatewayUrl('voice.example.test:443')).toBe('wss://voice.example.test/?v=8');
		expect(createVoiceGatewayUrl('wss://voice.example.test/path?old=true')).toBe('wss://voice.example.test/?v=8');
		expect(() => createVoiceGatewayUrl('ws://voice.example.test')).toThrowError(
			expect.objectContaining({ code: 'VOICE_PROTOCOL_ERROR' }),
		);
	});

	test('encodes and decodes binary DAVE envelopes with their sequence number', async () => {
		const outgoing = encodeVoiceGatewayBinaryMessage(VoiceGatewayOpcode.DaveMlsKeyPackage, new Uint8Array([4, 5]));
		expect([...outgoing]).toEqual([VoiceGatewayOpcode.DaveMlsKeyPackage, 4, 5]);

		const incoming = await decodeVoiceGatewayMessage(
			new Uint8Array([0x12, 0x34, VoiceGatewayOpcode.DaveMlsWelcome, 8, 9]),
		);
		expect(incoming).toEqual({
			kind: 'binary',
			opcode: VoiceGatewayOpcode.DaveMlsWelcome,
			sequence: 0x1234,
			data: new Uint8Array([8, 9]),
		});
	});

	test('prefers AES-GCM and requires one current rtpsize mode', () => {
		expect(selectVoiceTransportEncryptionMode(['aead_xchacha20_poly1305_rtpsize', 'aead_aes256_gcm_rtpsize'])).toBe(
			'aead_aes256_gcm_rtpsize',
		);
		expect(selectVoiceTransportEncryptionMode(['aead_xchacha20_poly1305_rtpsize'])).toBe(
			'aead_xchacha20_poly1305_rtpsize',
		);
		expect(() => selectVoiceTransportEncryptionMode(['xsalsa20_poly1305'])).toThrowError(
			expect.objectContaining({ code: 'VOICE_PROTOCOL_ERROR' }),
		);
	});

	test('validates Session Description without exposing its secret in errors', () => {
		const description = parseVoiceGatewaySessionDescription(
			{
				mode: 'aead_xchacha20_poly1305_rtpsize',
				secret_key: Array.from({ length: 32 }, (_, index) => index),
				dave_protocol_version: 1,
			},
			'aead_xchacha20_poly1305_rtpsize',
			1,
		);
		expect(description.secretKey).toEqual(Uint8Array.from({ length: 32 }, (_, index) => index));

		let error: unknown;
		try {
			parseVoiceGatewaySessionDescription(
				{
					mode: 'aead_xchacha20_poly1305_rtpsize',
					secret_key: [251, 100, 11],
					dave_protocol_version: 1,
				},
				'aead_xchacha20_poly1305_rtpsize',
				1,
			);
		} catch (caught) {
			error = caught;
		}
		expect(error).toMatchObject({ code: 'VOICE_PROTOCOL_ERROR' });
		expect(JSON.stringify(error)).not.toContain('251');
	});

	test('maps participant SSRC and disconnect payloads', () => {
		expect(
			parseVoiceGatewaySpeaking({
				speaking: 3,
				ssrc: 42,
				user_id: '100000000000000001',
			}),
		).toEqual({ speaking: 3, ssrc: 42, userId: '100000000000000001' });
		expect(parseVoiceGatewayClientDisconnect({ user_id: '100000000000000001' })).toBe('100000000000000001');
	});

	test('builds and validates Discord IP Discovery packets', () => {
		const request = createVoiceIpDiscoveryRequest(0x1020_3040);
		const requestView = new DataView(request.buffer);
		expect(request).toHaveLength(74);
		expect(requestView.getUint16(0)).toBe(1);
		expect(requestView.getUint16(2)).toBe(70);
		expect(requestView.getUint32(4)).toBe(0x1020_3040);

		expect(parseVoiceIpDiscoveryResponse(createDiscoveryResponse(7, '203.0.113.10', 62_000), 7)).toEqual({
			address: '203.0.113.10',
			port: 62_000,
		});
		expect(() => parseVoiceIpDiscoveryResponse(createDiscoveryResponse(8, '203.0.113.10', 62_000), 7)).toThrowError(
			expect.objectContaining({ code: 'VOICE_PROTOCOL_ERROR' }),
		);
	});

	test('classifies only documented transient and fresh-server close paths as recoverable', () => {
		expect(classifyVoiceGatewayClose(4015)).toBe('resume');
		expect(classifyVoiceGatewayClose(1012)).toBe('resume');
		expect(classifyVoiceGatewayClose(1013)).toBe('resume');
		expect(classifyVoiceGatewayClose(4022)).toBe('terminal');
		expect(classifyVoiceGatewayClose(1002)).toBe('terminal');
		expect(classifyVoiceGatewayClose(4014)).toBe('terminal');
		expect(classifyVoiceGatewayClose(4999)).toBe('terminal');
	});
});
