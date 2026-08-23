import { equalBytes } from '../bytes';
import { VoiceCryptoProvider } from '../crypto/provider';
import type { DaveSession, DaveSessionFactory, DaveSessionFactoryResource } from '../dave/types';
import { VoiceError } from '../errors';
import type { VoicePlayback, VoicePlaybackSource } from '../media/playback';
import { VoiceRtpDepacketizer, type VoiceRtpPacket, VoiceRtpPacketizer } from '../media/rtp';
import { VoiceAudioTransmission } from '../media/transmission';
import { unrefTimer } from '../runtime/adapter';
import type { RuntimeUdpSocket, VoiceRuntimeAdapter } from '../runtime/types';
import type {
	VoiceTransportCallbacks,
	VoiceTransportFactory,
	VoiceTransportInput,
	VoiceTransportSession,
} from '../transport';
import {
	createVoiceIpDiscoveryRequest,
	parseVoiceIpDiscoveryResponse,
	type VoiceIpDiscoveryResult,
} from './ip-discovery';
import {
	classifyVoiceGatewayClose,
	createVoiceGatewayUrl,
	decodeVoiceGatewayMessage,
	encodeVoiceGatewayBinaryMessage,
	parseVoiceGatewayClientDisconnect,
	parseVoiceGatewayHello,
	parseVoiceGatewayReady,
	parseVoiceGatewaySessionDescription,
	parseVoiceGatewaySpeaking,
	readHeartbeatNonce,
	selectVoiceTransportEncryptionMode,
	type VoiceGatewayMessage,
	VoiceGatewayOpcode,
	type VoiceGatewayReadyData,
	type VoiceGatewaySpeakingData,
	type VoiceTransportEncryptionMode,
} from './protocol';

const IP_DISCOVERY_TIMEOUT_MS = 5_000;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 30_000;

interface PendingDiscovery {
	readonly ssrc: number;
	readonly generation: number;
	readonly deferred: PromiseWithResolvers<VoiceIpDiscoveryResult>;
	readonly timer: ReturnType<typeof setTimeout>;
}

/** @internal */
export function createVoiceGatewayTransportFactory(
	runtime: VoiceRuntimeAdapter,
	createDaveSession: DaveSessionFactoryResource,
): VoiceTransportFactory {
	const factory: VoiceTransportFactory = (input, callbacks) =>
		new VoiceGatewayTransport(input, callbacks, runtime, createDaveSession);
	factory.retainResourcesForReplacement = () => createDaveSession.retain();
	return factory;
}

/** @internal */
export class VoiceGatewayTransport implements VoiceTransportSession {
	readonly ready: Promise<void>;
	readonly #readyDeferred = Promise.withResolvers<void>();
	readonly #input: VoiceTransportInput;
	readonly #callbacks: VoiceTransportCallbacks;
	readonly #runtime: VoiceRuntimeAdapter;
	readonly #provider = new VoiceCryptoProvider();
	readonly #gatewayUrl: string;
	readonly #dave: DaveSession;
	#webSocket?: WebSocket;
	#webSocketGeneration = 0;
	#udpSocket?: RuntimeUdpSocket;
	#udpGeneration = 0;
	#pendingDiscovery?: PendingDiscovery;
	#heartbeatTimer?: ReturnType<typeof setTimeout>;
	#heartbeatAwaitingAck = false;
	#lastHeartbeatNonce?: number;
	#lastSequence = -1;
	#selectedMode?: VoiceTransportEncryptionMode;
	#secretKey?: Uint8Array;
	#ssrc?: number;
	#packetizer?: VoiceRtpPacketizer;
	#depacketizer?: VoiceRtpDepacketizer;
	#packetizerMode?: VoiceTransportEncryptionMode;
	#packetizerSsrc?: number;
	readonly #userBySsrc = new Map<number, string>();
	readonly #ssrcByUser = new Map<string, number>();
	#sessionDaveProtocolVersion?: number;
	#transmission?: VoiceAudioTransmission;
	#messageTail = Promise.resolve();
	#retryTimer?: ReturnType<typeof setTimeout>;
	#retryAttempt = 0;
	#waitingForFreshServer = false;
	#networkReady = false;
	#hasBeenReady = false;
	#recovering = false;
	#readySettled = false;
	#closed = false;
	#terminalNotified = false;
	#closePromise?: Promise<void>;

