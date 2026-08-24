import { describe, expect, test, vi } from 'vitest';
import { VoiceCryptoProvider } from '../src/crypto/provider';
import type { DaveSession, DaveSessionCallbacks } from '../src/dave/types';
import type { VoiceReceivedPacket } from '../src/media/receiver';
import { VoiceRtpPacketizer } from '../src/media/rtp';
import type { RuntimeUdpSocket, RuntimeUdpSocketOptions, VoiceRuntimeAdapter } from '../src/runtime/types';
import type { VoiceTransportCallbacks } from '../src/transport';
import { VoiceGatewayOpcode } from '../src/voice-gateway/protocol';
import { VoiceGatewayTransport } from '../src/voice-gateway/session';

type FakeWebSocketEvent = { readonly data?: unknown; readonly code?: number };
type FakeWebSocketListener = (event: FakeWebSocketEvent) => void;

class FakeWebSocket {
	readyState = 0;
	binaryType: BinaryType = 'blob';
	readonly sent: Array<string | ArrayBuffer | ArrayBufferView> = [];
	readonly #listeners = new Map<string, FakeWebSocketListener[]>();

	addEventListener(type: string, listener: FakeWebSocketListener): void {
		const listeners = this.#listeners.get(type) ?? [];
		listeners.push(listener);
		this.#listeners.set(type, listeners);
	}

	send(data: string | ArrayBuffer | ArrayBufferView): void {
		if (this.readyState !== 1) throw new Error('Fake WebSocket is not open.');
		this.sent.push(data);
	}

	close(): void {
		this.readyState = 3;
	}

	open(): void {
		this.readyState = 1;
		this.dispatch('open', {});
	}

	message(payload: unknown): void {
		const data =
			typeof payload === 'string' || payload instanceof ArrayBuffer || ArrayBuffer.isView(payload)
				? payload
				: JSON.stringify(payload);
		this.dispatch('message', { data });
	}

	serverClose(code: number): void {
		this.readyState = 3;
		this.dispatch('close', { code });
	}

	private dispatch(type: string, event: FakeWebSocketEvent): void {
		for (const listener of this.#listeners.get(type) ?? []) listener(event);
	}
}

class FakeUdpSocket implements RuntimeUdpSocket {
	readonly sent: Uint8Array[] = [];
	readonly close = vi.fn(async () => {
		if (this.closeError) throw this.closeError;
	});

	constructor(
		readonly options: RuntimeUdpSocketOptions,
		private readonly closeError?: Error,
	) {}

	async send(data: Uint8Array): Promise<void> {
		this.sent.push(data.slice());
	}

	message(data: Uint8Array): void {
		this.options.onMessage(data);
	}
}

class FakeDaveSession implements DaveSession {
	readonly maxProtocolVersion = 0;
	ready = false;
	readonly handleJsonMessage = vi.fn();
	readonly handleBinaryMessage = vi.fn();
	readonly transformAudioFrame = vi.fn((frame: Uint8Array) => frame.slice());
	readonly receivedAudioFrames: Array<{ readonly userId: string; readonly frame: Uint8Array }> = [];
	readonly transformReceivedAudioFrame = vi.fn((userId: string, frame: Uint8Array) => {
		this.receivedAudioFrames.push({ userId, frame: frame.slice() });
		return frame.slice();
	});
	readonly getVerificationCode = vi.fn(async () => {
		throw new Error('DAVE is disabled in this fixture.');
	});
	readonly close = vi.fn();

	constructor(
		readonly callbacks: DaveSessionCallbacks,
		readyOnCreate = false,
	) {
		if (readyOnCreate) {
			this.ready = true;
			callbacks.onReady();
		}
	}

