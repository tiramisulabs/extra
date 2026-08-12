import { type GatewayDispatchPayload, GatewayOpcodes, type GatewayVoiceStateUpdate } from 'seyfert';
import { describe, expect, test, vi } from 'vitest';
import { VoiceConnection } from '../src/connection';
import { createDaveSessionFactory } from '../src/dave/session';
import { DaveVerificationError } from '../src/dave/verification-error';
import { VoiceManager } from '../src/manager';
import { VoicePlayback } from '../src/media/playback';
import { decodeKeyPackage } from '../src/mls/protocol';
import type {
	VoiceTransportCallbacks,
	VoiceTransportFactory,
	VoiceTransportInput,
	VoiceTransportSession,
} from '../src/transport';

const BOT_ID = '100000000000000001';
const OTHER_ID = '100000000000000002';
const GUILD_ID = '200000000000000001';
const CHANNEL_ONE = '300000000000000001';
const CHANNEL_TWO = '300000000000000002';

class Deferred<T> {
	readonly promise: Promise<T>;
	resolve!: (value: T | PromiseLike<T>) => void;
	reject!: (reason?: unknown) => void;

	constructor() {
		this.promise = new Promise<T>((resolve, reject) => {
			this.resolve = resolve;
			this.reject = reject;
		});
	}
}

class FakeTransport implements VoiceTransportSession {
	readonly readiness = new Deferred<void>();
	readonly ready = this.readiness.promise;
	readonly close = vi.fn(async () => {});
	readonly abortPlayback = vi.fn();
	readonly play = vi.fn(() => {
		const done = Promise.resolve();
		return VoicePlayback.create(done, () => done);
	});
	readonly getVerificationCode = vi.fn(async () => '123451234512345123451234512345123451234512345');

	constructor(
		readonly input: VoiceTransportInput,
		readonly callbacks: VoiceTransportCallbacks,
	) {}
}

function createHarness(operationTimeoutMs = 1_000, onCreateTransport?: (input: VoiceTransportInput) => void) {
	const sent: GatewayVoiceStateUpdate[] = [];
	const events: { name: string; args: readonly unknown[]; stateWasCommitted: boolean }[] = [];
	const transports: FakeTransport[] = [];
	const client = {
		me: { id: BOT_ID },
		gateway: {
			calculateShardId: () => 0,
			send: async (_shardId: number, payload: GatewayVoiceStateUpdate) => {
				sent.push(payload);
				return true;
			},
		},
		events: {
			emit(name: string, ...args: readonly unknown[]) {
				const connection = args[0] as VoiceConnection;
				const next = args[1];
				events.push({
					name,
					args,
					stateWasCommitted: name !== 'voiceConnectionStateChange' || connection.state === next,
				});
			},
		},
		logger: { warn: vi.fn() },
	};
	const transportFactory: VoiceTransportFactory = (input, callbacks) => {
		onCreateTransport?.(input);
		const transport = new FakeTransport(input, callbacks);
		transports.push(transport);
		return transport;
	};
	const manager = VoiceManager.create({ operationTimeoutMs }, transportFactory);
	manager.attach(client);
	return { client, events, manager, sent, transportFactory, transports };
}

function voiceStatePacket(options: {
	channelId: string | null;
	sessionId?: string;
	selfMute?: boolean;
	selfDeaf?: boolean;
}): GatewayDispatchPayload {
	return {
		op: GatewayOpcodes.Dispatch,
		t: 'VOICE_STATE_UPDATE',
		s: 1,
		d: {
			guild_id: GUILD_ID,
			channel_id: options.channelId,
			user_id: BOT_ID,
			session_id: options.sessionId ?? 'session-one',
			deaf: false,
			mute: false,
			self_deaf: options.selfDeaf ?? true,
			self_mute: options.selfMute ?? false,
			self_video: false,
			suppress: false,
			request_to_speak_timestamp: null,
		},
	} as GatewayDispatchPayload;
}

function voiceServerPacket(
	token = 'token-one',
	endpoint: string | null = 'voice.example.test',
): GatewayDispatchPayload {
	return {
		op: GatewayOpcodes.Dispatch,
		t: 'VOICE_SERVER_UPDATE',
		s: 2,
		d: { guild_id: GUILD_ID, token, endpoint },
	} as GatewayDispatchPayload;
}

async function flushGatewayWork(iterations = 8) {
	for (let index = 0; index < iterations; index++) await Promise.resolve();
}

async function connectReady(harness: ReturnType<typeof createHarness>, selfDeaf = true) {
	const pending = harness.manager.connect({ guildId: GUILD_ID, channelId: CHANNEL_ONE, selfDeaf });
	harness.manager.enqueueGatewayDispatch(voiceServerPacket(), 0);
	harness.manager.enqueueGatewayDispatch(voiceStatePacket({ channelId: CHANNEL_ONE, selfDeaf }), 0);
	await flushGatewayWork();
	const transport = harness.transports.at(-1)!;
	transport.readiness.resolve();
	const connection = await pending;
	return { connection, transport };
}

