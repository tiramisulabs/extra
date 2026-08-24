import type { GatewayDispatchPayload } from 'seyfert';
import { VoiceConnection, type VoiceConnectionController } from './connection';
import { DaveVerificationError } from './dave/verification-error';
import { VoiceError, type VoiceErrorCode } from './errors';
import {
	getGatewayClientUserId,
	parseVoiceGatewayObservation,
	sendGatewayVoiceState,
	type VoiceGatewayClient,
	type VoiceGatewayObservation,
	type VoiceGatewayServerObservation,
	type VoiceGatewayStateObservation,
} from './gateway';
import type { VoicePlayback, VoicePlaybackSource } from './media/playback';
import {
	VoiceAudioReceiver,
	type VoiceReceivedPacket,
	type VoiceReceiveOptions,
	VoiceReceiveStream,
} from './media/receiver';
import { ReadonlyMapView } from './readonly-map';
import { freezeVoiceState } from './state';
import type { VoiceTransportFactory, VoiceTransportInput, VoiceTransportSession } from './transport';
import type {
	VoiceConfirmedState,
	VoiceConnectionDestroyReason,
	VoiceConnectionState,
	VoiceConnectionTarget,
	VoiceConnectOptions,
	VoicePluginOptions,
	VoiceSelfStateOptions,
} from './types';
import { assertSnowflake, resolveConnectInput, resolveOperationTimeout } from './validation';

interface VoiceManagerEvents {
	emit(name: string, ...args: readonly unknown[]): unknown;
}

interface VoiceManagerLogger {
	warn(...args: readonly unknown[]): unknown;
}

interface VoiceManagerClient extends VoiceGatewayClient {
	events?: VoiceManagerEvents;
	logger?: VoiceManagerLogger;
}

type VoiceOperationKind = 'connect' | 'move' | 'disconnect' | 'self-state';

interface VoiceOperation {
	readonly kind: VoiceOperationKind;
	readonly key: string;
	readonly generation: number;
	readonly awaitsTransport: boolean;
	readonly target?: VoiceConnectionTarget;
	readonly fallbackCoordination?: VoiceCoordinationSnapshot;
	readonly promise: Promise<VoiceConnection | void>;
	readonly resolve: (value: VoiceConnection | void) => void;
	readonly reject: (error: VoiceError) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface VoiceServerData {
	readonly token: string;
	readonly endpoint: string | null;
}

interface VoiceCoordinationSnapshot {
	readonly channelId?: string;
	readonly sessionId?: string;
	readonly server?: VoiceServerData;
	readonly allowRetainedSessionForServer: boolean;
	readonly requiresFreshServer: boolean;
	readonly status: VoiceConnectionState['status'];
}

interface VoiceConnectionRecord {
	readonly controller: VoiceConnectionController;
	readonly receiver: VoiceAudioReceiver;
	recoveryResourceLease?: VoiceRecoveryResourceLease;
	operation?: VoiceOperation;
	operationGeneration: number;
	transport?: VoiceTransportSession;
	transportGeneration: number;
	transportKey?: string;
	sessionId?: string;
	server?: VoiceServerData;
	lastTransportChannelId?: string;
	lastTransportSessionId?: string;
	lastTransportToken?: string;
	allowRetainedSessionForServer: boolean;
	requiresFreshServer: boolean;
	everReady: boolean;
}

interface VoiceRecoveryResourceLease {
	readonly channelId: string;
	readonly release: () => void;
}

interface QueuedGatewayDispatch {
	readonly observation?: VoiceGatewayObservation;
	readonly error?: VoiceError;
	readonly guildId?: string;
	readonly operationGeneration: number;
	readonly record?: VoiceConnectionRecord;
}

export class VoiceManager {
	readonly connections: ReadonlyMap<string, VoiceConnection>;
	readonly #connectionValues = new Map<string, VoiceConnection>();
	readonly #records = new Map<string, VoiceConnectionRecord>();
	readonly #operationTimeoutMs: number;
	readonly #transportFactory: VoiceTransportFactory;
	#client?: VoiceManagerClient;
	#closed = false;
	#closePromise?: Promise<void>;
	#gatewayTail = Promise.resolve();

