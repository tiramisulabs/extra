import { VoiceError } from '../errors';

export const VoiceGatewayOpcode = Object.freeze({
	Identify: 0,
	SelectProtocol: 1,
	Ready: 2,
	Heartbeat: 3,
	SessionDescription: 4,
	Speaking: 5,
	HeartbeatAck: 6,
	Resume: 7,
	Hello: 8,
	Resumed: 9,
	ClientsConnect: 11,
	ClientDisconnect: 13,
	DavePrepareTransition: 21,
	DaveExecuteTransition: 22,
	DaveTransitionReady: 23,
	DavePrepareEpoch: 24,
	DaveMlsExternalSender: 25,
	DaveMlsKeyPackage: 26,
	DaveMlsProposals: 27,
	DaveMlsCommitWelcome: 28,
	DaveMlsAnnounceCommitTransition: 29,
	DaveMlsWelcome: 30,
	DaveMlsInvalidCommitWelcome: 31,
} as const);

export type VoiceTransportEncryptionMode = 'aead_aes256_gcm_rtpsize' | 'aead_xchacha20_poly1305_rtpsize';

export interface VoiceGatewayJsonMessage {
	readonly kind: 'json';
	readonly opcode: number;
	readonly data: unknown;
	readonly sequence: number | undefined;
}

export interface VoiceGatewayBinaryMessage {
	readonly kind: 'binary';
	readonly opcode: number;
	readonly data: Uint8Array;
	readonly sequence: number;
}

export type VoiceGatewayMessage = VoiceGatewayJsonMessage | VoiceGatewayBinaryMessage;

export interface VoiceGatewayReadyData {
	readonly ssrc: number;
	readonly ip: string;
	readonly port: number;
	readonly modes: readonly string[];
}

export interface VoiceGatewaySessionDescription {
	readonly mode: VoiceTransportEncryptionMode;
	readonly secretKey: Uint8Array;
	readonly daveProtocolVersion: number;
}

export interface VoiceGatewaySpeakingData {
	readonly speaking: number;
	readonly ssrc: number;
	readonly userId: string;
}

interface VoiceGatewayJsonPayload {
	readonly op: number;
	readonly d: unknown;
	readonly seq?: number;
}

interface VoiceGatewayHelloPayload {
	readonly heartbeat_interval: number;
}

interface VoiceGatewaySessionDescriptionPayload {
	readonly mode: string;
	readonly secret_key: readonly number[];
	readonly dave_protocol_version: number;
}

interface VoiceGatewaySpeakingPayload {
	readonly speaking: number;
	readonly ssrc: number;
	readonly user_id: string;
}

export function createVoiceGatewayUrl(endpoint: string): string {
	let url: URL;
	try {
		url = new URL(endpoint.includes('://') ? endpoint : `wss://${endpoint}`);
	} catch (cause) {
		throw new VoiceError('VOICE_PROTOCOL_ERROR', {
			cause,
			metadata: { detail: 'Discord returned an invalid Voice Gateway endpoint.', reason: 'invalid-endpoint' },
		});
	}

	if (url.protocol !== 'wss:' || !url.hostname || url.username || url.password) {
		throw new VoiceError('VOICE_PROTOCOL_ERROR', {
			metadata: { detail: 'Discord returned an invalid Voice Gateway endpoint.', reason: 'invalid-endpoint' },
		});
	}
	url.pathname = '/';
	url.search = '';
	url.searchParams.set('v', '8');
	url.hash = '';
	return url.toString();
}

export async function decodeVoiceGatewayMessage(value: unknown): Promise<VoiceGatewayMessage> {
	if (typeof value === 'string') return decodeJsonMessage(value);
	const data = await toBinaryData(value);
	if (data.byteLength < 3) {
		throw protocolError('A binary Voice Gateway message must contain a sequence number and opcode.');
	}
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	return {
		kind: 'binary',
		sequence: view.getUint16(0),
		opcode: view.getUint8(2),
		data: data.subarray(3),
	};
}

export function encodeVoiceGatewayBinaryMessage(opcode: number, data: Uint8Array): Uint8Array<ArrayBuffer> {
	assertOpcode(opcode);
	const message = new Uint8Array(data.byteLength + 1);
	message[0] = opcode;
	message.set(data, 1);
	return message;
}