	setProtocolVersion(version: number): void {
		if (version !== 0) throw new Error('Unexpected DAVE version.');
		this.ready = true;
		this.callbacks.onReady();
	}
}

function createHarness(
	harnessOptions: {
		readonly daveReadyOnCreate?: boolean;
		readonly udpCloseError?: Error;
		readonly now?: () => number;
	} = {},
) {
	const webSockets: FakeWebSocket[] = [];
	const udpSockets: FakeUdpSocket[] = [];
	const daveSessions: FakeDaveSession[] = [];
	const audioPackets: VoiceReceivedPacket[] = [];
	const runtime: VoiceRuntimeAdapter = {
		createWebSocket() {
			const socket = new FakeWebSocket();
			webSockets.push(socket);
			return socket as unknown as WebSocket;
		},
		async createUdpSocket(options) {
			const socket = new FakeUdpSocket(options, harnessOptions.udpCloseError);
			udpSockets.push(socket);
			return socket;
		},
		now: harnessOptions.now ?? (() => 12_345),
		random: () => 0,
	};
	const callbacks: VoiceTransportCallbacks = {
		onRecovering: vi.fn(),
		onRecovered: vi.fn(),
		onNeedsServer: vi.fn(),
		onTerminalFailure: vi.fn(),
		onVoicePrivacyCodeChange: vi.fn(),
		onAudioPacket: vi.fn(packet => audioPackets.push({ ...packet, opus: packet.opus.slice() })),
	};
	const transport = new VoiceGatewayTransport(
		{
			guildId: '200000000000000001',
			channelId: '300000000000000001',
			userId: '100000000000000001',
			sessionId: 'session-one',
			token: 'token-one',
			endpoint: 'voice.example.test:443',
		},
		callbacks,
		runtime,
		(input, callbacks) => {
			expect(input).toEqual({ channelId: '300000000000000001', userId: '100000000000000001' });
			const session = new FakeDaveSession(callbacks, harnessOptions.daveReadyOnCreate);
			daveSessions.push(session);
			return session;
		},
	);
	return { audioPackets, callbacks, daveSessions, transport, udpSockets, webSockets };
}

function discoveryResponse(ssrc: number): Uint8Array {
	const packet = new Uint8Array(74);
	const view = new DataView(packet.buffer);
	view.setUint16(0, 2);
	view.setUint16(2, 70);
	view.setUint32(4, ssrc);
	packet.set(new TextEncoder().encode('203.0.113.5'), 8);
	view.setUint16(72, 62_000);
	return packet;
}

function jsonMessages(socket: FakeWebSocket): Array<{ op: number; d: Record<string, unknown> }> {
	return socket.sent
		.filter((message): message is string => typeof message === 'string')
		.map(message => JSON.parse(message) as { op: number; d: Record<string, unknown> });
}

async function flushWork(iterations = 12): Promise<void> {
	for (let index = 0; index < iterations; index++) await Promise.resolve();
}

async function completeHandshake(harness: ReturnType<typeof createHarness>): Promise<void> {
	const socket = harness.webSockets[0];
	socket.open();
	socket.message({ op: VoiceGatewayOpcode.Hello, d: { heartbeat_interval: 1_000 }, seq: 1 });
	socket.message({
		op: VoiceGatewayOpcode.Ready,
		d: {
			ssrc: 42,
			ip: '127.0.0.1',
			port: 50_000,
			modes: ['aead_xchacha20_poly1305_rtpsize', 'aead_aes256_gcm_rtpsize'],
		},
		seq: 2,
	});
	await flushWork();
	const udp = harness.udpSockets[0];
	expect(udp.sent).toHaveLength(1);
	udp.message(discoveryResponse(42));
	await flushWork();
	socket.message({
		op: VoiceGatewayOpcode.SessionDescription,
		d: {
			mode: 'aead_aes256_gcm_rtpsize',
			secret_key: Array.from({ length: 32 }, (_, index) => index),
			dave_protocol_version: 0,
		},
		seq: 3,
	});
	await harness.transport.ready;
}

describe('VoiceGatewayTransport', () => {
	test('sends paced encrypted RTP with speaking and clean silence termination', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		try {
			const harness = createHarness({ now: Date.now });
			await completeHandshake(harness);
			const source = {
				async *[Symbol.asyncIterator]() {
					yield Uint8Array.of(0xf8, 0xff, 0xfe);
				},
			};
			const playback = harness.transport.play(source);
			expect(() => harness.transport.play(source)).toThrowError(
				expect.objectContaining({ code: 'VOICE_OPERATION_CONFLICT' }),
			);
			await flushWork();
			expect(harness.udpSockets[0].sent).toHaveLength(2);
			expect(harness.udpSockets[0].sent[1].subarray(0, 2)).toEqual(Uint8Array.of(0x80, 0x78));
			expect(harness.daveSessions[0].transformAudioFrame).toHaveBeenCalledExactlyOnceWith(
				Uint8Array.of(0xf8, 0xff, 0xfe),
			);

			await vi.advanceTimersByTimeAsync(120);
			await playback.done;
			expect(harness.udpSockets[0].sent).toHaveLength(7);
			const speaking = jsonMessages(harness.webSockets[0]).filter(
				message => message.op === VoiceGatewayOpcode.Speaking,
			);
			expect(speaking).toEqual([
				{ op: VoiceGatewayOpcode.Speaking, d: { speaking: 1, delay: 0, ssrc: 42 } },
				{ op: VoiceGatewayOpcode.Speaking, d: { speaking: 0, delay: 0, ssrc: 42 } },
			]);
			await harness.transport.close();
		} finally {
			vi.useRealTimers();
		}
	});

	test('maps server speaking SSRCs and emits authenticated participant Opus packets', async () => {
		const harness = createHarness();
		await completeHandshake(harness);
		const socket = harness.webSockets[0];
		const udp = harness.udpSockets[0];
		const userId = '100000000000000002';
		socket.message({
			op: VoiceGatewayOpcode.Speaking,
			d: { speaking: 1, delay: 0, ssrc: 99, user_id: userId },
			seq: 4,
		});
		await flushWork();
		const packetizer = new VoiceRtpPacketizer({
			provider: new VoiceCryptoProvider(),
			mode: 'aead_aes256_gcm_rtpsize',
			secretKey: Uint8Array.from({ length: 32 }, (_, index) => index),
			ssrc: 99,
			random: () => 0,
		});
		const frame = Uint8Array.of(1, 2, 3);

		udp.message(packetizer.createPacket(frame, 960));
		expect(harness.daveSessions[0].receivedAudioFrames).toEqual([{ userId, frame }]);
		expect(harness.audioPackets).toEqual([
			{
				userId,
				opus: frame,
				sequence: 0,
				timestamp: 0,
				ssrc: 99,
			},
		]);

		const tampered = packetizer.createPacket(frame, 960);
		tampered[12] = (tampered[12] as number) ^ 1;
		udp.message(tampered);
		expect(harness.callbacks.onAudioPacket).toHaveBeenCalledTimes(1);
		socket.message({ op: VoiceGatewayOpcode.ClientDisconnect, d: { user_id: userId }, seq: 5 });
		await flushWork();
		udp.message(packetizer.createPacket(frame, 960));
		expect(harness.callbacks.onAudioPacket).toHaveBeenCalledTimes(1);

		packetizer.close();
		await harness.transport.close();
	});

	test('accepts a DAVE engine that reports readiness during construction', async () => {
		const harness = createHarness({ daveReadyOnCreate: true });

		await completeHandshake(harness);
		await expect(harness.transport.ready).resolves.toBeUndefined();
		await harness.transport.close();
	});

	test('routes DAVE binary messages before Session Description selects a protocol version', async () => {
		const harness = createHarness();
		const ready = harness.transport.ready.catch(() => undefined);
		const socket = harness.webSockets[0];
		socket.open();

		socket.message(Uint8Array.of(0, 9, VoiceGatewayOpcode.DaveMlsExternalSender, 1, 2, 3));
		await flushWork();

		expect(harness.daveSessions[0].handleBinaryMessage).toHaveBeenCalledExactlyOnceWith(
			VoiceGatewayOpcode.DaveMlsExternalSender,
			Uint8Array.of(1, 2, 3),
		);
		await harness.transport.close();
		await ready;
	});

	test('completes Identify, heartbeat setup, IP Discovery, and protocol selection before becoming ready', async () => {
		const harness = createHarness();
		const socket = harness.webSockets[0];
		socket.open();

		expect(jsonMessages(socket)[0]).toEqual({
			op: VoiceGatewayOpcode.Identify,
			d: {
				server_id: '200000000000000001',
				user_id: '100000000000000001',
				session_id: 'session-one',
				token: 'token-one',
				max_dave_protocol_version: 0,
			},
		});

		socket.message({
			op: VoiceGatewayOpcode.Ready,
			d: {
				ssrc: 42,
				ip: '127.0.0.1',
				port: 50_000,
				modes: ['aead_xchacha20_poly1305_rtpsize', 'aead_aes256_gcm_rtpsize'],
			},
			seq: 2,
		});
		await flushWork();
		const udp = harness.udpSockets[0];
		expect(udp.sent[0]).toHaveLength(74);
		udp.message(discoveryResponse(42));
		await flushWork();

		expect(jsonMessages(socket).at(-1)).toEqual({
			op: VoiceGatewayOpcode.SelectProtocol,
			d: {
				protocol: 'udp',
				data: { address: '203.0.113.5', port: 62_000, mode: 'aead_aes256_gcm_rtpsize' },
			},
		});

		let ready = false;
		void harness.transport.ready.then(() => {
			ready = true;
		});
		await flushWork();
		expect(ready).toBe(false);

		socket.message({
			op: VoiceGatewayOpcode.SessionDescription,
			d: {
				mode: 'aead_aes256_gcm_rtpsize',
				secret_key: Array.from({ length: 32 }, (_, index) => index),
				dave_protocol_version: 0,
			},
			seq: 3,
		});
		await harness.transport.ready;
		expect(ready).toBe(true);
		expect(harness.callbacks.onTerminalFailure).not.toHaveBeenCalled();
		await harness.transport.close();
	});

	test('heartbeats with the latest sequence and resumes a transient Voice Gateway loss', async () => {
		vi.useFakeTimers();
		try {
			const harness = createHarness();
			await completeHandshake(harness);
			const first = harness.webSockets[0];

			await vi.advanceTimersByTimeAsync(1_000);
			expect(jsonMessages(first).at(-1)).toEqual({
				op: VoiceGatewayOpcode.Heartbeat,
				d: { t: 12_345, seq_ack: 3 },
			});
			first.message({ op: VoiceGatewayOpcode.HeartbeatAck, d: { t: 12_345 } });
			await flushWork();

			first.serverClose(4015);
			expect(harness.callbacks.onRecovering).toHaveBeenCalledOnce();
			await vi.advanceTimersByTimeAsync(250);
			const resumed = harness.webSockets[1];
			resumed.open();
			expect(jsonMessages(resumed)[0]).toEqual({
				op: VoiceGatewayOpcode.Resume,
				d: {
					server_id: '200000000000000001',
					session_id: 'session-one',
					token: 'token-one',
					seq_ack: 3,
				},
			});
			resumed.message({ op: VoiceGatewayOpcode.Hello, d: { heartbeat_interval: 1_000 } });
			resumed.message({ op: VoiceGatewayOpcode.Resumed, d: null, seq: 4 });
			await flushWork();
			expect(harness.callbacks.onRecovered).toHaveBeenCalledOnce();
			await harness.transport.close();
		} finally {
			vi.useRealTimers();
		}
	});

	test('treats a terminated voice call as terminal', async () => {
		vi.useFakeTimers();
		try {
			const harness = createHarness();
			await completeHandshake(harness);

			harness.webSockets[0].serverClose(4022);
			expect(harness.callbacks.onRecovering).not.toHaveBeenCalled();
			expect(harness.callbacks.onNeedsServer).not.toHaveBeenCalled();
			expect(harness.callbacks.onTerminalFailure).toHaveBeenCalledWith(
				expect.objectContaining({
					code: 'VOICE_CONNECTION_FAILED',
					metadata: expect.objectContaining({ closeCode: 4022 }),
				}),
			);
			await harness.transport.close();
		} finally {
			vi.useRealTimers();
		}
	});

	test('turns a detached UDP close failure into a terminal transport failure', async () => {
		const closeError = new Error('UDP close failed');
		const harness = createHarness({ udpCloseError: closeError });
		await completeHandshake(harness);

		harness.webSockets[0].serverClose(4011);
		await flushWork();

		expect(harness.callbacks.onTerminalFailure).toHaveBeenCalledWith(
			expect.objectContaining({
				code: 'VOICE_CONNECTION_FAILED',
				cause: closeError,
				metadata: expect.objectContaining({ reason: 'udp-close-failed' }),
			}),
		);
		await harness.transport.close();
	});

	test('treats unknown application close codes as terminal', async () => {
		const harness = createHarness();
		await completeHandshake(harness);

		harness.webSockets[0].serverClose(4999);
		expect(harness.callbacks.onTerminalFailure).toHaveBeenCalledWith(
			expect.objectContaining({
				code: 'VOICE_CONNECTION_FAILED',
				metadata: expect.objectContaining({ closeCode: 4999 }),
			}),
		);
		expect(harness.callbacks.onNeedsServer).not.toHaveBeenCalled();
		await harness.transport.close();
	});
});