	private constructor(operationTimeoutMs: number, transportFactory: VoiceTransportFactory) {
		this.#operationTimeoutMs = operationTimeoutMs;
		this.#transportFactory = transportFactory;
		this.connections = new ReadonlyMapView(this.#connectionValues);
	}

	connect(options: VoiceConnectOptions): Promise<VoiceConnection> {
		try {
			return this.connectResolved(resolveConnectInput(options));
		} catch (error) {
			return Promise.reject(error);
		}
	}

	disconnect(guildId: string): Promise<void> {
		try {
			assertSnowflake(guildId, 'guildId');
			return this.disconnectResolved(guildId);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	/** @internal */
	attach(client: VoiceManagerClient): void {
		if (this.#client === client) return;
		if (this.#client) {
			throw new VoiceError('VOICE_INVALID_ARGUMENT', {
				metadata: {
					detail: 'A voice plugin instance cannot be installed on more than one Seyfert client.',
					reason: 'plugin-instance-reused',
				},
			});
		}
		this.#client = client;
	}

	/** @internal */
	enqueueGatewayDispatch(packet: GatewayDispatchPayload, shardId: number): void {
		if (this.#closed || (packet.t !== 'VOICE_STATE_UPDATE' && packet.t !== 'VOICE_SERVER_UPDATE')) return;
		let observation: VoiceGatewayObservation | null = null;
		let error: VoiceError | undefined;
		try {
			observation = parseVoiceGatewayObservation(packet, getGatewayClientUserId(this.requireClient()), shardId);
		} catch (caught) {
			error = toVoiceError(caught, 'VOICE_PROTOCOL_ERROR');
		}
		if (!observation && !error) return;
		const guildId = observation?.guildId ?? readDispatchGuildId(packet);
		// Bind queued work to this record incarnation so backlog cannot mutate a later connection for the guild.
		const record = guildId ? this.#records.get(guildId) : undefined;
		const queued: QueuedGatewayDispatch = {
			...(observation ? { observation } : {}),
			...(error ? { error } : {}),
			guildId,
			operationGeneration: record?.operationGeneration ?? 0,
			record,
		};
		this.#gatewayTail = this.#gatewayTail.then(
			() => this.handleGatewayDispatch(queued),
			() => this.handleGatewayDispatch(queued),
		);
	}

	/** @internal */
	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#closed = true;
		this.#closePromise = this.closeRecords();
		return this.#closePromise;
	}

	/** @internal */
	static create(options: VoicePluginOptions, transportFactory: VoiceTransportFactory): VoiceManager {
		return new VoiceManager(resolveOperationTimeout(options.operationTimeoutMs), transportFactory);
	}

	private connectResolved(options: VoiceConnectOptions): Promise<VoiceConnection> {
		this.assertOpen();
		getGatewayClientUserId(this.requireClient());

		const existing = this.#records.get(options.guildId);
		const baseline = existing ? getEffectiveTarget(existing.controller.connection.state) : undefined;
		const target = freezeVoiceState({
			channelId: options.channelId,
			selfMute: options.selfMute ?? baseline?.selfMute ?? false,
			selfDeaf: options.selfDeaf ?? baseline?.selfDeaf ?? true,
		});
		const key = connectionOperationKey(target);

		if (!existing) return this.startInitialConnection(options.guildId, target, key);
		const operation = existing.operation;
		if (operation) {
			if ((operation.kind === 'connect' || operation.kind === 'move') && operation.key === key) {
				return operation.promise as Promise<VoiceConnection>;
			}
			return Promise.reject(operationConflict(options.guildId, 'connect', operation.kind));
		}

		const connection = existing.controller.connection;
		const state = connection.state;
		if (state.status === 'disconnecting') {
			return Promise.reject(operationConflict(options.guildId, 'connect', 'disconnect'));
		}

		const confirmed = state.confirmed;
		const currentChannelId = getEffectiveTarget(state)?.channelId;
		if (currentChannelId !== target.channelId) {
			if (!options.move) {
				return Promise.reject(
					new VoiceError('VOICE_MOVE_REQUIRED', {
						metadata: {
							guildId: options.guildId,
							channelId: target.channelId,
							currentChannelId,
						},
					}),
				);
			}
			if (!confirmed) return Promise.reject(operationConflict(options.guildId, 'move', state.status));
			return this.startMove(existing, target, key);
		}

		if (state.status === 'ready' && sameSelfState(state.confirmed, target)) return Promise.resolve(connection);
		if (state.status === 'recovering') {
			if (!sameSelfState(state.confirmed, target)) {
				return Promise.reject(operationConflict(options.guildId, 'connect', 'recovery'));
			}
			const waiting = this.createOperation(existing, 'connect', key, true, target);
			return waiting.promise as Promise<VoiceConnection>;
		}
		if (state.status !== 'ready' || !confirmed) {
			return Promise.reject(operationConflict(options.guildId, 'connect', state.status));
		}

		const update = this.createOperation(existing, 'connect', key, false, target);
		void this.sendConnectionIntent(existing, update, target, false);
		return update.promise as Promise<VoiceConnection>;
	}

	private startInitialConnection(
		guildId: string,
		target: VoiceConnectionTarget,
		key: string,
	): Promise<VoiceConnection> {
		const controller = VoiceConnection.create(
			guildId,
			{ status: 'connecting', confirmed: null, target },
			{
				play: (connection, source) => this.playConnection(connection, source),
				receive: (connection, userId, options) => this.receiveConnection(connection, userId, options),
				setSelfState: (connection, options) => this.setConnectionSelfState(connection, options),
				getVerificationCode: (connection, userId) => this.getConnectionVerificationCode(connection, userId),
			},
		);
		const record: VoiceConnectionRecord = {
			controller,
			receiver: new VoiceAudioReceiver(),
			operationGeneration: 0,
			transportGeneration: 0,
			allowRetainedSessionForServer: false,
			requiresFreshServer: true,
			everReady: false,
		};
		this.#records.set(guildId, record);
		this.#connectionValues.set(guildId, controller.connection);

		const operation = this.createOperation(record, 'connect', key, true, target);
		void this.sendConnectionIntent(record, operation, target, true);
		return operation.promise as Promise<VoiceConnection>;
	}

	private startMove(
		record: VoiceConnectionRecord,
		target: VoiceConnectionTarget,
		key: string,
	): Promise<VoiceConnection> {
		record.transport?.abortPlayback(playbackUnavailableError(record.controller.connection, 'connection-moving'));
		const operation = this.createOperation(record, 'move', key, true, target, snapshotVoiceCoordination(record));
		this.commitState(record, { status: 'moving', confirmed: record.controller.connection.state.confirmed!, target });
		void this.sendConnectionIntent(record, operation, target, true);
		return operation.promise as Promise<VoiceConnection>;
	}

	private playConnection(connection: VoiceConnection, source: VoicePlaybackSource): VoicePlayback {
		this.assertOpen();
		const record = this.requireRecord(connection);
		const state = connection.state;
		const confirmed = state.confirmed;
		if (state.status !== 'ready' || !confirmed || !record.transport) {
			throw new VoiceError('VOICE_NOT_CONNECTED', {
				metadata: { guildId: connection.guildId, status: state.status, reason: 'playback-unavailable' },
			});
		}
		if (confirmed.suppress || confirmed.selfMute) {
			throw new VoiceError('VOICE_NOT_CONNECTED', {
				metadata: {
					guildId: connection.guildId,
					status: state.status,
					reason: confirmed.suppress ? 'stage-suppressed' : 'self-muted',
				},
			});
		}
		return record.transport.play(source);
	}

	private receiveConnection(
		connection: VoiceConnection,
		userId: string,
		options: VoiceReceiveOptions,
	): VoiceReceiveStream {
		this.assertOpen();
		const record = this.requireRecord(connection);
		const state = connection.state;
		const confirmed = state.confirmed;
		if (state.status !== 'ready' || !confirmed || !record.transport) {
			throw new VoiceError('VOICE_NOT_CONNECTED', {
				metadata: { guildId: connection.guildId, status: state.status, reason: 'receive-unavailable' },
			});
		}
		if (confirmed.selfDeaf) {
			throw new VoiceError('VOICE_NOT_CONNECTED', {
				metadata: { guildId: connection.guildId, status: state.status, reason: 'self-deafened' },
			});
		}
		return record.receiver.subscribe(userId, options);
	}

	private async sendConnectionIntent(
		record: VoiceConnectionRecord,
		operation: VoiceOperation,
		target: VoiceConnectionTarget,
		coordinateMedia: boolean,
	): Promise<void> {
		if (coordinateMedia) {
			record.sessionId = undefined;
			record.server = undefined;
			record.allowRetainedSessionForServer = false;
			record.requiresFreshServer = true;
		}

		try {
			const sent = await sendGatewayVoiceState(this.requireClient(), {
				guildId: record.controller.connection.guildId,
				channelId: target.channelId,
				selfMute: target.selfMute,
				selfDeaf: target.selfDeaf,
			});
			if (!sent) {
				throw new VoiceError('VOICE_CONNECTION_FAILED', {
					metadata: {
						guildId: record.controller.connection.guildId,
						channelId: target.channelId,
						reason: 'gateway-payload-vetoed',
					},
				});
			}
		} catch (error) {
			this.handleIntentSendFailure(record, operation, toVoiceError(error, 'VOICE_CONNECTION_FAILED'));
		}
	}

	private handleIntentSendFailure(record: VoiceConnectionRecord, operation: VoiceOperation, error: VoiceError): void {
		if (record.operation !== operation) return;
		this.rejectOperation(record, operation, error);
		const confirmed = record.controller.connection.state.confirmed;
		if (!confirmed) {
			this.destroyRecord(record, 'terminal-failure', error);
			return;
		}
		const wasRecovering =
			record.controller.connection.state.status === 'recovering' ||
			operation.fallbackCoordination?.status === 'recovering' ||
			!record.everReady;
		const restored = restoreVoiceCoordination(record, operation, confirmed);
		const canRemainReady =
			!wasRecovering &&
			hasOperationalTransport(record, confirmed) &&
			(operation.fallbackCoordination === undefined || restored);
		this.commitState(record, canRemainReady ? { status: 'ready', confirmed } : { status: 'recovering', confirmed });
		if (!canRemainReady) this.tryStartTransport(record);
	}

	private async setConnectionSelfState(connection: VoiceConnection, options: VoiceSelfStateOptions): Promise<void> {
		this.assertOpen();
		const record = this.requireRecord(connection);
		if (record.operation) {
			const confirmed = record.controller.connection.state.confirmed;
			const desired = confirmed
				? {
						selfMute: options.selfMute ?? confirmed.selfMute,
						selfDeaf: options.selfDeaf ?? confirmed.selfDeaf,
					}
				: undefined;
			const key = desired ? selfStateOperationKey(desired) : '';
			if (record.operation.kind === 'self-state' && record.operation.key === key) {
				return record.operation.promise as Promise<void>;
			}
			throw operationConflict(connection.guildId, 'self-state', record.operation.kind);
		}

		const confirmed = connection.state.confirmed;
		if (!confirmed || connection.state.status === 'disconnecting') {
			throw new VoiceError('VOICE_NOT_CONNECTED', {
				metadata: { guildId: connection.guildId, status: connection.state.status },
			});
		}
		if (connection.state.status === 'recovering') {
			throw operationConflict(connection.guildId, 'self-state', 'recovery');
		}

		const desired = {
			selfMute: options.selfMute ?? confirmed.selfMute,
			selfDeaf: options.selfDeaf ?? confirmed.selfDeaf,
		};
		if (sameSelfState(confirmed, desired)) return;
		const operation = this.createOperation(record, 'self-state', selfStateOperationKey(desired), false);

		try {
			const sent = await sendGatewayVoiceState(this.requireClient(), {
				guildId: connection.guildId,
				channelId: confirmed.channelId,
				selfMute: desired.selfMute,
				selfDeaf: desired.selfDeaf,
			});
			if (!sent) {
				throw new VoiceError('VOICE_CONNECTION_FAILED', {
					metadata: { guildId: connection.guildId, operation: 'self-state', reason: 'gateway-payload-vetoed' },
				});
			}
		} catch (error) {
			if (record.operation === operation) {
				this.rejectOperation(record, operation, toVoiceError(error, 'VOICE_CONNECTION_FAILED'));
			}
		}

		return operation.promise as Promise<void>;
	}

	private async getConnectionVerificationCode(connection: VoiceConnection, userId: string): Promise<string> {
		this.assertOpen();
		const record = this.requireRecord(connection);
		if (userId === getGatewayClientUserId(this.requireClient())) {
			throw new VoiceError('VOICE_INVALID_ARGUMENT', {
				metadata: { guildId: connection.guildId, userId, reason: 'self-verification' },
			});
		}
		const status = connection.state.status;
		if (status !== 'ready') {
			throw new VoiceError('VOICE_VERIFICATION_UNAVAILABLE', {
				metadata: { guildId: connection.guildId, userId, status, reason: 'connection_not_ready' },
			});
		}
		if (!record.transport || connection.voicePrivacyCode === null) {
			throw new VoiceError('VOICE_VERIFICATION_UNAVAILABLE', {
				metadata: { guildId: connection.guildId, userId, status, reason: 'dave_inactive' },
			});
		}
		let code: string;
		try {
			code = await record.transport.getVerificationCode(userId);
		} catch (error) {
			const currentStatus = connection.state.status;
			if (currentStatus !== 'ready') {
				throw new VoiceError('VOICE_VERIFICATION_UNAVAILABLE', {
					metadata: {
						guildId: connection.guildId,
						userId,
						status: currentStatus,
						reason: 'connection_not_ready',
					},
				});
			}
			const reason = error instanceof DaveVerificationError ? error.reason : 'derivation_failed';
			const cause =
				reason === 'derivation_failed'
					? error instanceof DaveVerificationError
						? (error.cause ?? error)
						: error
					: undefined;
			throw new VoiceError('VOICE_VERIFICATION_UNAVAILABLE', {
				...(cause === undefined ? {} : { cause }),
				metadata: {
					guildId: connection.guildId,
					userId,
					status: currentStatus,
					reason,
				},
			});
		}
		const currentStatus = connection.state.status;
		if (currentStatus !== 'ready') {
			throw new VoiceError('VOICE_VERIFICATION_UNAVAILABLE', {
				metadata: {
					guildId: connection.guildId,
					userId,
					status: currentStatus,
					reason: 'connection_not_ready',
				},
			});
		}
		return code;
	}

	private disconnectResolved(guildId: string): Promise<void> {
		this.assertOpen();
		const record = this.#records.get(guildId);
		if (!record) return Promise.resolve();
		if (record.operation?.kind === 'disconnect') return record.operation.promise as Promise<void>;
		const fallbackCoordination = record.operation?.fallbackCoordination;
		if (record.operation) {
			this.rejectOperation(
				record,
				record.operation,
				new VoiceError('VOICE_OPERATION_CONFLICT', {
					metadata: { guildId, operation: record.operation.kind, supersededBy: 'disconnect' },
				}),
			);
		}

		const operation = this.createOperation(record, 'disconnect', 'disconnect', false, undefined, fallbackCoordination);
		this.commitState(record, { status: 'disconnecting', confirmed: record.controller.connection.state.confirmed });
		this.commitVoicePrivacyCode(record, null);
		void this.executeDisconnect(record, operation);
		return operation.promise as Promise<void>;
	}

	private async executeDisconnect(record: VoiceConnectionRecord, operation: VoiceOperation): Promise<void> {
		const confirmedBeforeClose = record.controller.connection.state.confirmed;
		try {
			await this.stopTransport(record, confirmedBeforeClose?.channelId);
		} catch (error) {
			this.#client?.logger?.warn('@slipher/voice transport close', error);
		}
		if (record.operation !== operation || !this.isCurrentRecord(record)) return;
		const confirmed = record.controller.connection.state.confirmed;
		try {
			const sent = await sendGatewayVoiceState(this.requireClient(), {
				guildId: record.controller.connection.guildId,
				channelId: null,
				selfMute: confirmed?.selfMute ?? false,
				selfDeaf: confirmed?.selfDeaf ?? true,
			});
			if (!sent) {
				throw new VoiceError('VOICE_CONNECTION_FAILED', {
					metadata: {
						guildId: record.controller.connection.guildId,
						operation: 'disconnect',
						reason: 'gateway-payload-vetoed',
					},
				});
			}
		} catch (error) {
			if (record.operation !== operation) return;
			this.rejectOperation(record, operation, toVoiceError(error, 'VOICE_CONNECTION_FAILED'));
			this.reconcileAfterFailedDisconnect(record, operation);
		}
	}

	private reconcileAfterFailedDisconnect(record: VoiceConnectionRecord, operation: VoiceOperation): void {
		const confirmed = record.controller.connection.state.confirmed;
		if (!confirmed) {
			this.destroyRecord(record, 'external-disconnect');
			return;
		}
		restoreVoiceCoordination(record, operation, confirmed);
		this.commitState(record, { status: 'recovering', confirmed });
		this.tryStartTransport(record);
	}

	private createOperation(
		record: VoiceConnectionRecord,
		kind: VoiceOperationKind,
		key: string,
		awaitsTransport: boolean,
		target?: VoiceConnectionTarget,
		fallbackCoordination?: VoiceCoordinationSnapshot,
	): VoiceOperation {
		const generation = ++record.operationGeneration;
		const deferred = Promise.withResolvers<VoiceConnection | void>();
		const operation: VoiceOperation = {
			kind,
			key,
			generation,
			awaitsTransport,
			target,
			fallbackCoordination,
			promise: deferred.promise,
			resolve: deferred.resolve,
			reject: deferred.reject,
			timer: undefined as never,
		};
		operation.timer = setTimeout(() => this.handleOperationTimeout(record, operation), this.#operationTimeoutMs);
		record.operation = operation;
		return operation;
	}

	private handleOperationTimeout(record: VoiceConnectionRecord, operation: VoiceOperation): void {
		if (record.operation !== operation) return;
		const error = new VoiceError('VOICE_OPERATION_TIMEOUT', {
			metadata: {
				guildId: record.controller.connection.guildId,
				operation: operation.kind,
				timeoutMs: this.#operationTimeoutMs,
			},
		});
		this.rejectOperation(record, operation, error);

		const confirmed = record.controller.connection.state.confirmed;
		if (operation.kind === 'self-state') return;
		if (!record.everReady) {
			this.destroyRecord(record, 'terminal-failure', error);
			if (operation.kind === 'connect' || confirmed) this.bestEffortLeave(record, confirmed);
			return;
		}
		if (!confirmed) {
			this.destroyRecord(record, operation.kind === 'disconnect' ? 'explicit-disconnect' : 'external-disconnect');
			return;
		}
		const state = record.controller.connection.state;
		if (
			operation.kind !== 'disconnect' &&
			(state.status === 'ready' || state.status === 'moving') &&
			hasOperationalTransport(record, confirmed)
		) {
			restoreVoiceCoordination(record, operation, confirmed);
			const recovering = operation.fallbackCoordination?.status === 'recovering';
			this.commitState(record, recovering ? { status: 'recovering', confirmed } : { status: 'ready', confirmed });
			if (recovering) this.tryStartTransport(record);
			return;
		}
		if (operation.kind !== 'disconnect' || record.lastTransportChannelId === confirmed.channelId) {
			restoreVoiceCoordination(record, operation, confirmed);
		}
		this.commitState(record, { status: 'recovering', confirmed });
		this.tryStartTransport(record);
	}

	private resolveOperation(
		record: VoiceConnectionRecord,
		operation: VoiceOperation,
		value: VoiceConnection | void,
	): void {
		if (record.operation !== operation) return;
		clearTimeout(operation.timer);
		record.operation = undefined;
		operation.resolve(value);
	}

	private rejectOperation(record: VoiceConnectionRecord, operation: VoiceOperation, error: VoiceError): void {
		if (record.operation !== operation) return;
		clearTimeout(operation.timer);
		record.operation = undefined;
		operation.reject(error);
	}

	private async handleGatewayDispatch(queued: QueuedGatewayDispatch): Promise<void> {
		if (this.#closed) return;
		if (queued.guildId && this.#records.get(queued.guildId) !== queued.record) return;
		if (queued.error) {
			this.#client?.logger?.warn('@slipher/voice gateway dispatch', queued.error);
			const record = queued.guildId ? this.#records.get(queued.guildId) : undefined;
			if (record) {
				this.destroyRecord(record, 'terminal-failure', queued.error);
				this.bestEffortLeave(record, record.controller.connection.state.confirmed);
			}
			return;
		}
		const observation = queued.observation;
		if (!observation) return;
		if (observation.kind === 'state') {
			this.handleVoiceState(observation, queued.operationGeneration);
		} else {
			this.handleVoiceServer(observation, queued.operationGeneration);
		}
	}

	private handleVoiceState(observation: VoiceGatewayStateObservation, observedOperationGeneration: number): void {
		const record = this.#records.get(observation.guildId);
		if (!record) return;
		const connection = record.controller.connection;
		if (observation.confirmed === null) {
			const operation = record.operation;
			if (operation?.kind === 'disconnect') {
				this.resolveOperation(record, operation, undefined);
				this.destroyRecord(record, 'explicit-disconnect');
			} else {
				if (operation) {
					this.rejectOperation(
						record,
						operation,
						new VoiceError('VOICE_NOT_CONNECTED', {
							metadata: { guildId: observation.guildId, operation: operation.kind },
						}),
					);
				}
				this.destroyRecord(record, 'external-disconnect');
			}
			return;
		}

		record.sessionId = observation.sessionId;
		const previousConfirmed = connection.state.confirmed;
		if (connection.state.status === 'disconnecting') {
			this.commitState(record, { status: 'disconnecting', confirmed: observation.confirmed });
			void this.repeatPendingLeave(record, observation.confirmed);
			return;
		}

		const channelChanged =
			previousConfirmed !== null && previousConfirmed.channelId !== observation.confirmed.channelId;
		const operation = record.operation;
		let connectionIntentOverridden = false;
		let fallbackCoordination: VoiceCoordinationSnapshot | undefined;
		if (
			operation &&
			(operation.kind === 'connect' || operation.kind === 'move') &&
			operation.generation === observedOperationGeneration
		) {
			const target = operation.target;
			if (target && !sameTarget(observation.confirmed, target)) {
				connectionIntentOverridden = true;
				fallbackCoordination = operation.fallbackCoordination;
				this.rejectOperation(
					record,
					operation,
					new VoiceError('VOICE_OPERATION_CONFLICT', {
						metadata: {
							guildId: observation.guildId,
							operation: operation.kind,
							reason: 'authoritative-state-overrode-intent',
						},
					}),
				);
			}
		}

		if (channelChanged) {
			record.allowRetainedSessionForServer = false;
			record.requiresFreshServer = true;
			const target = getOperationTarget(connection.state) ?? targetFromConfirmed(observation.confirmed);
			this.commitState(record, { status: 'moving', confirmed: observation.confirmed, target });
		} else if (connectionIntentOverridden && !record.everReady) {
			this.commitState(record, {
				status: 'connecting',
				confirmed: observation.confirmed,
				target: targetFromConfirmed(observation.confirmed),
			});
		} else if (connectionIntentOverridden && connection.state.status === 'moving') {
			const operationalTransport = hasOperationalTransport(record, observation.confirmed);
			const restored = fallbackCoordination
				? restoreVoiceCoordinationSnapshot(record, fallbackCoordination, observation.confirmed)
				: false;
			this.commitState(
				record,
				operationalTransport && (!restored || fallbackCoordination?.status !== 'recovering')
					? { status: 'ready', confirmed: observation.confirmed }
					: { status: 'recovering', confirmed: observation.confirmed },
			);
		} else {
			this.commitConfirmedState(record, observation.confirmed);
		}

		const currentOperation = record.operation;
		if (currentOperation?.kind === 'self-state' && currentOperation.generation === observedOperationGeneration) {
			const expected = parseSelfStateOperationKey(currentOperation.key);
			if (sameSelfState(observation.confirmed, expected)) {
				this.resolveOperation(record, currentOperation, undefined);
			} else {
				this.rejectOperation(
					record,
					currentOperation,
					new VoiceError('VOICE_OPERATION_CONFLICT', {
						metadata: {
							guildId: observation.guildId,
							operation: 'self-state',
							reason: 'authoritative-state-overrode-intent',
						},
					}),
				);
			}
		}

		const connectionOperation = record.operation;
		if (
			connectionOperation &&
			(connectionOperation.kind === 'connect' || connectionOperation.kind === 'move') &&
			!connectionOperation.awaitsTransport &&
			connectionOperation.generation === observedOperationGeneration
		) {
			this.resolveOperation(record, connectionOperation, connection);
		}
		this.tryStartTransport(record);
	}

	private async repeatPendingLeave(record: VoiceConnectionRecord, confirmed: VoiceConfirmedState): Promise<void> {
		if (record.operation?.kind !== 'disconnect') return;
		try {
			await sendGatewayVoiceState(this.requireClient(), {
				guildId: record.controller.connection.guildId,
				channelId: null,
				selfMute: confirmed.selfMute,
				selfDeaf: confirmed.selfDeaf,
			});
		} catch (error) {
			this.#client?.logger?.warn('@slipher/voice repeated leave', error);
		}
	}

	private handleVoiceServer(observation: VoiceGatewayServerObservation, observedOperationGeneration: number): void {
		const record = this.#records.get(observation.guildId);
		if (!record) return;
		const operation = record.operation;
		if (
			operation &&
			(operation.kind === 'connect' || operation.kind === 'move') &&
			operation.generation !== observedOperationGeneration
		) {
			return;
		}

		record.server = { token: observation.token, endpoint: observation.endpoint };
		if (observation.endpoint === null) {
			record.allowRetainedSessionForServer = true;
			record.requiresFreshServer = true;
			const confirmed = record.controller.connection.state.confirmed;
			void this.stopTransport(record, confirmed?.channelId).catch(error =>
				this.#client?.logger?.warn('@slipher/voice transport close', error),
			);
			if (record.everReady && confirmed) this.commitState(record, { status: 'recovering', confirmed });
			return;
		}

		const confirmed = record.controller.connection.state.confirmed;
		if (
			record.everReady &&
			confirmed &&
			record.lastTransportToken !== undefined &&
			record.lastTransportToken !== observation.token &&
			record.controller.connection.state.status === 'ready'
		) {
			this.commitState(record, { status: 'recovering', confirmed });
		}
		this.tryStartTransport(record);
	}

	private tryStartTransport(record: VoiceConnectionRecord): void {
		if (!this.isCurrentRecord(record)) return;
		const state = record.controller.connection.state;
		if (state.status === 'destroyed' || state.status === 'disconnecting') return;
		const confirmed = state.confirmed;
		const server = record.server;
		const sessionId = record.sessionId;
		if (!confirmed || !server?.endpoint || !sessionId) return;
		const target = getOperationTarget(state);
		if (target && !sameTarget(confirmed, target)) return;
		if (record.requiresFreshServer && server.token === record.lastTransportToken) return;
		if (
			!record.allowRetainedSessionForServer &&
			record.lastTransportSessionId !== undefined &&
			sessionId === record.lastTransportSessionId &&
			server.token !== record.lastTransportToken
		) {
			return;
		}

		const key = `${sessionId}\u0000${server.token}`;
		if (record.transportKey === key) return;
		record.allowRetainedSessionForServer = false;
		record.transportKey = key;
		const generation = ++record.transportGeneration;
		const previous = record.transport;
		record.transport = undefined;
		if (record.everReady && state.status !== 'moving' && state.status !== 'recovering') {
			this.commitState(record, { status: 'recovering', confirmed });
		}

		void this.startTransport(record, generation, previous, {
			guildId: record.controller.connection.guildId,
			channelId: confirmed.channelId,
			userId: getGatewayClientUserId(this.requireClient()),
			sessionId,
			token: server.token,
			endpoint: server.endpoint,
		});
	}

	private async startTransport(
		record: VoiceConnectionRecord,
		generation: number,
		previous: VoiceTransportSession | undefined,
		input: VoiceTransportInput,
	): Promise<void> {
		try {
			this.prepareRecoveryResourceLease(record, previous, input.channelId);
			await previous?.close();
			if (!this.isCurrentTransport(record, generation)) {
				if (!this.isCurrentRecord(record) || record.recoveryResourceLease?.channelId !== input.channelId) {
					this.releaseRecoveryResourceLease(record);
				}
				return;
			}
			let transport: VoiceTransportSession;
			try {
				transport = this.#transportFactory(input, {
					onRecovering: () => this.handleTransportRecovering(record, generation),
					onRecovered: () => this.handleTransportRecovered(record, generation),
					onNeedsServer: () => this.handleTransportNeedsServer(record, generation),
					onTerminalFailure: error => this.handleTransportTerminalFailure(record, generation, error),
					onVoicePrivacyCodeChange: code => this.handleVoicePrivacyCode(record, generation, code),
					onAudioPacket: packet => this.handleAudioPacket(record, generation, packet),
				});
			} finally {
				this.releaseRecoveryResourceLease(record);
			}
			if (!this.isCurrentTransport(record, generation)) {
				await transport.close();
				return;
			}
			record.transport = transport;
			await transport.ready;
			if (!this.isCurrentTransport(record, generation) || record.transport !== transport) return;
			record.lastTransportSessionId = input.sessionId;
			record.lastTransportToken = input.token;
			record.requiresFreshServer = false;
			this.handleTransportReady(record);
		} catch (error) {
			if (!this.isCurrentTransport(record, generation)) return;
			this.handleTransportTerminalFailure(record, generation, toVoiceError(error, 'VOICE_CONNECTION_FAILED'));
		}
	}

	private handleTransportReady(record: VoiceConnectionRecord): void {
		const confirmed = record.controller.connection.state.confirmed;
		if (!confirmed) return;
		const server = record.server;
		if (!record.sessionId || !server?.endpoint || record.transportKey !== `${record.sessionId}\u0000${server.token}`) {
			return;
		}
		const operation = record.operation;
		if (
			operation &&
			(operation.kind === 'connect' || operation.kind === 'move') &&
			operation.target &&
			!sameTarget(confirmed, operation.target)
		) {
			return;
		}
		record.lastTransportChannelId = confirmed.channelId;
		record.everReady = true;
		this.commitState(record, { status: 'ready', confirmed });
		if (operation && (operation.kind === 'connect' || operation.kind === 'move') && operation.awaitsTransport) {
			this.resolveOperation(record, operation, record.controller.connection);
		}
	}

	private handleTransportRecovering(record: VoiceConnectionRecord, generation: number): void {
		if (!this.isCurrentTransport(record, generation)) return;
		const confirmed = record.controller.connection.state.confirmed;
		if (confirmed) this.commitState(record, { status: 'recovering', confirmed });
	}

	private handleTransportRecovered(record: VoiceConnectionRecord, generation: number): void {
		if (!this.isCurrentTransport(record, generation)) return;
		this.handleTransportReady(record);
	}

	private handleTransportNeedsServer(record: VoiceConnectionRecord, generation: number): void {
		if (!this.isCurrentTransport(record, generation)) return;
		const confirmed = record.controller.connection.state.confirmed;
		if (!confirmed) return;
		record.server = undefined;
		record.allowRetainedSessionForServer = true;
		record.requiresFreshServer = true;
		this.commitState(record, { status: 'recovering', confirmed });
		void sendGatewayVoiceState(this.requireClient(), {
			guildId: record.controller.connection.guildId,
			channelId: confirmed.channelId,
			selfMute: confirmed.selfMute,
			selfDeaf: confirmed.selfDeaf,
		}).then(
			sent => {
				if (!sent) {
					this.handleTransportTerminalFailure(
						record,
						generation,
						new VoiceError('VOICE_CONNECTION_FAILED', {
							metadata: {
								guildId: record.controller.connection.guildId,
								reason: 'gateway-payload-vetoed',
							},
						}),
					);
				}
			},
			error => this.handleTransportTerminalFailure(record, generation, toVoiceError(error, 'VOICE_CONNECTION_FAILED')),
		);
	}

	private handleTransportTerminalFailure(record: VoiceConnectionRecord, generation: number, error: VoiceError): void {
		if (!this.isCurrentTransport(record, generation)) return;
		this.destroyRecord(record, 'terminal-failure', error);
		this.bestEffortLeave(record, record.controller.connection.state.confirmed);
	}

	private handleVoicePrivacyCode(record: VoiceConnectionRecord, generation: number, code: string | null): void {
		if (!this.isCurrentTransport(record, generation)) return;
		this.commitVoicePrivacyCode(record, code);
	}

	private commitState(record: VoiceConnectionRecord, state: VoiceConnectionState): void {
		const change = record.controller.setState(state);
		this.emit('voiceConnectionStateChange', record.controller.connection, change.next, change.previous);
	}

	private commitConfirmedState(record: VoiceConnectionRecord, confirmed: VoiceConfirmedState): void {
		if (confirmed.suppress || confirmed.selfMute) {
			record.transport?.abortPlayback(
				playbackUnavailableError(record.controller.connection, confirmed.suppress ? 'stage-suppressed' : 'self-muted'),
			);
		}
		const state = record.controller.connection.state;
		switch (state.status) {
			case 'connecting':
				this.commitState(record, { ...state, confirmed });
				break;
			case 'moving':
				this.commitState(record, { ...state, confirmed });
				break;
			case 'ready':
			case 'disconnecting':
			case 'recovering':
				this.commitState(record, { status: state.status, confirmed });
				break;
			case 'destroyed':
				break;
		}
	}

	private commitVoicePrivacyCode(record: VoiceConnectionRecord, code: string | null): void {
		const change = record.controller.setVoicePrivacyCode(code);
		if (change) this.emit('voicePrivacyCodeChange', record.controller.connection, change.next, change.previous);
	}

	private handleAudioPacket(record: VoiceConnectionRecord, generation: number, packet: VoiceReceivedPacket): void {
		const state = record.controller.connection.state;
		if (!this.isCurrentTransport(record, generation) || state.status !== 'ready' || state.confirmed.selfDeaf) return;
		record.receiver.push(packet);
	}

	private emit(name: string, ...args: readonly unknown[]): void {
		const result = this.#client?.events?.emit(name, ...args);
		if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
			void Promise.resolve(result).catch(error => this.#client?.logger?.warn(`@slipher/voice ${name}`, error));
		}
	}

	private destroyRecord(record: VoiceConnectionRecord, reason: VoiceConnectionDestroyReason, error?: VoiceError): void {
		if (!this.isCurrentRecord(record)) return;
		const operation = record.operation;
		if (operation) {
			this.rejectOperation(
				record,
				operation,
				error ??
					new VoiceError('VOICE_CONNECTION_DESTROYED', {
						metadata: { guildId: record.controller.connection.guildId, reason },
					}),
			);
		}
		this.commitVoicePrivacyCode(record, null);
		record.receiver.close();
		this.releaseRecoveryResourceLease(record);
		this.removeRecord(record);
		this.commitState(record, {
			status: 'destroyed',
			confirmed: record.controller.connection.state.confirmed,
			reason,
			...(error ? { error } : {}),
		});
		void this.stopTransport(record).catch(closeError =>
			this.#client?.logger?.warn('@slipher/voice transport close', closeError),
		);
	}

	private removeRecord(record: VoiceConnectionRecord): void {
		const guildId = record.controller.connection.guildId;
		this.#records.delete(guildId);
		this.#connectionValues.delete(guildId);
	}

	private async stopTransport(record: VoiceConnectionRecord, recoveryChannelId?: string): Promise<void> {
		if (recoveryChannelId) {
			this.prepareRecoveryResourceLease(record, record.transport, recoveryChannelId);
		} else {
			this.releaseRecoveryResourceLease(record);
		}
		++record.transportGeneration;
		record.transportKey = undefined;
		const transport = record.transport;
		record.transport = undefined;
		this.commitVoicePrivacyCode(record, null);
		await transport?.close();
	}

	private prepareRecoveryResourceLease(
		record: VoiceConnectionRecord,
		transport: VoiceTransportSession | undefined,
		channelId: string,
	): void {
		// Preserve the DAVE identity only while replacing transport for the same call; a channel move may rotate it.
		const existing = record.recoveryResourceLease;
		if (existing?.channelId !== channelId) this.releaseRecoveryResourceLease(record);
		if (
			record.recoveryResourceLease ||
			!transport ||
			record.lastTransportChannelId !== channelId ||
			!this.#transportFactory.retainResourcesForReplacement
		) {
			return;
		}
		record.recoveryResourceLease = {
			channelId,
			release: this.#transportFactory.retainResourcesForReplacement(),
		};
	}

	private releaseRecoveryResourceLease(record: VoiceConnectionRecord): void {
		const lease = record.recoveryResourceLease;
		if (!lease) return;
		record.recoveryResourceLease = undefined;
		lease.release();
	}

	private bestEffortLeave(record: VoiceConnectionRecord, confirmed: VoiceConfirmedState | null): void {
		void sendGatewayVoiceState(this.requireClient(), {
			guildId: record.controller.connection.guildId,
			channelId: null,
			selfMute: confirmed?.selfMute ?? false,
			selfDeaf: confirmed?.selfDeaf ?? true,
		}).catch(error => this.#client?.logger?.warn('@slipher/voice best-effort leave', error));
	}

	private isCurrentRecord(record: VoiceConnectionRecord): boolean {
		return this.#records.get(record.controller.connection.guildId) === record;
	}

	private isCurrentTransport(record: VoiceConnectionRecord, generation: number): boolean {
		return this.isCurrentRecord(record) && record.transportGeneration === generation;
	}

	private requireRecord(connection: VoiceConnection): VoiceConnectionRecord {
		const record = this.#records.get(connection.guildId);
		if (!record || record.controller.connection !== connection) {
			throw new VoiceError('VOICE_CONNECTION_DESTROYED', {
				metadata: { guildId: connection.guildId, status: connection.state.status },
			});
		}
		return record;
	}

	private requireClient(): VoiceManagerClient {
		if (this.#client) return this.#client;
		throw new VoiceError('VOICE_RUNTIME_UNSUPPORTED', {
			metadata: { detail: 'The voice manager is not attached to a Seyfert client.', reason: 'client-unavailable' },
		});
	}

	private assertOpen(): void {
		if (!this.#closed) return;
		throw new VoiceError('VOICE_CONNECTION_DESTROYED', {
			metadata: { detail: 'The voice manager has been closed.', reason: 'plugin-teardown' },
		});
	}

	private async closeRecords(): Promise<void> {
		const closeTasks: Promise<void>[] = [];
		for (const record of [...this.#records.values()]) {
			const confirmed = record.controller.connection.state.confirmed;
			if (confirmed) this.bestEffortLeave(record, confirmed);
			const operation = record.operation;
			if (operation) {
				this.rejectOperation(
					record,
					operation,
					new VoiceError('VOICE_CONNECTION_DESTROYED', {
						metadata: { guildId: record.controller.connection.guildId, reason: 'plugin-teardown' },
					}),
				);
			}
			this.commitVoicePrivacyCode(record, null);
			record.receiver.close();
			this.releaseRecoveryResourceLease(record);
			this.removeRecord(record);
			this.commitState(record, {
				status: 'destroyed',
				confirmed,
				reason: 'plugin-teardown',
			});
			closeTasks.push(this.stopTransport(record));
		}

		const results = await Promise.allSettled(closeTasks);
		const errors = results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []));
		if (errors.length) throw new AggregateError(errors, 'Failed to close one or more voice transports.');
	}
}

function playbackUnavailableError(connection: VoiceConnection, reason: string): VoiceError<'VOICE_CONNECTION_FAILED'> {
	return new VoiceError('VOICE_CONNECTION_FAILED', {
		metadata: { guildId: connection.guildId, status: connection.state.status, reason },
	});
}

function readDispatchGuildId(packet: GatewayDispatchPayload): string | undefined {
	if (!packet.d || typeof packet.d !== 'object') return undefined;
	const guildId = (packet.d as Record<string, unknown>).guild_id;
	return typeof guildId === 'string' ? guildId : undefined;
}

function connectionOperationKey(target: VoiceConnectionTarget): string {
	return `${target.channelId}:${Number(target.selfMute)}:${Number(target.selfDeaf)}`;
}

function selfStateOperationKey(state: Pick<VoiceConnectionTarget, 'selfMute' | 'selfDeaf'>): string {
	return `${Number(state.selfMute)}:${Number(state.selfDeaf)}`;
}

function parseSelfStateOperationKey(key: string): Pick<VoiceConnectionTarget, 'selfMute' | 'selfDeaf'> {
	const [selfMute, selfDeaf] = key.split(':');
	return { selfMute: selfMute === '1', selfDeaf: selfDeaf === '1' };
}

function getEffectiveTarget(state: VoiceConnectionState): VoiceConnectionTarget | undefined {
	if (state.status === 'connecting' || state.status === 'moving') return state.target;
	return state.confirmed ? targetFromConfirmed(state.confirmed) : undefined;
}

function getOperationTarget(state: VoiceConnectionState): VoiceConnectionTarget | undefined {
	return state.status === 'connecting' || state.status === 'moving' ? state.target : undefined;
}

function targetFromConfirmed(confirmed: VoiceConfirmedState): VoiceConnectionTarget {
	return {
		channelId: confirmed.channelId,
		selfMute: confirmed.selfMute,
		selfDeaf: confirmed.selfDeaf,
	};
}

function sameSelfState(
	confirmed: VoiceConfirmedState,
	target: Pick<VoiceConnectionTarget, 'selfMute' | 'selfDeaf'>,
): boolean {
	return confirmed.selfMute === target.selfMute && confirmed.selfDeaf === target.selfDeaf;
}

function sameTarget(confirmed: VoiceConfirmedState, target: VoiceConnectionTarget): boolean {
	return confirmed.channelId === target.channelId && sameSelfState(confirmed, target);
}

function snapshotVoiceCoordination(record: VoiceConnectionRecord): VoiceCoordinationSnapshot {
	return {
		channelId: record.controller.connection.state.confirmed?.channelId,
		sessionId: record.sessionId,
		server: record.server,
		allowRetainedSessionForServer: record.allowRetainedSessionForServer,
		requiresFreshServer: record.requiresFreshServer,
		status: record.controller.connection.state.status,
	};
}

function restoreVoiceCoordination(
	record: VoiceConnectionRecord,
	operation: VoiceOperation,
	confirmed: VoiceConfirmedState,
): boolean {
	return operation.fallbackCoordination
		? restoreVoiceCoordinationSnapshot(record, operation.fallbackCoordination, confirmed)
		: false;
}

function restoreVoiceCoordinationSnapshot(
	record: VoiceConnectionRecord,
	snapshot: VoiceCoordinationSnapshot,
	confirmed: VoiceConfirmedState,
): boolean {
	if (snapshot.channelId !== confirmed.channelId) return false;
	record.sessionId = snapshot.sessionId;
	record.server = snapshot.server;
	record.allowRetainedSessionForServer = snapshot.allowRetainedSessionForServer;
	record.requiresFreshServer = snapshot.requiresFreshServer;
	return true;
}

function hasOperationalTransport(record: VoiceConnectionRecord, confirmed: VoiceConfirmedState): boolean {
	if (
		!record.everReady ||
		record.transport === undefined ||
		record.lastTransportSessionId === undefined ||
		record.lastTransportToken === undefined ||
		record.transportKey !== `${record.lastTransportSessionId}\u0000${record.lastTransportToken}` ||
		record.lastTransportChannelId !== confirmed.channelId
	) {
		return false;
	}
	return record.sessionId === undefined || record.sessionId === record.lastTransportSessionId;
}

function operationConflict(guildId: string, operation: string, activeOperation: string): VoiceError {
	return new VoiceError('VOICE_OPERATION_CONFLICT', {
		metadata: { guildId, operation, activeOperation },
	});
}

function toVoiceError(error: unknown, code: VoiceErrorCode): VoiceError {
	if (VoiceError.is(error)) return error;
	return new VoiceError(code, { cause: error });
}
