import { VoiceError } from '../errors';

const IP_DISCOVERY_PACKET_SIZE = 74;
const IP_DISCOVERY_PAYLOAD_SIZE = 70;

export interface VoiceIpDiscoveryResult {
	readonly address: string;
	readonly port: number;
}

export function createVoiceIpDiscoveryRequest(ssrc: number): Uint8Array {
	assertUint32(ssrc, 'ssrc');
	const packet = new Uint8Array(IP_DISCOVERY_PACKET_SIZE);
	const view = new DataView(packet.buffer);
	view.setUint16(0, 1);
	view.setUint16(2, IP_DISCOVERY_PAYLOAD_SIZE);
	view.setUint32(4, ssrc);
	return packet;
}

export function parseVoiceIpDiscoveryResponse(data: Uint8Array, expectedSsrc: number): VoiceIpDiscoveryResult {
	assertUint32(expectedSsrc, 'expectedSsrc');
	if (data.byteLength !== IP_DISCOVERY_PACKET_SIZE) {
		throw protocolError('A Voice IP Discovery response must contain exactly 74 bytes.');
	}
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	if (view.getUint16(0) !== 2 || view.getUint16(2) !== IP_DISCOVERY_PAYLOAD_SIZE) {
		throw protocolError('The Voice IP Discovery response header is invalid.');
	}
	if (view.getUint32(4) !== expectedSsrc) {
		throw protocolError('The Voice IP Discovery response SSRC does not match the request.');
	}
	const addressBytes = data.subarray(8, 72);
	const terminator = addressBytes.indexOf(0);
	if (terminator <= 0) throw protocolError('The Voice IP Discovery response address is invalid.');
	const address = new TextDecoder('ascii', { fatal: true }).decode(addressBytes.subarray(0, terminator));
	if (!/^[0-9a-fA-F:.]+$/.test(address)) {
		throw protocolError('The Voice IP Discovery response address is invalid.');
	}
	const port = view.getUint16(72);
	if (port === 0) throw protocolError('The Voice IP Discovery response port is invalid.');
	return { address, port };
}

function assertUint32(value: number, field: string): void {
	if (Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff) return;
	throw new VoiceError('VOICE_INVALID_ARGUMENT', {
		metadata: { detail: `${field} must be an unsigned 32-bit integer.`, field },
	});
}

function protocolError(detail: string): VoiceError<'VOICE_PROTOCOL_ERROR'> {
	return new VoiceError('VOICE_PROTOCOL_ERROR', { metadata: { detail } });
}