	constructor(
		input: VoiceTransportInput,
		callbacks: VoiceTransportCallbacks,
		runtime: VoiceRuntimeAdapter,
		createDaveSession: DaveSessionFactory,
	) {
		this.#input = input;
		this.#callbacks = callbacks;
		this.#runtime = runtime;
		this.#gatewayUrl = createVoiceGatewayUrl(input.endpoint);
		this.ready = this.#readyDeferred.promise;
		let readyDuringInitialization = false;
		let initializing = true;
		this.#dave = createDaveSession(
			{ channelId: input.channelId, userId: input.userId },
			{
				sendJson: (opcode, data) => this.sendJson(opcode, data),
				sendBinary: (opcode, data) => this.sendBinary(opcode, data),
				onReady: () => {
					if (initializing) readyDuringInitialization = true;
					else this.handleDaveReady();
				},
				onRecovering: () => this.enterRecovery(),
				onVoicePrivacyCodeChange: code => this.#callbacks.onVoicePrivacyCodeChange(code),
			},
		);
		initializing = false;
		if (
			!Number.isInteger(this.#dave.maxProtocolVersion) ||
			this.#dave.maxProtocolVersion < 0 ||
			this.#dave.maxProtocolVersion > 1
		) {
			throw new VoiceError('VOICE_PROTOCOL_ERROR', {
				metadata: {
					detail: 'The DAVE Engine maximum protocol version must be 0 or 1.',
					reason: 'invalid-dave-capability',
				},
			});
		}
		if (readyDuringInitialization) this.handleDaveReady();
		this.openWebSocket(false);
	}

	getVerificationCode(userId: string): Promise<string> {
		return this.#dave.getVerificationCode(userId);
	}