export function parseVoiceGatewayHello(data: unknown): number {
	return (data as VoiceGatewayHelloPayload).heartbeat_interval;
}

export function parseVoiceGatewayReady(data: unknown): VoiceGatewayReadyData {
	return data as VoiceGatewayReadyData;
}

export function parseVoiceGatewaySpeaking(data: unknown): VoiceGatewaySpeakingData {
	const payload = data as VoiceGatewaySpeakingPayload;
	// Discord's server form adds user_id and currently omits the client-only delay field.
	return {
		speaking: payload.speaking,
		ssrc: payload.ssrc,
		userId: payload.user_id,
	};
}

export function parseVoiceGatewayClientDisconnect(data: unknown): string {
	return (data as { readonly user_id: string }).user_id;
}

export function selectVoiceTransportEncryptionMode(modes: readonly string[]): VoiceTransportEncryptionMode {
	if (modes.includes('aead_aes256_gcm_rtpsize')) return 'aead_aes256_gcm_rtpsize';
	if (modes.includes('aead_xchacha20_poly1305_rtpsize')) return 'aead_xchacha20_poly1305_rtpsize';
	throw new VoiceError('VOICE_PROTOCOL_ERROR', {
		metadata: {
			detail: 'The Voice Gateway did not offer a supported transport encryption mode.',
			reason: 'unsupported-transport-encryption',
		},
	});
}

export function parseVoiceGatewaySessionDescription(
	data: unknown,
	selectedMode: VoiceTransportEncryptionMode,
	maxDaveProtocolVersion: number,
): VoiceGatewaySessionDescription {
	const payload = data as VoiceGatewaySessionDescriptionPayload;
	if (payload.mode !== selectedMode) {
		throw protocolError('The Voice Gateway confirmed a transport encryption mode that was not selected.');
	}
	if (payload.secret_key.length !== 32) {
		throw protocolError('Voice Gateway Session Description secret_key must contain exactly 32 bytes.');
	}
	if (payload.dave_protocol_version > maxDaveProtocolVersion) {
		throw new VoiceError('VOICE_PROTOCOL_ERROR', {
			metadata: {
				detail: 'The Voice Gateway selected an unsupported DAVE protocol version.',
				reason: 'unsupported-dave-version',
				daveProtocolVersion: payload.dave_protocol_version,
				maxDaveProtocolVersion,
			},
		});
	}
	return {
		mode: selectedMode,
		secretKey: Uint8Array.from(payload.secret_key),
		daveProtocolVersion: payload.dave_protocol_version,
	};
}

export function readHeartbeatNonce(data: unknown): number {
	return (data as { readonly t: number }).t;
}

export function classifyVoiceGatewayClose(code: number): 'resume' | 'fresh-server' | 'terminal' {
	if ([1000, 1001, 1005, 1006, 1011, 1012, 1013, 1014, 1015, 4015].includes(code)) return 'resume';
	if (code === 4006 || code === 4009 || code === 4011) return 'fresh-server';
	return 'terminal';
}

function decodeJsonMessage(value: string): VoiceGatewayJsonMessage {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch (cause) {
		throw new VoiceError('VOICE_PROTOCOL_ERROR', {
			cause,
			metadata: { detail: 'The Voice Gateway sent invalid JSON.', reason: 'invalid-json' },
		});
	}
	const payload = parsed as VoiceGatewayJsonPayload;
	return { kind: 'json', opcode: payload.op, data: payload.d, sequence: payload.seq };
}

async function toBinaryData(value: unknown): Promise<Uint8Array> {
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	if (typeof Blob !== 'undefined' && value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
	throw protocolError('The Voice Gateway sent a message with an unsupported representation.');
}

function assertOpcode(value: number): void {
	if (Number.isInteger(value) && value >= 0 && value <= 0xff) return;
	throw new VoiceError('VOICE_INVALID_ARGUMENT', {
		metadata: { detail: 'A Voice Gateway opcode must be an unsigned 8-bit integer.', field: 'opcode' },
	});
}

function protocolError(detail: string): VoiceError<'VOICE_PROTOCOL_ERROR'> {
	return new VoiceError('VOICE_PROTOCOL_ERROR', { metadata: { detail } });
}