describe('VoiceManager', () => {
	test('starts playback only while the connection can transmit audio', async () => {
		const harness = createHarness();
		const { connection, transport } = await connectReady(harness);
		const source = {
			async *[Symbol.asyncIterator]() {
				yield Uint8Array.of(0xf8, 0xff, 0xfe);
			},
		};

		expect(connection.play(source)).toBeInstanceOf(VoicePlayback);
		expect(transport.play).toHaveBeenCalledExactlyOnceWith(source);
		transport.callbacks.onRecovering();
		expect(() => connection.play(source)).toThrowError(expect.objectContaining({ code: 'VOICE_NOT_CONNECTED' }));
	});

	test('receives bounded participant Opus streams across transport recovery', async () => {
		const harness = createHarness();
		const { connection, transport } = await connectReady(harness, false);
		const stream = connection.receive(OTHER_ID, { maxBufferedPackets: 1 });
		const first = {
			userId: OTHER_ID,
			opus: Uint8Array.of(1),
			sequence: 1,
			timestamp: 960,
			ssrc: 42,
		};
		const second = { ...first, opus: Uint8Array.of(2), sequence: 2, timestamp: 1_920 };
		transport.callbacks.onAudioPacket(first);
		transport.callbacks.onAudioPacket(second);
		first.opus[0] = 9;
		second.opus[0] = 9;
		expect(await stream.next()).toEqual({
			done: false,
			value: expect.objectContaining({ opus: Uint8Array.of(2), sequence: 2, timestamp: 1_920 }),
		});

		transport.callbacks.onRecovering();
		const pending = stream.next();
		transport.callbacks.onAudioPacket({ ...second, opus: Uint8Array.of(3), sequence: 3 });
		transport.callbacks.onRecovered();
		transport.callbacks.onAudioPacket({ ...second, opus: Uint8Array.of(4), sequence: 4 });
		expect(await pending).toEqual({
			done: false,
			value: expect.objectContaining({ opus: Uint8Array.of(4), sequence: 4 }),
		});

		await harness.manager.close();
		expect(await stream.next()).toEqual({ done: true, value: undefined });
	});

	test('requires an undeafened ready connection and validates receive queue bounds', async () => {
		const harness = createHarness();
		const { connection } = await connectReady(harness);
		expect(() => connection.receive(OTHER_ID)).toThrowError(
			expect.objectContaining({
				code: 'VOICE_NOT_CONNECTED',
				metadata: expect.objectContaining({ reason: 'self-deafened' }),
			}),
		);

		const update = connection.setSelfState({ selfDeaf: false });
		harness.manager.enqueueGatewayDispatch(voiceStatePacket({ channelId: CHANNEL_ONE, selfDeaf: false }), 0);
		await flushGatewayWork();
		await update;
		expect(() => connection.receive(OTHER_ID, { maxBufferedPackets: 0 })).toThrowError(
			expect.objectContaining({ code: 'VOICE_INVALID_ARGUMENT' }),
		);
		await harness.manager.close();
	});

	test('waits for Gateway coordination and transport readiness before resolving connect', async () => {
		const harness = createHarness();
		const first = harness.manager.connect({ guildId: GUILD_ID, channelId: CHANNEL_ONE });
		const equivalent = harness.manager.connect({ guildId: GUILD_ID, channelId: CHANNEL_ONE });

		expect(equivalent).toBe(first);
		expect(harness.sent).toEqual([
			{
				op: GatewayOpcodes.VoiceStateUpdate,
				d: {
					guild_id: GUILD_ID,
					channel_id: CHANNEL_ONE,
					self_mute: false,
					self_deaf: true,
				},
			},
		]);
		expect(harness.manager.connections.size).toBe(1);
		expect('set' in harness.manager.connections).toBe(false);

		harness.manager.enqueueGatewayDispatch(voiceServerPacket(), 0);
		harness.manager.enqueueGatewayDispatch(voiceStatePacket({ channelId: CHANNEL_ONE }), 0);
		await flushGatewayWork();

		expect(harness.transports).toHaveLength(1);
		expect(harness.transports[0].input).toMatchObject({
			guildId: GUILD_ID,
			channelId: CHANNEL_ONE,
			userId: BOT_ID,
			sessionId: 'session-one',
			token: 'token-one',
			endpoint: 'voice.example.test',
		});
		expect(harness.manager.connections.get(GUILD_ID)?.state.status).toBe('connecting');

		harness.transports[0].readiness.resolve();
		const connection = await first;

		expect(connection.state.status).toBe('ready');
		expect(Object.isFrozen(connection.state)).toBe(true);
		expect(Object.isFrozen(connection.state.confirmed)).toBe(true);
		expect(harness.events.every(event => event.stateWasCommitted)).toBe(true);
	});

	test('captures Gateway observations before downstream handlers can mutate packets', async () => {
		const harness = createHarness();
		const connecting = harness.manager.connect({ guildId: GUILD_ID, channelId: CHANNEL_ONE });
		const serverPacket = voiceServerPacket('token-before-mutation');

		harness.manager.enqueueGatewayDispatch(serverPacket, 0);
		(serverPacket.d as { token: string }).token = 'token-after-mutation';
		harness.manager.enqueueGatewayDispatch(voiceStatePacket({ channelId: CHANNEL_ONE }), 0);
		await flushGatewayWork();

		expect(harness.transports[0].input.token).toBe('token-before-mutation');
		harness.transports[0].readiness.resolve();
		await connecting;
	});

	test('does not apply queued Gateway dispatches to a connection recreated by a terminal event', async () => {
		const harness = createHarness();
		const { connection } = await connectReady(harness);
		let reconnecting: Promise<VoiceConnection> | undefined;
		harness.client.events.emit = (name, _emittedConnection, next) => {
			if (name === 'voiceConnectionStateChange' && (next as { status?: unknown }).status === 'destroyed') {
				reconnecting = harness.manager.connect({ guildId: GUILD_ID, channelId: CHANNEL_ONE });
			}
		};
		harness.manager.enqueueGatewayDispatch(voiceStatePacket({ channelId: null }), 0);
		harness.manager.enqueueGatewayDispatch(voiceStatePacket({ channelId: null }), 0);
		await flushGatewayWork();

		expect(connection.state.status).toBe('destroyed');
		expect(reconnecting).toBeDefined();
		expect(harness.manager.connections.get(GUILD_ID)?.state.status).toBe('connecting');

		harness.manager.enqueueGatewayDispatch(voiceServerPacket('token-two'), 0);
		harness.manager.enqueueGatewayDispatch(voiceStatePacket({ channelId: CHANNEL_ONE, sessionId: 'session-two' }), 0);
		await flushGatewayWork();
		harness.transports.at(-1)!.readiness.resolve();

		await expect(reconnecting).resolves.toBe(harness.manager.connections.get(GUILD_ID));
	});

	test('requires explicit movement and preserves the stable connection identity', async () => {
		const harness = createHarness();
		const { connection, transport: firstTransport } = await connectReady(harness);

		await expect(harness.manager.connect({ guildId: GUILD_ID, channelId: CHANNEL_TWO })).rejects.toMatchObject({
			code: 'VOICE_MOVE_REQUIRED',
		});

		const moved = harness.manager.connect({ guildId: GUILD_ID, channelId: CHANNEL_TWO, move: true });
		harness.manager.enqueueGatewayDispatch(voiceStatePacket({ channelId: CHANNEL_TWO, sessionId: 'session-two' }), 0);
		harness.manager.enqueueGatewayDispatch(voiceServerPacket('token-two'), 0);
		await flushGatewayWork();

		expect(firstTransport.close).toHaveBeenCalledOnce();
		expect(harness.transports).toHaveLength(2);
		harness.transports[1].readiness.resolve();

		await expect(moved).resolves.toBe(connection);
		expect(connection.state).toMatchObject({ status: 'ready', confirmed: { channelId: CHANNEL_TWO } });
		expect(harness.manager.connections.get(GUILD_ID)).toBe(connection);
	});

	test('does not retain shared resources across a channel move', async () => {
		const order: string[] = [];
		const harness = createHarness(1_000, input => {
			if (input.sessionId === 'session-two') order.push('construct');
		});
		harness.transportFactory.retainResourcesForReplacement = () => {
			order.push('acquire');
			return () => order.push('release');
		};
		const { transport } = await connectReady(harness);
		transport.close.mockImplementation(async () => {
			order.push('close');
		});
		const moved = harness.manager.connect({ guildId: GUILD_ID, channelId: CHANNEL_TWO, move: true });

		harness.manager.enqueueGatewayDispatch(voiceStatePacket({ channelId: CHANNEL_TWO, sessionId: 'session-two' }), 0);
		harness.manager.enqueueGatewayDispatch(voiceServerPacket('token-two'), 0);
		await flushGatewayWork();

		expect(order).toEqual(['close', 'construct']);
		harness.transports[1].readiness.resolve();
		await expect(moved).resolves.toBeDefined();
	});

	test('retains shared resources for an immediate same-channel replacement', async () => {
		const order: string[] = [];
		const harness = createHarness(1_000, input => {
			if (input.sessionId === 'session-two') order.push('construct');
		});
		harness.transportFactory.retainResourcesForReplacement = () => {
			order.push('acquire');
			return () => order.push('release');
		};
		const { connection, transport } = await connectReady(harness);
		transport.close.mockImplementation(async () => {
			order.push('close');
		});

		harness.manager.enqueueGatewayDispatch(voiceServerPacket('token-two'), 0);
		harness.manager.enqueueGatewayDispatch(voiceStatePacket({ channelId: CHANNEL_ONE, sessionId: 'session-two' }), 0);
		await flushGatewayWork();

		expect(order).toEqual(['acquire', 'close', 'construct', 'release']);
		expect(connection.state.status).toBe('recovering');
		harness.transports[1].readiness.resolve();
		await flushGatewayWork();
		expect(connection.state.status).toBe('ready');
	});

	test.each([
		'close',
		'construct',
	] as const)('releases replacement resources when transport %s fails', async failure => {
		const order: string[] = [];
		const harness = createHarness(1_000, input => {
			if (failure === 'construct' && input.sessionId === 'session-two') {
				order.push('construct');
				throw new Error('replacement construction failed');
			}
		});
		harness.transportFactory.retainResourcesForReplacement = () => {
			order.push('acquire');
			return () => order.push('release');
		};
		const { connection, transport } = await connectReady(harness);
		transport.close.mockImplementation(async () => {
			order.push('close');
			if (failure === 'close') throw new Error('previous close failed');
		});

		harness.manager.enqueueGatewayDispatch(voiceServerPacket('token-two'), 0);
		harness.manager.enqueueGatewayDispatch(voiceStatePacket({ channelId: CHANNEL_ONE, sessionId: 'session-two' }), 0);
		await flushGatewayWork();

		expect(order).toEqual(
			failure === 'close' ? ['acquire', 'close', 'release'] : ['acquire', 'close', 'construct', 'release'],
		);
		expect(connection.state).toMatchObject({ status: 'destroyed', reason: 'terminal-failure' });
		expect(harness.manager.connections.has(GUILD_ID)).toBe(false);
	});

	test('retains same-channel resources across an endpoint-null gap and releases them after construction', async () => {
		const order: string[] = [];
		const harness = createHarness(1_000, input => {
			if (input.endpoint === 'voice-two.example.test') order.push('construct');
		});
		harness.transportFactory.retainResourcesForReplacement = () => {
			order.push('acquire');
			return () => order.push('release');
		};
		const { connection, transport } = await connectReady(harness);
		transport.close.mockImplementation(async () => {
			order.push('close');
		});

		harness.manager.enqueueGatewayDispatch(voiceServerPacket('unallocated', null), 0);
		await flushGatewayWork();
		expect(order).toEqual(['acquire', 'close']);
		expect(connection.state.status).toBe('recovering');

		harness.manager.enqueueGatewayDispatch(voiceServerPacket('token-two', 'voice-two.example.test'), 0);
		await flushGatewayWork();
		expect(order).toEqual(['acquire', 'close', 'construct', 'release']);
	});

	test('preserves a real DAVE identity across recovery but replaces it across a channel move', async () => {
		const daveFactory = createDaveSessionFactory();
		const signatureKeys: Uint8Array[] = [];
		const transportFactory: VoiceTransportFactory = (input, callbacks) => {
			const session = daveFactory(
				{ channelId: input.channelId, userId: input.userId },
				{
					sendJson: () => {},
					sendBinary: (opcode, payload) => {
						if (opcode !== 26) return;
						signatureKeys.push(decodeKeyPackage(payload).leafNode.signatureKey);
					},
					onReady: () => {},
					onRecovering: callbacks.onRecovering,
					onVoicePrivacyCodeChange: callbacks.onVoicePrivacyCodeChange,
				},
			);
			void session.setProtocolVersion(1);
			return {
				ready: Promise.resolve(),
				play: () => {
					const done = Promise.resolve();
					return VoicePlayback.create(done, () => done);
				},
				abortPlayback: () => {},
				close: async () => session.close(),
				getVerificationCode: userId => session.getVerificationCode(userId),
			};
		};
		transportFactory.retainResourcesForReplacement = () => daveFactory.retain();
		const harness = createHarness();
		const manager = VoiceManager.create({ operationTimeoutMs: 1_000 }, transportFactory);
		manager.attach(harness.client);

		const connected = manager.connect({ guildId: GUILD_ID, channelId: CHANNEL_ONE });
		manager.enqueueGatewayDispatch(voiceServerPacket(), 0);
		manager.enqueueGatewayDispatch(voiceStatePacket({ channelId: CHANNEL_ONE }), 0);
		await connected;
		const firstKey = signatureKeys[0];
		expect(firstKey).toBeDefined();

		manager.enqueueGatewayDispatch(voiceServerPacket('unallocated', null), 0);
		await flushGatewayWork();
		manager.enqueueGatewayDispatch(voiceServerPacket('token-two', 'voice-two.example.test'), 0);
		await flushGatewayWork();
		expect(signatureKeys[1]).toEqual(firstKey);

		const moved = manager.connect({ guildId: GUILD_ID, channelId: CHANNEL_TWO, move: true });
		manager.enqueueGatewayDispatch(voiceStatePacket({ channelId: CHANNEL_TWO, sessionId: 'session-two' }), 0);
		manager.enqueueGatewayDispatch(voiceServerPacket('token-three'), 0);
		await expect(moved).resolves.toBeDefined();
		expect(signatureKeys[2]).not.toEqual(firstKey);

		await manager.close();
		await daveFactory.close();
	});

	test('releases retained gap resources during manager teardown', async () => {
		const order: string[] = [];
		const harness = createHarness();
		harness.transportFactory.retainResourcesForReplacement = () => {
			order.push('acquire');
			return () => order.push('release');
		};
		const { transport } = await connectReady(harness);
		transport.close.mockImplementation(async () => {
			order.push('close');
		});

		harness.manager.enqueueGatewayDispatch(voiceServerPacket('unallocated', null), 0);
		await flushGatewayWork();
		expect(order).toEqual(['acquire', 'close']);

		await harness.manager.close();
		expect(order).toEqual(['acquire', 'close', 'release']);
	});

	test('releases a retained lease when teardown invalidates a pending transport close', async () => {
		const order: string[] = [];
		const close = new Deferred<void>();
		const harness = createHarness();
		harness.transportFactory.retainResourcesForReplacement = () => {
			order.push('acquire');
			return () => order.push('release');
		};
		const { transport } = await connectReady(harness);
		transport.close.mockImplementation(async () => {
			order.push('close');
			return close.promise;
		});

		harness.manager.enqueueGatewayDispatch(voiceServerPacket('token-two'), 0);
		harness.manager.enqueueGatewayDispatch(voiceStatePacket({ channelId: CHANNEL_ONE, sessionId: 'session-two' }), 0);
		await flushGatewayWork();
		expect(order).toEqual(['acquire', 'close']);

		const closing = harness.manager.close();
		expect(order).toEqual(['acquire', 'close', 'release']);
		close.resolve();
		await closing;
		expect(order).toEqual(['acquire', 'close', 'release']);
	});

	test('waits for a new session before applying a server update from an external channel move', async () => {
		const harness = createHarness();
		const { connection, transport: firstTransport } = await connectReady(harness);

		harness.manager.enqueueGatewayDispatch(voiceServerPacket('token-two'), 0);
		await flushGatewayWork();
		expect(harness.transports).toHaveLength(1);
		expect(connection.state.status).toBe('recovering');

		harness.manager.enqueueGatewayDispatch(voiceStatePacket({ channelId: CHANNEL_TWO, sessionId: 'session-two' }), 0);
		await flushGatewayWork();
		expect(firstTransport.close).toHaveBeenCalledOnce();
		expect(harness.transports).toHaveLength(2);
		expect(harness.transports[1].input).toMatchObject({ sessionId: 'session-two', token: 'token-two' });

		harness.transports[1].readiness.resolve();
		await flushGatewayWork();
		expect(connection.state).toMatchObject({ status: 'ready', confirmed: { channelId: CHANNEL_TWO } });
	});

	test('rejects an overridden initial intent while adopting Discord authoritative membership', async () => {
		const harness = createHarness();
		const rejected = harness.manager.connect({ guildId: GUILD_ID, channelId: CHANNEL_ONE }).catch(error => error);

		harness.manager.enqueueGatewayDispatch(voiceServerPacket(), 0);
		harness.manager.enqueueGatewayDispatch(voiceStatePacket({ channelId: CHANNEL_TWO, sessionId: 'session-two' }), 0);
		await flushGatewayWork();

		await expect(rejected).resolves.toMatchObject({
			code: 'VOICE_OPERATION_CONFLICT',
			metadata: expect.objectContaining({ reason: 'authoritative-state-overrode-intent' }),
		});
		expect(harness.transports).toHaveLength(1);
		harness.transports[0].readiness.resolve();
		await flushGatewayWork();

		expect(harness.manager.connections.get(GUILD_ID)?.state).toMatchObject({
			status: 'ready',
			confirmed: { channelId: CHANNEL_TWO },
		});
	});

	test('keeps the existing transport when Discord rejects an explicit move', async () => {
		const harness = createHarness();
		const { connection, transport } = await connectReady(harness);
		const rejected = harness.manager
			.connect({ guildId: GUILD_ID, channelId: CHANNEL_TWO, move: true })
			.catch(error => error);

		harness.manager.enqueueGatewayDispatch(voiceStatePacket({ channelId: CHANNEL_ONE }), 0);
		await flushGatewayWork();

		await expect(rejected).resolves.toMatchObject({ code: 'VOICE_OPERATION_CONFLICT' });
		expect(connection.state).toMatchObject({ status: 'ready', confirmed: { channelId: CHANNEL_ONE } });
		expect(transport.close).not.toHaveBeenCalled();
		expect(harness.transports).toHaveLength(1);

		transport.callbacks.onRecovering();
		transport.callbacks.onRecovered();
		expect(connection.state.status).toBe('ready');
	});

	test('does not let recovery of the previous transport complete a pending move', async () => {
		const harness = createHarness();
		const { connection, transport: firstTransport } = await connectReady(harness);
		firstTransport.callbacks.onRecovering();
		const moved = harness.manager.connect({ guildId: GUILD_ID, channelId: CHANNEL_TWO, move: true });

		firstTransport.callbacks.onRecovered();
		expect(connection.state).toMatchObject({ status: 'moving', target: { channelId: CHANNEL_TWO } });

		harness.manager.enqueueGatewayDispatch(voiceStatePacket({ channelId: CHANNEL_TWO, sessionId: 'session-two' }), 0);
		harness.manager.enqueueGatewayDispatch(voiceServerPacket('token-two'), 0);
		await flushGatewayWork();
		harness.transports[1].readiness.resolve();

		await expect(moved).resolves.toBe(connection);
		expect(connection.state).toMatchObject({ status: 'ready', confirmed: { channelId: CHANNEL_TWO } });
	});

	test('preserves recovery when Discord rejects a move through authoritative state', async () => {
		const harness = createHarness();
		const { connection, transport } = await connectReady(harness);
		transport.callbacks.onRecovering();
		const moved = harness.manager
			.connect({ guildId: GUILD_ID, channelId: CHANNEL_TWO, move: true })
			.catch(error => error);

		harness.manager.enqueueGatewayDispatch(voiceStatePacket({ channelId: CHANNEL_ONE }), 0);
		await flushGatewayWork();

		await expect(moved).resolves.toMatchObject({ code: 'VOICE_OPERATION_CONFLICT' });
		expect(connection.state).toMatchObject({ status: 'recovering', confirmed: { channelId: CHANNEL_ONE } });

		transport.callbacks.onRecovered();
		expect(connection.state).toMatchObject({ status: 'ready', confirmed: { channelId: CHANNEL_ONE } });
	});

	test('restores the current coordination data when sending a move intent fails', async () => {
		const harness = createHarness();
		const { connection, transport } = await connectReady(harness);
		harness.client.gateway.send = async () => false;

		await expect(
			harness.manager.connect({ guildId: GUILD_ID, channelId: CHANNEL_TWO, move: true }),
		).rejects.toMatchObject({ code: 'VOICE_CONNECTION_FAILED' });
		expect(connection.state).toMatchObject({ status: 'ready', confirmed: { channelId: CHANNEL_ONE } });

		transport.callbacks.onRecovering();
		transport.callbacks.onRecovered();
		expect(connection.state.status).toBe('ready');
	});

	test('preserves recovery and coordination when sending a move intent fails', async () => {
		const harness = createHarness();
		const { connection, transport } = await connectReady(harness);
		transport.callbacks.onRecovering();
		harness.client.gateway.send = async () => false;

		await expect(
			harness.manager.connect({ guildId: GUILD_ID, channelId: CHANNEL_TWO, move: true }),
		).rejects.toMatchObject({ code: 'VOICE_CONNECTION_FAILED' });
		expect(connection.state).toMatchObject({ status: 'recovering', confirmed: { channelId: CHANNEL_ONE } });

		transport.callbacks.onRecovered();
		expect(connection.state).toMatchObject({ status: 'ready', confirmed: { channelId: CHANNEL_ONE } });
	});

	test.each([
		{ outcome: 'vetoed', settleSend: (send: Deferred<boolean>) => send.resolve(false) },
		{ outcome: 'rejected', settleSend: (send: Deferred<boolean>) => send.reject(new Error('Gateway unavailable')) },
	])('recovers when a move send is $outcome after Discord confirms the target channel', async ({ settleSend }) => {
		const harness = createHarness();
		const { connection, transport } = await connectReady(harness);
		const send = new Deferred<boolean>();
		harness.client.gateway.send = () => send.promise;
		const moved = harness.manager
			.connect({ guildId: GUILD_ID, channelId: CHANNEL_TWO, move: true })
			.catch(error => error);

		harness.manager.enqueueGatewayDispatch(voiceStatePacket({ channelId: CHANNEL_TWO, sessionId: 'session-two' }), 0);
		await flushGatewayWork();
		settleSend(send);

		await expect(moved).resolves.toMatchObject({ code: 'VOICE_CONNECTION_FAILED' });
		expect(connection.state).toMatchObject({ status: 'recovering', confirmed: { channelId: CHANNEL_TWO } });
		expect(transport.close).not.toHaveBeenCalled();

		harness.manager.enqueueGatewayDispatch(voiceServerPacket('token-two'), 0);
		await flushGatewayWork();
		expect(harness.transports).toHaveLength(2);
		harness.transports[1].readiness.resolve();
		await flushGatewayWork();
		expect(connection.state).toMatchObject({ status: 'ready', confirmed: { channelId: CHANNEL_TWO } });
	});

	test('does not publish ready when a same-channel connect intent fails during recovery', async () => {
		const harness = createHarness();
		const { connection, transport } = await connectReady(harness);
		const sendResult = new Deferred<boolean>();
		harness.client.gateway.send = () => sendResult.promise;
		const updated = harness.manager.connect({ guildId: GUILD_ID, channelId: CHANNEL_ONE, selfMute: true });

		transport.callbacks.onRecovering();
		sendResult.resolve(false);

		await expect(updated).rejects.toMatchObject({ code: 'VOICE_CONNECTION_FAILED' });
		expect(connection.state).toMatchObject({ status: 'recovering', confirmed: { channelId: CHANNEL_ONE } });
	});

	test('reuses the current session only after Discord marks a failed-over server unavailable', async () => {
		const harness = createHarness();
		const { connection, transport: firstTransport } = await connectReady(harness);

		harness.manager.enqueueGatewayDispatch(voiceServerPacket('unallocated', null), 0);
		await flushGatewayWork();
		expect(firstTransport.close).toHaveBeenCalledOnce();
		expect(connection.state.status).toBe('recovering');

		harness.manager.enqueueGatewayDispatch(voiceServerPacket('token-two', 'voice-two.example.test'), 0);
		await flushGatewayWork();
		expect(harness.transports).toHaveLength(2);
		expect(harness.transports[1].input).toMatchObject({
			sessionId: 'session-one',
			token: 'token-two',
			endpoint: 'voice-two.example.test',
		});

		harness.transports[1].readiness.resolve();
		await flushGatewayWork();
		expect(connection.state.status).toBe('ready');
	});

	test('observes transport close failures while waiting for a fresh voice server', async () => {
		const harness = createHarness();
		const { connection, transport } = await connectReady(harness);
		const closeError = new Error('UDP close failed');
		transport.close.mockRejectedValueOnce(closeError);

		harness.manager.enqueueGatewayDispatch(voiceServerPacket('unallocated', null), 0);
		await flushGatewayWork();

		expect(connection.state.status).toBe('recovering');
		expect(harness.client.logger.warn).toHaveBeenCalledWith('@slipher/voice transport close', closeError);
	});

	test('confirms atomic self state updates without replacing transport', async () => {
		const harness = createHarness();
		const { connection } = await connectReady(harness);
		const updated = connection.setSelfState({ selfMute: true });

		expect(harness.sent.at(-1)?.d).toMatchObject({
			guild_id: GUILD_ID,
			channel_id: CHANNEL_ONE,
			self_mute: true,
			self_deaf: true,
		});
		harness.manager.enqueueGatewayDispatch(
			voiceStatePacket({ channelId: CHANNEL_ONE, selfMute: true, selfDeaf: true }),
			0,
		);
		await flushGatewayWork();

		await expect(updated).resolves.toBeUndefined();
		expect(connection.state).toMatchObject({ status: 'ready', confirmed: { selfMute: true, selfDeaf: true } });
		expect(harness.transports).toHaveLength(1);
	});

	test('requires an exact authoritative target before resolving a same-channel connect update', async () => {
		const harness = createHarness();
		const { connection } = await connectReady(harness);
		const rejected = harness.manager
			.connect({ guildId: GUILD_ID, channelId: CHANNEL_ONE, selfMute: true })
			.catch(error => error);

		harness.manager.enqueueGatewayDispatch(
			voiceStatePacket({ channelId: CHANNEL_ONE, selfMute: false, selfDeaf: true }),
			0,
		);
		await flushGatewayWork();
		await expect(rejected).resolves.toMatchObject({
			code: 'VOICE_OPERATION_CONFLICT',
			metadata: expect.objectContaining({ reason: 'authoritative-state-overrode-intent' }),
		});

		const accepted = harness.manager.connect({ guildId: GUILD_ID, channelId: CHANNEL_ONE, selfMute: true });
		harness.manager.enqueueGatewayDispatch(
			voiceStatePacket({ channelId: CHANNEL_ONE, selfMute: true, selfDeaf: true }),
			0,
		);
		await flushGatewayWork();

		await expect(accepted).resolves.toBe(connection);
		expect(connection.state).toMatchObject({ status: 'ready', confirmed: { selfMute: true } });
		expect(harness.transports).toHaveLength(1);
	});

	test('represents an early disconnect without inventing confirmed state', async () => {
		const harness = createHarness();
		const connecting = harness.manager.connect({ guildId: GUILD_ID, channelId: CHANNEL_ONE });
		const connectingResult = connecting.catch(error => error);
		const disconnected = harness.manager.disconnect(GUILD_ID);

		expect(harness.manager.connections.get(GUILD_ID)?.state).toMatchObject({
			status: 'disconnecting',
			confirmed: null,
		});
		await expect(connectingResult).resolves.toMatchObject({ code: 'VOICE_OPERATION_CONFLICT' });
		await flushGatewayWork();

		harness.manager.enqueueGatewayDispatch(voiceStatePacket({ channelId: CHANNEL_ONE }), 0);
		await flushGatewayWork();
		expect(harness.manager.connections.get(GUILD_ID)?.state).toMatchObject({
			status: 'disconnecting',
			confirmed: { channelId: CHANNEL_ONE },
		});
		expect(harness.sent.filter(payload => payload.d.channel_id === null).length).toBeGreaterThanOrEqual(2);

		harness.manager.enqueueGatewayDispatch(voiceStatePacket({ channelId: null }), 0);
		await flushGatewayWork();
		await expect(disconnected).resolves.toBeUndefined();
		expect(harness.manager.connections.has(GUILD_ID)).toBe(false);
	});

	test('removes an externally destroyed connection before publishing its terminal state', async () => {
		const harness = createHarness();
		const { connection } = await connectReady(harness);
		const observations: { registered: boolean; stateWasCommitted: boolean }[] = [];
		harness.client.events.emit = (name, ...args) => {
			if (name !== 'voiceConnectionStateChange') return;
			const emittedConnection = args[0] as VoiceConnection;
			const next = args[1];
			if ((next as { status?: unknown }).status !== 'destroyed') return;
			observations.push({
				registered: harness.manager.connections.has(emittedConnection.guildId),
				stateWasCommitted: emittedConnection.state === next,
			});
		};

		harness.manager.enqueueGatewayDispatch(voiceStatePacket({ channelId: null }), 0);
		await flushGatewayWork();

		expect(connection.state.status).toBe('destroyed');
		expect(observations).toEqual([{ registered: false, stateWasCommitted: true }]);
	});

	test('removes connections before publishing terminal states during manager close', async () => {
		const harness = createHarness();
		const { connection } = await connectReady(harness);
		const observations: { registered: boolean; stateWasCommitted: boolean }[] = [];
		harness.client.events.emit = (name, ...args) => {
			if (name !== 'voiceConnectionStateChange') return;
			const emittedConnection = args[0] as VoiceConnection;
			const next = args[1];
			if ((next as { status?: unknown }).status !== 'destroyed') return;
			observations.push({
				registered: harness.manager.connections.has(emittedConnection.guildId),
				stateWasCommitted: emittedConnection.state === next,
			});
		};

		await harness.manager.close();

		expect(connection.state.status).toBe('destroyed');
		expect(observations).toEqual([{ registered: false, stateWasCommitted: true }]);
	});

	test('continues an explicit disconnect when transport cleanup fails', async () => {
		const harness = createHarness();
		const { transport } = await connectReady(harness);
		const closeError = new Error('UDP close failed');
		transport.close.mockRejectedValueOnce(closeError);

		const disconnected = harness.manager.disconnect(GUILD_ID);
		await flushGatewayWork();

		expect(harness.client.logger.warn).toHaveBeenCalledWith('@slipher/voice transport close', closeError);
		expect(harness.sent.at(-1)?.d.channel_id).toBeNull();

		harness.manager.enqueueGatewayDispatch(voiceStatePacket({ channelId: null }), 0);
		await flushGatewayWork();
		await expect(disconnected).resolves.toBeUndefined();
		expect(harness.manager.connections.has(GUILD_ID)).toBe(false);
	});

	test.each([
		{ outcome: 'vetoed', sendLeave: async () => false },
		{
			outcome: 'rejected',
			sendLeave: async () => {
				throw new Error('Gateway unavailable');
			},
		},
	])('restores move coordination when a superseding disconnect is $outcome', async ({ sendLeave }) => {
		const harness = createHarness();
		const { connection, transport } = await connectReady(harness);
		harness.client.gateway.send = async (_shardId, payload) => {
			if (payload.d.channel_id === CHANNEL_TWO) return true;
			return sendLeave();
		};

		const moved = harness.manager
			.connect({ guildId: GUILD_ID, channelId: CHANNEL_TWO, move: true })
			.catch(error => error);
		const disconnected = harness.manager.disconnect(GUILD_ID).catch(error => error);

		await expect(moved).resolves.toMatchObject({
			code: 'VOICE_OPERATION_CONFLICT',
			metadata: expect.objectContaining({ supersededBy: 'disconnect' }),
		});
		await expect(disconnected).resolves.toMatchObject({ code: 'VOICE_CONNECTION_FAILED' });
		await flushGatewayWork();

		expect(transport.close).toHaveBeenCalledOnce();
		expect(connection.state).toMatchObject({ status: 'recovering', confirmed: { channelId: CHANNEL_ONE } });
		expect(harness.transports).toHaveLength(2);
		expect(harness.transports[1].input).toMatchObject({
			channelId: CHANNEL_ONE,
			sessionId: 'session-one',
			token: 'token-one',
		});

		harness.transports[1].readiness.resolve();
		await flushGatewayWork();
		expect(connection.state).toMatchObject({ status: 'ready', confirmed: { channelId: CHANNEL_ONE } });
	});

	test('restores move coordination when a superseding disconnect times out', async () => {
		vi.useFakeTimers();
		try {
			const harness = createHarness(25);
			const { connection } = await connectReady(harness);
			harness.client.gateway.send = async (_shardId, payload) => {
				if (payload.d.channel_id === CHANNEL_TWO) return true;
				return new Promise<boolean>(() => {});
			};

			const moved = harness.manager
				.connect({ guildId: GUILD_ID, channelId: CHANNEL_TWO, move: true })
				.catch(error => error);
			const disconnected = harness.manager.disconnect(GUILD_ID).catch(error => error);
			await vi.advanceTimersByTimeAsync(25);

			await expect(moved).resolves.toMatchObject({ code: 'VOICE_OPERATION_CONFLICT' });
			await expect(disconnected).resolves.toMatchObject({ code: 'VOICE_OPERATION_TIMEOUT' });
			expect(connection.state).toMatchObject({ status: 'recovering', confirmed: { channelId: CHANNEL_ONE } });
			expect(harness.transports).toHaveLength(2);
			expect(harness.transports[1].input).toMatchObject({
				channelId: CHANNEL_ONE,
				sessionId: 'session-one',
				token: 'token-one',
			});

			harness.transports[1].readiness.resolve();
			await flushGatewayWork();
			expect(connection.state).toMatchObject({ status: 'ready', confirmed: { channelId: CHANNEL_ONE } });
		} finally {
			vi.useRealTimers();
		}
	});

	test('updates DAVE verification observations before publishing their event', async () => {
		const harness = createHarness();
		const { connection, transport } = await connectReady(harness);
		const code = '123451234512345123451234512345';

		transport.callbacks.onVoicePrivacyCodeChange(code);

		expect(connection.voicePrivacyCode).toBe(code);
		const event = harness.events.at(-1)!;
		expect(event.name).toBe('voicePrivacyCodeChange');
		expect((event.args[0] as VoiceConnection).voicePrivacyCode).toBe(code);
		await expect(connection.getVerificationCode(OTHER_ID)).resolves.toHaveLength(45);
		await expect(connection.getVerificationCode(BOT_ID)).rejects.toMatchObject({ code: 'VOICE_INVALID_ARGUMENT' });
	});

	test('normalizes DAVE verification unavailability and failures at the public connection boundary', async () => {
		const harness = createHarness();
		const { connection, transport } = await connectReady(harness);

		await expect(connection.getVerificationCode(OTHER_ID)).rejects.toMatchObject({
			code: 'VOICE_VERIFICATION_UNAVAILABLE',
			metadata: { guildId: GUILD_ID, userId: OTHER_ID, status: 'ready', reason: 'dave_inactive' },
		});
		expect(transport.getVerificationCode).not.toHaveBeenCalled();

		transport.callbacks.onVoicePrivacyCodeChange('123451234512345123451234512345');
		const cause = new Error('participant left during verification');
		transport.getVerificationCode.mockRejectedValueOnce(cause);
		const failure = await connection.getVerificationCode(OTHER_ID).catch(error => error);

		expect(failure).toMatchObject({
			code: 'VOICE_VERIFICATION_UNAVAILABLE',
			metadata: { guildId: GUILD_ID, userId: OTHER_ID, status: 'ready', reason: 'derivation_failed' },
		});
		expect(failure.cause).toBe(cause);
	});

	test.each([
		'participant_not_present',
		'participant_changed',
	] as const)('maps the typed DAVE %s verification reason without exposing its internal cause', async reason => {
		const harness = createHarness();
		const { connection, transport } = await connectReady(harness);
		const internalCause = new Error('internal participant lookup detail');
		transport.callbacks.onVoicePrivacyCodeChange('123451234512345123451234512345');
		transport.getVerificationCode.mockRejectedValueOnce(new DaveVerificationError(reason, { cause: internalCause }));

		const failure = await connection.getVerificationCode(OTHER_ID).catch(error => error);

		expect(failure).toMatchObject({
			code: 'VOICE_VERIFICATION_UNAVAILABLE',
			metadata: { guildId: GUILD_ID, userId: OTHER_ID, status: 'ready', reason },
		});
		expect(failure.cause).toBeUndefined();
	});

	test('preserves the lower-level cause of a typed DAVE derivation failure', async () => {
		const harness = createHarness();
		const { connection, transport } = await connectReady(harness);
		const cause = new Error('scrypt failed');
		transport.callbacks.onVoicePrivacyCodeChange('123451234512345123451234512345');
		transport.getVerificationCode.mockRejectedValueOnce(new DaveVerificationError('derivation_failed', { cause }));

		const failure = await connection.getVerificationCode(OTHER_ID).catch(error => error);

		expect(failure).toMatchObject({
			code: 'VOICE_VERIFICATION_UNAVAILABLE',
			metadata: { guildId: GUILD_ID, userId: OTHER_ID, status: 'ready', reason: 'derivation_failed' },
		});
		expect(failure.cause).toBe(cause);
	});

	test('rejects DAVE verification while the connection is recovering', async () => {
		const harness = createHarness();
		const { connection, transport } = await connectReady(harness);
		transport.callbacks.onVoicePrivacyCodeChange('123451234512345123451234512345');
		transport.callbacks.onRecovering();

		await expect(connection.getVerificationCode(OTHER_ID)).rejects.toMatchObject({
			code: 'VOICE_VERIFICATION_UNAVAILABLE',
			metadata: {
				guildId: GUILD_ID,
				userId: OTHER_ID,
				status: 'recovering',
				reason: 'connection_not_ready',
			},
		});
		expect(transport.getVerificationCode).not.toHaveBeenCalled();
	});

	test('does not return a DAVE verification code after recovery starts', async () => {
		const harness = createHarness();
		const { connection, transport } = await connectReady(harness);
		const verification = new Deferred<string>();
		transport.callbacks.onVoicePrivacyCodeChange('123451234512345123451234512345');
		transport.getVerificationCode.mockReturnValueOnce(verification.promise);

		const result = connection.getVerificationCode(OTHER_ID);
		transport.callbacks.onRecovering();
		verification.resolve('123451234512345123451234512345123451234512345');

		await expect(result).rejects.toMatchObject({
			code: 'VOICE_VERIFICATION_UNAVAILABLE',
			metadata: {
				guildId: GUILD_ID,
				userId: OTHER_ID,
				status: 'recovering',
				reason: 'connection_not_ready',
			},
		});
	});

	test('preserves invalid-argument and destroyed verification errors', async () => {
		const harness = createHarness();
		const { connection, transport } = await connectReady(harness);
		transport.callbacks.onVoicePrivacyCodeChange('123451234512345123451234512345');

		await expect(connection.getVerificationCode('not-a-snowflake')).rejects.toMatchObject({
			code: 'VOICE_INVALID_ARGUMENT',
		});
		await expect(connection.getVerificationCode(BOT_ID)).rejects.toMatchObject({
			code: 'VOICE_INVALID_ARGUMENT',
			metadata: { guildId: GUILD_ID, userId: BOT_ID, reason: 'self-verification' },
		});

		await harness.manager.close();
		await expect(connection.getVerificationCode(OTHER_ID)).rejects.toMatchObject({
			code: 'VOICE_CONNECTION_DESTROYED',
		});
	});

	test('times out initial operations and destroys records without confirmed membership', async () => {
		vi.useFakeTimers();
		try {
			const harness = createHarness(25);
			const result = harness.manager.connect({ guildId: GUILD_ID, channelId: CHANNEL_ONE }).catch(error => error);
			await vi.advanceTimersByTimeAsync(25);

			await expect(result).resolves.toMatchObject({ code: 'VOICE_OPERATION_TIMEOUT' });
			expect(harness.manager.connections.has(GUILD_ID)).toBe(false);
			expect(harness.sent).toHaveLength(2);
			expect(harness.sent[0].d.channel_id).toBe(CHANNEL_ONE);
			expect(harness.sent[1].d.channel_id).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	test('restores the ready state when a move times out before Discord changes membership', async () => {
		vi.useFakeTimers();
		try {
			const harness = createHarness(25);
			const { connection, transport } = await connectReady(harness);
			const result = harness.manager
				.connect({ guildId: GUILD_ID, channelId: CHANNEL_TWO, move: true })
				.catch(error => error);

			await vi.advanceTimersByTimeAsync(25);

			await expect(result).resolves.toMatchObject({ code: 'VOICE_OPERATION_TIMEOUT' });
			expect(connection.state).toMatchObject({ status: 'ready', confirmed: { channelId: CHANNEL_ONE } });
			expect(transport.close).not.toHaveBeenCalled();

			transport.callbacks.onRecovering();
			transport.callbacks.onRecovered();
			expect(connection.state.status).toBe('ready');
		} finally {
			vi.useRealTimers();
		}
	});

	test('preserves recovery when a move times out before Discord changes membership', async () => {
		vi.useFakeTimers();
		try {
			const harness = createHarness(25);
			const { connection, transport } = await connectReady(harness);
			transport.callbacks.onRecovering();
			const result = harness.manager
				.connect({ guildId: GUILD_ID, channelId: CHANNEL_TWO, move: true })
				.catch(error => error);

			await vi.advanceTimersByTimeAsync(25);

			await expect(result).resolves.toMatchObject({ code: 'VOICE_OPERATION_TIMEOUT' });
			expect(connection.state).toMatchObject({ status: 'recovering', confirmed: { channelId: CHANNEL_ONE } });

			transport.callbacks.onRecovered();
			expect(connection.state).toMatchObject({ status: 'ready', confirmed: { channelId: CHANNEL_ONE } });
		} finally {
			vi.useRealTimers();
		}
	});

	test('restores retained session coordination when a recovering move times out without a transport', async () => {
		vi.useFakeTimers();
		try {
			const harness = createHarness(25);
			const { connection, transport } = await connectReady(harness);
			harness.manager.enqueueGatewayDispatch(voiceServerPacket('unallocated', null), 0);
			await flushGatewayWork();
			expect(transport.close).toHaveBeenCalledOnce();
			expect(connection.state.status).toBe('recovering');
			const moved = harness.manager
				.connect({ guildId: GUILD_ID, channelId: CHANNEL_TWO, move: true })
				.catch(error => error);

			await vi.advanceTimersByTimeAsync(25);

			await expect(moved).resolves.toMatchObject({ code: 'VOICE_OPERATION_TIMEOUT' });
			expect(connection.state).toMatchObject({ status: 'recovering', confirmed: { channelId: CHANNEL_ONE } });

			harness.manager.enqueueGatewayDispatch(voiceServerPacket('token-two', 'voice-two.example.test'), 0);
			await flushGatewayWork();
			expect(harness.transports).toHaveLength(2);
			expect(harness.transports[1].input).toMatchObject({
				channelId: CHANNEL_ONE,
				sessionId: 'session-one',
				token: 'token-two',
			});
		} finally {
			vi.useRealTimers();
		}
	});
});