	play(source: VoicePlaybackSource): VoicePlayback {
		if (
			this.#closed ||
			this.#recovering ||
			!this.#networkReady ||
			!this.#dave.ready ||
			!this.#udpSocket ||
			!this.#packetizer
		) {
			throw playbackError(this.#input.guildId, 'transport-not-ready');
		}
		if (this.#transmission) {
			throw new VoiceError('VOICE_OPERATION_CONFLICT', {
				metadata: { guildId: this.#input.guildId, operation: 'play', activeOperation: 'play' },
			});
		}
		const transmission = new VoiceAudioTransmission(source, {
			now: () => this.#runtime.now(),
			setSpeaking: speaking => this.setSpeaking(speaking),
			sendFrame: (frame, samples) => this.sendAudioFrame(frame, samples),
			advanceTimestamp: samples => this.#packetizer?.advanceTimestamp(samples),
		});
		this.#transmission = transmission;
		void transmission.playback.done.then(
			() => this.clearTransmission(transmission),
			() => this.clearTransmission(transmission),
		);
		return transmission.playback;
	}

	abortPlayback(error: VoiceError): void {
		this.abortTransmission(error);
	}

	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#closed = true;
		this.abortTransmission(transportClosedError(this.#input.guildId));
		if (!this.#readySettled) {
			this.#readySettled = true;
			this.#readyDeferred.reject(
				new VoiceError('VOICE_CONNECTION_DESTROYED', {
					metadata: { guildId: this.#input.guildId, reason: 'transport-closed' },
				}),
			);
		}
		this.#closePromise = this.closeResources();
		return this.#closePromise;
	}

	private openWebSocket(resume: boolean): void {
		if (this.#closed || this.#waitingForFreshServer) return;
		this.clearRetryTimer();

		let socket: WebSocket;
		try {
			socket = this.#runtime.createWebSocket(this.#gatewayUrl);
			socket.binaryType = 'arraybuffer';
		} catch (error) {
			this.scheduleWebSocketRetry(resume, error);
			return;
		}

		const generation = ++this.#webSocketGeneration;
		this.#webSocket = socket;
		socket.addEventListener('open', () => {
			if (!this.isCurrentWebSocket(socket, generation)) return;
			try {
				if (resume) this.sendResume();
				else this.sendIdentify();
			} catch (error) {
				this.handleTransientWebSocketFailure(socket, generation, error);
			}
		});
		socket.addEventListener('message', event => {
			if (!this.isCurrentWebSocket(socket, generation)) return;
			this.enqueueMessage(event.data, socket, generation);
		});
		socket.addEventListener('error', event => {
			this.handleTransientWebSocketFailure(socket, generation, event);
		});
		socket.addEventListener('close', event => {
			this.handleWebSocketClose(socket, generation, event.code);
		});
	}

	private sendIdentify(): void {
		this.sendJson(VoiceGatewayOpcode.Identify, {
			server_id: this.#input.guildId,
			user_id: this.#input.userId,
			session_id: this.#input.sessionId,
			token: this.#input.token,
			max_dave_protocol_version: this.#dave.maxProtocolVersion,
		});
	}

	private sendResume(): void {
		this.sendJson(VoiceGatewayOpcode.Resume, {
			server_id: this.#input.guildId,
			session_id: this.#input.sessionId,
			token: this.#input.token,
			seq_ack: this.#lastSequence,
		});
	}

	private sendJson(opcode: number, data: unknown): void {
		const socket = this.requireOpenWebSocket();
		socket.send(JSON.stringify({ op: opcode, d: data }));
	}

	private sendBinary(opcode: number, data: Uint8Array): void {
		this.requireOpenWebSocket().send(encodeVoiceGatewayBinaryMessage(opcode, data));
	}

	private requireOpenWebSocket(): WebSocket {
		const socket = this.#webSocket;
		if (!socket || socket.readyState !== 1) {
			throw new VoiceError('VOICE_CONNECTION_FAILED', {
				metadata: { guildId: this.#input.guildId, reason: 'voice-websocket-unavailable' },
			});
		}
		return socket;
	}

	private enqueueMessage(value: unknown, socket: WebSocket, generation: number): void {
		this.#messageTail = this.#messageTail.then(async () => {
			if (!this.isCurrentWebSocket(socket, generation)) return;
			const message = await decodeVoiceGatewayMessage(value);
			if (!this.isCurrentWebSocket(socket, generation)) return;
			await this.handleMessage(message, socket, generation);
		});
		this.#messageTail = this.#messageTail.catch(error => this.failTerminal(toProtocolError(error)));
	}

	private async handleMessage(message: VoiceGatewayMessage, socket: WebSocket, generation: number): Promise<void> {
		this.#lastSequence = message.sequence ?? this.#lastSequence;
		if (message.kind === 'binary') {
			if (!isDaveBinaryOpcode(message.opcode)) {
				throw new VoiceError('VOICE_PROTOCOL_ERROR', {
					metadata: {
						detail: 'The Voice Gateway sent an unknown binary opcode.',
						opcode: message.opcode,
					},
				});
			}
			await this.#dave.handleBinaryMessage(message.opcode, message.data);
			return;
		}

		switch (message.opcode) {
			case VoiceGatewayOpcode.Hello:
				this.startHeartbeat(parseVoiceGatewayHello(message.data), socket, generation);
				break;
			case VoiceGatewayOpcode.Ready:
				await this.handleReady(parseVoiceGatewayReady(message.data), socket, generation);
				break;
			case VoiceGatewayOpcode.SessionDescription:
				await this.handleSessionDescription(message.data);
				break;
			case VoiceGatewayOpcode.HeartbeatAck:
				this.handleHeartbeatAck(readHeartbeatNonce(message.data));
				break;
			case VoiceGatewayOpcode.Resumed:
				this.handleResumed();
				break;
			case VoiceGatewayOpcode.Speaking:
				this.handleSpeaking(parseVoiceGatewaySpeaking(message.data));
				break;
			case VoiceGatewayOpcode.ClientsConnect:
			case VoiceGatewayOpcode.DavePrepareTransition:
			case VoiceGatewayOpcode.DaveExecuteTransition:
			case VoiceGatewayOpcode.DavePrepareEpoch:
				await this.#dave.handleJsonMessage(message.opcode, message.data);
				break;
			case VoiceGatewayOpcode.ClientDisconnect:
				this.removeParticipantSsrc(parseVoiceGatewayClientDisconnect(message.data));
				await this.#dave.handleJsonMessage(message.opcode, message.data);
				break;
			default:
				break;
		}
	}

	private startHeartbeat(intervalMs: number, socket: WebSocket, generation: number): void {
		if (intervalMs > 2_147_483_647) {
			throw new VoiceError('VOICE_PROTOCOL_ERROR', {
				metadata: { detail: 'The Voice Gateway heartbeat interval exceeds the runtime timer limit.' },
			});
		}
		this.clearHeartbeat();
		const heartbeat = () => {
			if (!this.isCurrentWebSocket(socket, generation)) return;
			if (this.#heartbeatAwaitingAck) {
				this.handleTransientWebSocketFailure(
					socket,
					generation,
					new VoiceError('VOICE_CONNECTION_FAILED', {
						metadata: { guildId: this.#input.guildId, reason: 'heartbeat-ack-timeout' },
					}),
				);
				return;
			}
			const nonce = this.#runtime.now();
			try {
				this.sendJson(VoiceGatewayOpcode.Heartbeat, { t: nonce, seq_ack: this.#lastSequence });
			} catch (error) {
				this.handleTransientWebSocketFailure(socket, generation, error);
				return;
			}
			this.#lastHeartbeatNonce = nonce;
			this.#heartbeatAwaitingAck = true;
			this.#heartbeatTimer = setTimeout(heartbeat, intervalMs);
			unrefTimer(this.#heartbeatTimer);
		};
		this.#heartbeatTimer = setTimeout(heartbeat, intervalMs);
		unrefTimer(this.#heartbeatTimer);
	}

	private handleHeartbeatAck(nonce: number): void {
		if (nonce !== this.#lastHeartbeatNonce) return;
		this.#heartbeatAwaitingAck = false;
	}

	private async handleReady(
		data: VoiceGatewayReadyData,
		socket: WebSocket,
		webSocketGeneration: number,
	): Promise<void> {
		this.clearParticipantSsrcs();
		const mode = selectVoiceTransportEncryptionMode(data.modes);
		let discovery: VoiceIpDiscoveryResult;
		try {
			discovery = await this.openUdpAndDiscover(data);
		} catch (error) {
			if (VoiceError.is(error, 'VOICE_PROTOCOL_ERROR')) throw error;
			this.handleTransientWebSocketFailure(socket, webSocketGeneration, error);
			return;
		}
		if (!this.isCurrentWebSocket(socket, webSocketGeneration)) return;
		this.#selectedMode = mode;
		this.#ssrc = data.ssrc;
		this.sendJson(VoiceGatewayOpcode.SelectProtocol, {
			protocol: 'udp',
			data: { address: discovery.address, port: discovery.port, mode },
		});
	}

	private async openUdpAndDiscover(data: VoiceGatewayReadyData): Promise<VoiceIpDiscoveryResult> {
		const generation = ++this.#udpGeneration;
		const previous = this.#udpSocket;
		this.#udpSocket = undefined;
		this.rejectPendingDiscovery(
			new VoiceError('VOICE_CONNECTION_FAILED', {
				metadata: { guildId: this.#input.guildId, reason: 'ip-discovery-replaced' },
			}),
		);
		await previous?.close();
		if (!this.isCurrentUdpGeneration(generation)) throw transportClosedError(this.#input.guildId);

		const socket = await this.#runtime.createUdpSocket({
			remoteAddress: data.ip,
			remotePort: data.port,
			onMessage: packet => this.handleUdpMessage(generation, packet),
			onError: error => this.handleUdpFailure(generation, error),
			onClose: () => this.handleUdpClose(generation),
		});
		if (!this.isCurrentUdpGeneration(generation)) {
			await socket.close();
			throw transportClosedError(this.#input.guildId);
		}
		this.#udpSocket = socket;

		const deferred = Promise.withResolvers<VoiceIpDiscoveryResult>();
		const timer = setTimeout(() => {
			deferred.reject(
				new VoiceError('VOICE_CONNECTION_FAILED', {
					metadata: { guildId: this.#input.guildId, reason: 'ip-discovery-timeout' },
				}),
			);
		}, IP_DISCOVERY_TIMEOUT_MS);
		unrefTimer(timer);
		this.#pendingDiscovery = { ssrc: data.ssrc, generation, deferred, timer };
		try {
			await socket.send(createVoiceIpDiscoveryRequest(data.ssrc));
			return await deferred.promise;
		} finally {
			if (this.#pendingDiscovery?.deferred === deferred) this.#pendingDiscovery = undefined;
			clearTimeout(timer);
		}
	}

	private handleUdpMessage(generation: number, packet: Uint8Array): void {
		if (!this.isCurrentUdpGeneration(generation)) return;
		const pending = this.#pendingDiscovery;
		if (pending?.generation === generation) {
			try {
				pending.deferred.resolve(parseVoiceIpDiscoveryResponse(packet, pending.ssrc));
			} catch (error) {
				pending.deferred.reject(error);
			}
			return;
		}
		if (!this.#networkReady || this.#recovering) return;
		const depacketizer = this.#depacketizer;
		if (!depacketizer) return;
		let rtp: VoiceRtpPacket | undefined;
		let opus: Uint8Array | undefined;
		try {
			rtp = depacketizer.openPacket(packet);
			const userId = this.#userBySsrc.get(rtp.ssrc);
			if (!userId) return;
			opus = this.#dave.transformReceivedAudioFrame(userId, rtp.opus);
			if (!opus) return;
			this.#callbacks.onAudioPacket({
				userId,
				opus,
				sequence: rtp.sequence,
				timestamp: rtp.timestamp,
				ssrc: rtp.ssrc,
			});
		} catch {
			// UDP media is untrusted and lossy; invalid/authentication-failed packets are dropped individually.
		} finally {
			rtp?.opus.fill(0);
			opus?.fill(0);
		}
	}

	private handleSpeaking(data: VoiceGatewaySpeakingData): void {
		const previousUser = this.#userBySsrc.get(data.ssrc);
		if (previousUser && previousUser !== data.userId) this.#ssrcByUser.delete(previousUser);
		const previousSsrc = this.#ssrcByUser.get(data.userId);
		if (previousSsrc !== undefined && previousSsrc !== data.ssrc) this.#userBySsrc.delete(previousSsrc);
		this.#userBySsrc.set(data.ssrc, data.userId);
		this.#ssrcByUser.set(data.userId, data.ssrc);
	}

	private removeParticipantSsrc(userId: string): void {
		const ssrc = this.#ssrcByUser.get(userId);
		if (ssrc === undefined) return;
		this.#ssrcByUser.delete(userId);
		this.#userBySsrc.delete(ssrc);
	}

	private clearParticipantSsrcs(): void {
		this.#ssrcByUser.clear();
		this.#userBySsrc.clear();
	}

	private handleUdpFailure(generation: number, error: unknown): void {
		if (!this.isCurrentUdpGeneration(generation)) return;
		const connectionError = toConnectionError(error, this.#input.guildId, 'udp-error');
		if (this.#pendingDiscovery?.generation === generation) {
			this.#pendingDiscovery.deferred.reject(connectionError);
			return;
		}
		if (this.#hasBeenReady) this.waitForFreshServer();
		else this.restartInitialConnection(connectionError);
	}

	private handleUdpClose(generation: number): void {
		if (!this.isCurrentUdpGeneration(generation) || this.#closed) return;
		this.handleUdpFailure(
			generation,
			new VoiceError('VOICE_CONNECTION_FAILED', {
				metadata: { guildId: this.#input.guildId, reason: 'udp-closed' },
			}),
		);
	}

	private async handleSessionDescription(data: unknown): Promise<void> {
		const selectedMode = this.#selectedMode;
		if (!selectedMode) {
			throw new VoiceError('VOICE_PROTOCOL_ERROR', {
				metadata: { detail: 'The Voice Gateway sent a Session Description before protocol selection.' },
			});
		}
		const description = parseVoiceGatewaySessionDescription(data, selectedMode, this.#dave.maxProtocolVersion);
		const transportContextChanged = this.replaceSecretKey(description.secretKey, selectedMode);
		if (transportContextChanged || this.#sessionDaveProtocolVersion !== description.daveProtocolVersion) {
			await this.#dave.setProtocolVersion(description.daveProtocolVersion);
			this.#sessionDaveProtocolVersion = description.daveProtocolVersion;
		}
		this.#networkReady = true;
		this.maybeBecomeOperational();
	}

	private handleResumed(): void {
		this.#retryAttempt = 0;
		this.#networkReady = true;
		this.maybeBecomeOperational();
	}

	private handleDaveReady(): void {
		this.maybeBecomeOperational();
	}

	private maybeBecomeOperational(): void {
		if (this.#closed || !this.#networkReady || !this.#dave.ready || !this.#secretKey || !this.#packetizer) return;
		this.#retryAttempt = 0;
		if (!this.#hasBeenReady) {
			this.#hasBeenReady = true;
			this.#recovering = false;
			if (!this.#readySettled) {
				this.#readySettled = true;
				this.#readyDeferred.resolve();
			}
			return;
		}
		if (this.#recovering) {
			this.#recovering = false;
			this.#callbacks.onRecovered();
		}
	}

	private handleTransientWebSocketFailure(socket: WebSocket, generation: number, error: unknown): void {
		if (!this.isCurrentWebSocket(socket, generation)) return;
		this.invalidateWebSocket(socket);
		this.scheduleWebSocketRetry(this.#hasBeenReady, error);
	}

	private handleWebSocketClose(socket: WebSocket, generation: number, code: number): void {
		if (!this.isCurrentWebSocket(socket, generation)) return;
		this.#webSocket = undefined;
		++this.#webSocketGeneration;
		this.clearHeartbeat();
		if (this.#closed) return;

		switch (classifyVoiceGatewayClose(code)) {
			case 'resume':
				this.scheduleWebSocketRetry(this.#hasBeenReady, { code });
				break;
			case 'fresh-server':
				this.waitForFreshServer();
				break;
			case 'terminal':
				this.failTerminal(
					new VoiceError('VOICE_CONNECTION_FAILED', {
						metadata: { guildId: this.#input.guildId, reason: 'voice-gateway-close', closeCode: code },
					}),
				);
				break;
		}
	}

	private scheduleWebSocketRetry(resume: boolean, _cause: unknown): void {
		if (this.#closed || this.#waitingForFreshServer || this.#retryTimer) return;
		this.#networkReady = false;
		if (this.#hasBeenReady) this.enterRecovery();
		else this.closeUdpDetached();
		const delay = this.nextRetryDelay();
		this.#retryTimer = setTimeout(() => {
			this.#retryTimer = undefined;
			this.openWebSocket(resume && this.#hasBeenReady);
		}, delay);
		unrefTimer(this.#retryTimer);
	}

	private restartInitialConnection(_cause: unknown): void {
		if (this.#closed) return;
		this.#networkReady = false;
		const socket = this.#webSocket;
		if (socket) this.invalidateWebSocket(socket);
		this.closeUdpDetached();
		this.scheduleWebSocketRetry(false, _cause);
	}

	private waitForFreshServer(): void {
		if (this.#closed) return;
		if (!this.#waitingForFreshServer) {
			this.#waitingForFreshServer = true;
			this.#networkReady = false;
			this.enterRecovery();
			this.clearRetryTimer();
			const socket = this.#webSocket;
			if (socket) this.invalidateWebSocket(socket);
			this.closeUdpDetached();
			this.replaceSecretKey(undefined);
		}
		this.requestFreshServer();
	}

	private requestFreshServer(): void {
		if (this.#closed || !this.#waitingForFreshServer || this.#retryTimer) return;
		try {
			this.#callbacks.onNeedsServer();
		} catch (error) {
			this.failTerminal(toConnectionError(error, this.#input.guildId, 'fresh-server-request-failed'));
			return;
		}
		const delay = this.nextRetryDelay();
		this.#retryTimer = setTimeout(() => {
			this.#retryTimer = undefined;
			this.requestFreshServer();
		}, delay);
		unrefTimer(this.#retryTimer);
	}

	private enterRecovery(): void {
		if (!this.#hasBeenReady || this.#recovering || this.#closed) return;
		this.#recovering = true;
		this.abortTransmission(playbackError(this.#input.guildId, 'transport-recovering'));
		this.#callbacks.onRecovering();
	}

	private nextRetryDelay(): number {
		const ceiling = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** Math.min(this.#retryAttempt++, 6));
		return Math.floor(ceiling * (0.5 + this.#runtime.random() * 0.5));
	}

	private invalidateWebSocket(socket: WebSocket): void {
		if (this.#webSocket === socket) this.#webSocket = undefined;
		++this.#webSocketGeneration;
		this.clearHeartbeat();
		try {
			socket.close();
		} catch {
			// The generation fence already detached the failed socket.
		}
	}

	private isCurrentWebSocket(socket: WebSocket, generation: number): boolean {
		return !this.#closed && this.#webSocket === socket && this.#webSocketGeneration === generation;
	}

	private isCurrentUdpGeneration(generation: number): boolean {
		return !this.#closed && this.#udpGeneration === generation;
	}

	private async closeUdp(): Promise<void> {
		++this.#udpGeneration;
		this.rejectPendingDiscovery(transportClosedError(this.#input.guildId));
		const socket = this.#udpSocket;
		this.#udpSocket = undefined;
		await socket?.close();
	}

	private closeUdpDetached(): void {
		void this.closeUdp().catch(error => {
			this.failTerminal(toConnectionError(error, this.#input.guildId, 'udp-close-failed'));
		});
	}

	private rejectPendingDiscovery(error: VoiceError): void {
		const pending = this.#pendingDiscovery;
		if (!pending) return;
		this.#pendingDiscovery = undefined;
		clearTimeout(pending.timer);
		pending.deferred.reject(error);
	}

	private replaceSecretKey(secretKey: Uint8Array | undefined, mode?: VoiceTransportEncryptionMode): boolean {
		const ssrc = this.#ssrc;
		if (
			secretKey &&
			mode &&
			ssrc !== undefined &&
			this.#packetizer &&
			this.#packetizerMode === mode &&
			this.#packetizerSsrc === ssrc &&
			this.#secretKey &&
			equalBytes(this.#secretKey, secretKey)
		) {
			secretKey.fill(0);
			return false;
		}
		this.#packetizer?.close();
		this.#packetizer = undefined;
		this.#depacketizer?.close();
		this.#depacketizer = undefined;
		this.#packetizerMode = undefined;
		this.#packetizerSsrc = undefined;
		this.#secretKey?.fill(0);
		this.#secretKey = secretKey;
		if (!secretKey) {
			this.#sessionDaveProtocolVersion = undefined;
			return true;
		}
		if (ssrc === undefined || !mode) {
			throw new VoiceError('VOICE_PROTOCOL_ERROR', {
				metadata: { detail: 'Voice transport encryption was selected without an RTP SSRC or mode.' },
			});
		}
		this.#packetizer = new VoiceRtpPacketizer({
			provider: this.#provider,
			mode,
			secretKey,
			ssrc,
			random: () => this.#runtime.random(),
		});
		this.#depacketizer = new VoiceRtpDepacketizer({ provider: this.#provider, mode, secretKey });
		this.#packetizerMode = mode;
		this.#packetizerSsrc = ssrc;
		return true;
	}

	private setSpeaking(speaking: boolean): void {
		const ssrc = this.#ssrc;
		if (ssrc === undefined) throw playbackError(this.#input.guildId, 'rtp-ssrc-unavailable');
		this.sendJson(VoiceGatewayOpcode.Speaking, { speaking: speaking ? 1 : 0, delay: 0, ssrc });
	}

	private async sendAudioFrame(frame: Uint8Array, samples: number): Promise<void> {
		const socket = this.#udpSocket;
		const packetizer = this.#packetizer;
		if (this.#closed || this.#recovering || !this.#networkReady || !this.#dave.ready || !socket || !packetizer) {
			throw playbackError(this.#input.guildId, 'transport-not-ready');
		}
		// DAVE protects the Opus frame end to end before transport encryption wraps it for Discord's SFU.
		const transformed = this.#dave.transformAudioFrame(frame);
		try {
			await socket.send(packetizer.createPacket(transformed, samples));
		} catch (error) {
			throw toConnectionError(error, this.#input.guildId, 'audio-send-failed');
		} finally {
			transformed.fill(0);
		}
	}

	private abortTransmission(error: VoiceError): void {
		const transmission = this.#transmission;
		if (!transmission) return;
		this.#transmission = undefined;
		transmission.abort(error);
	}

	private clearTransmission(transmission: VoiceAudioTransmission): void {
		if (this.#transmission === transmission) this.#transmission = undefined;
	}

	private clearHeartbeat(): void {
		if (this.#heartbeatTimer) clearTimeout(this.#heartbeatTimer);
		this.#heartbeatTimer = undefined;
		this.#heartbeatAwaitingAck = false;
		this.#lastHeartbeatNonce = undefined;
	}

	private clearRetryTimer(): void {
		if (this.#retryTimer) clearTimeout(this.#retryTimer);
		this.#retryTimer = undefined;
	}

	private failTerminal(error: VoiceError): void {
		if (this.#closed || this.#terminalNotified) return;
		this.#terminalNotified = true;
		this.#closed = true;
		if (!this.#readySettled) {
			this.#readySettled = true;
			this.#readyDeferred.reject(error);
		}
		this.#closePromise = this.closeResources();
		this.#callbacks.onTerminalFailure(error);
	}

	private async closeResources(): Promise<void> {
		this.abortTransmission(transportClosedError(this.#input.guildId));
		this.clearHeartbeat();
		this.clearRetryTimer();
		const socket = this.#webSocket;
		this.#webSocket = undefined;
		++this.#webSocketGeneration;
		if (socket) {
			try {
				socket.close();
			} catch {
				// The transport is already closed from the package's perspective.
			}
		}
		this.replaceSecretKey(undefined);
		this.clearParticipantSsrcs();
		const results = await Promise.allSettled([this.closeUdp(), Promise.resolve(this.#dave.close())]);
		const errors = results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []));
		if (errors.length) throw new AggregateError(errors, 'Failed to close the Voice Gateway transport.');
	}
}

function playbackError(guildId: string, reason: string): VoiceError<'VOICE_CONNECTION_FAILED'> {
	return new VoiceError('VOICE_CONNECTION_FAILED', { metadata: { guildId, reason } });
}

function isDaveBinaryOpcode(opcode: number): boolean {
	return (
		opcode === VoiceGatewayOpcode.DaveMlsExternalSender ||
		opcode === VoiceGatewayOpcode.DaveMlsProposals ||
		opcode === VoiceGatewayOpcode.DaveMlsAnnounceCommitTransition ||
		opcode === VoiceGatewayOpcode.DaveMlsWelcome
	);
}

function transportClosedError(guildId: string): VoiceError<'VOICE_CONNECTION_DESTROYED'> {
	return new VoiceError('VOICE_CONNECTION_DESTROYED', {
		metadata: { guildId, reason: 'transport-closed' },
	});
}

function toConnectionError(error: unknown, guildId: string, reason: string): VoiceError {
	if (VoiceError.is(error)) return error;
	return new VoiceError('VOICE_CONNECTION_FAILED', { cause: error, metadata: { guildId, reason } });
}

function toProtocolError(error: unknown): VoiceError {
	if (VoiceError.is(error)) return error;
	return new VoiceError('VOICE_PROTOCOL_ERROR', { cause: error });
}
