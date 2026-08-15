import { VoiceConnection, type VoiceConnectionState } from '@slipher/voice';
import { describe, expect, test, vi } from 'vitest';
import { type GuildPlayer, PlayerManager } from '../src';
import type { MediaLoadResult, MediaProvider, MediaTrack } from '../src/types';

function createTrack(provider = 'custom', identifier = 'track'): MediaTrack {
	return Object.freeze({
		provider,
		identifier,
		title: identifier,
		timeline: Object.freeze({ kind: 'finite', durationMs: null, seekable: false }),
	});
}

function readyState(options: { selfMute?: boolean; suppress?: boolean } = {}): VoiceConnectionState {
	return {
		status: 'ready',
		confirmed: {
			channelId: CHANNEL_ID,
			mute: false,
			deaf: false,
			selfMute: options.selfMute ?? false,
			selfDeaf: true,
			suppress: options.suppress ?? false,
			requestToSpeakTimestamp: null,
		},
	};
}

function destroyedState(): VoiceConnectionState {
	return { status: 'destroyed', confirmed: readyState().confirmed, reason: 'external-disconnect' };
}

function createVoiceConnection(state: VoiceConnectionState = readyState()) {
	let currentState = state;
	const play = vi.fn(() => {
		const done = new Promise<void>(() => undefined);
		return { done, playedDurationMs: 0, stop: vi.fn(async () => undefined) };
	});
	const connection = Object.create(VoiceConnection.prototype, {
		guildId: { value: GUILD_ID, enumerable: true },
		state: { get: () => currentState },
		play: { value: play },
	}) as VoiceConnection;
	return { connection, play, setState: (next: VoiceConnectionState) => (currentState = next) };
}

function createProvider(name = 'custom') {
	const close = vi.fn(async () => undefined);
	const provider: MediaProvider = {
		name,
		resolve: vi.fn(
			async (query): Promise<MediaLoadResult | null> =>
				query === 'match' ? { kind: 'track', track: createTrack(name, query) } : null,
		),
		open: vi.fn(async () => ({
			packets: {
				async *[Symbol.asyncIterator]() {
					yield Uint8Array.of(0xf8, 0xff, 0xfe);
				},
			},
			close,
		})),
	};
	return { close, provider };
}

async function flushWork(iterations = 16): Promise<void> {
	for (let index = 0; index < iterations; index++) await Promise.resolve();
}

describe('PlayerManager', () => {
	test('owns one player per live connection and exposes a runtime read-only registry', async () => {
		const manager = PlayerManager.create();
		const first = createVoiceConnection();
		const player = manager.create(first.connection);

		expect(manager.create(first.connection)).toBe(player);
		expect(manager.get(GUILD_ID)).toBe(player);
		expect(player.positionMs).toBeNull();
		expect(() => (manager.players as Map<string, GuildPlayer>).clear()).toThrow();

		const second = createVoiceConnection();
		expect(() => manager.create(second.connection)).toThrowError(
			expect.objectContaining({ code: 'PLAYER_INVALID_ARGUMENT' }),
		);
		await player.destroy();
		expect(manager.get(GUILD_ID)).toBeUndefined();
		expect(manager.players.size).toBe(0);
		await manager.close();
	});

	test('rejects a voice connection that was already destroyed', async () => {
		const manager = PlayerManager.create();
		const destroyed = createVoiceConnection(destroyedState());

		expect(() => manager.create(destroyed.connection)).toThrowError(
			expect.objectContaining({ code: 'PLAYER_INVALID_ARGUMENT' }),
		);
		await manager.close();
	});

	test('validates the configured history bound before allocating players', () => {
		expect(() => PlayerManager.create({ historyLimit: -1 })).toThrowError(
			expect.objectContaining({ code: 'PLAYER_INVALID_ARGUMENT' }),
		);
		expect(() => PlayerManager.create({ historyLimit: 1.5 })).toThrowError(
			expect.objectContaining({ code: 'PLAYER_INVALID_ARGUMENT' }),
		);
	});

	test('rebinds a destroyed voice connection while preserving the player and queued work', async () => {
		const { provider } = createProvider();
		const manager = PlayerManager.create({ providers: [provider] });
		const first = createVoiceConnection({
			status: 'connecting',
			confirmed: null,
			target: { channelId: CHANNEL_ID, selfMute: false, selfDeaf: true },
		});
		const player = manager.create(first.connection);
		const queued = await player.enqueue(createTrack());
		expect(player.state).toEqual({ status: 'waiting', reason: 'voice-unavailable' });

		first.setState(destroyedState());
		const second = createVoiceConnection();
		expect(manager.create(second.connection)).toBe(player);
		const immediate = await player.enqueue(createTrack('custom', 'immediate'));
		await flushWork();
		expect(player.current).toBe(queued);
		expect(player.queue).toEqual([immediate]);
		expect(second.play).toHaveBeenCalledOnce();
		expect(first.play).not.toHaveBeenCalled();
		await manager.close();
	});

	test('fences playback from a destroyed connection when rebind wins the old state event race', async () => {
		const { close, provider } = createProvider();
		const manager = PlayerManager.create({ providers: [provider] });
		const first = createVoiceConnection();
		const guildPlayer = manager.create(first.connection);
		await guildPlayer.enqueue([createTrack('custom', 'current'), createTrack('custom', 'next')]);
		await flushWork();
		expect(first.play).toHaveBeenCalledOnce();

		first.setState(destroyedState());
		const replacement = createVoiceConnection();
		expect(manager.create(replacement.connection)).toBe(guildPlayer);
		manager.handleVoiceStateChange(first.connection, destroyedState());
		await flushWork();

		expect(first.play.mock.results[0]?.value.stop).toHaveBeenCalledOnce();
		expect(close).toHaveBeenCalledOnce();
		expect(replacement.play).toHaveBeenCalledOnce();
		expect(guildPlayer.current?.track.identifier).toBe('next');
		await manager.close();
	});

	test('routes only the current voice connection state and treats mute or suppression as unavailable', async () => {
		const { provider } = createProvider();
		const manager = PlayerManager.create({ providers: [provider] });
		const current = createVoiceConnection();
		const player = manager.create(current.connection);
		await player.enqueue(createTrack());

		manager.handleVoiceStateChange(current.connection, readyState({ selfMute: true }));
		await flushWork();
		expect(player.current).toBeNull();

		current.setState(destroyedState());
		const replacement = createVoiceConnection();
		manager.create(replacement.connection);
		manager.handleVoiceStateChange(current.connection, readyState());
		manager.handleVoiceStateChange(replacement.connection, readyState({ suppress: true }));
		await flushWork();
		expect(player.state.status).not.toBe('playing');
		await manager.close();
	});

	test.each([
		'synchronous',
		'asynchronous',
	] as const)('isolates %s Seyfert event and logger failures from player transitions', async mode => {
		const { provider } = createProvider();
		const manager = PlayerManager.create({ providers: [provider] });
		const eventError = new Error(`${mode} event failure`);
		const loggerError = new Error(`${mode} logger failure`);
		const emit = vi.fn(() => {
			if (mode === 'synchronous') throw eventError;
			return Promise.reject(eventError);
		});
		const warn = vi.fn(() => {
			if (mode === 'synchronous') throw loggerError;
			return Promise.reject(loggerError);
		});
		manager.attach({ events: { emit }, logger: { warn } });
		const guildPlayer = manager.create(createVoiceConnection().connection);

		await expect(guildPlayer.enqueue(createTrack())).resolves.toMatchObject({ track: { identifier: 'track' } });
		await flushWork();
		expect(emit).toHaveBeenCalled();
		expect(warn).toHaveBeenCalled();
		await manager.close();
	});

	test('logs and emits media failures that happen after enqueue resolves', async () => {
		const { provider } = createProvider();
		const failure = new Error('FFmpeg could not be started.');
		vi.mocked(provider.open).mockRejectedValueOnce(failure);
		const manager = PlayerManager.create({ providers: [provider] });
		const emit = vi.fn();
		const error = vi.fn();
		manager.attach({ events: { emit }, logger: { error, warn: vi.fn() } });
		const guildPlayer = manager.create(createVoiceConnection().connection);

		await expect(guildPlayer.enqueue(createTrack())).resolves.toMatchObject({ track: { identifier: 'track' } });
		await flushWork();

		expect(error).toHaveBeenCalledWith('@slipher/player failed to play a media track', failure);
		expect(emit).toHaveBeenCalledWith('playerTrackError', guildPlayer, expect.anything(), failure);
		expect(guildPlayer.history.at(-1)?.reason).toBe('load-failed');
		await manager.close();
	});

	test('resolves in provider order, supports explicit routing, and rejects duplicate provider names', async () => {
		const first = createProvider('first').provider;
		const second = createProvider('second').provider;
		vi.mocked(first.resolve!).mockResolvedValue(null);
		const manager = PlayerManager.create({ providers: [first, second] });

		await expect(manager.resolve('match')).resolves.toMatchObject({ kind: 'track', track: { provider: 'second' } });
		expect(first.resolve).toHaveBeenCalledBefore(vi.mocked(second.resolve!));
		await expect(manager.resolve('match', { provider: 'second' })).resolves.toMatchObject({ kind: 'track' });
		await expect(manager.resolve('match', { provider: '' })).rejects.toMatchObject({ code: 'PLAYER_INVALID_ARGUMENT' });
		await manager.close();

		expect(() => PlayerManager.create({ providers: [createProvider('file').provider] })).toThrowError(
			expect.objectContaining({ code: 'PLAYER_INVALID_ARGUMENT' }),
		);
	});

	test('fences resolve results after abort or manager teardown', async () => {
		const pending = Promise.withResolvers<MediaLoadResult | null>();
		const provider = createProvider().provider;
		vi.mocked(provider.resolve!).mockReturnValue(pending.promise);
		const manager = PlayerManager.create({ providers: [provider] });
		const abort = new AbortController();
		const resolving = manager.resolve('match', { provider: 'custom', signal: abort.signal });
		abort.abort(new Error('cancelled'));
		pending.resolve({ kind: 'track', track: createTrack() });
		await expect(resolving).rejects.toThrow('cancelled');

		const late = Promise.withResolvers<MediaLoadResult | null>();
		let shutdownSignal: AbortSignal | undefined;
		vi.mocked(provider.resolve!).mockImplementation((_query, context) => {
			shutdownSignal = context.signal;
			return late.promise;
		});
		const afterClose = manager.resolve('match', { provider: 'custom' });
		const closedResolution = expect(afterClose).rejects.toMatchObject({ code: 'PLAYER_DESTROYED' });
		await manager.close();
		expect(shutdownSignal?.aborted).toBe(true);
		await closedResolution;
		late.resolve({ kind: 'track', track: createTrack() });
	});

	test('finishes teardown ownership and reports a custom media cleanup failure', async () => {
		const cleanupFailure = new Error('custom resource close failed');
		const { close, provider } = createProvider();
		close.mockRejectedValueOnce(cleanupFailure);
		const manager = PlayerManager.create({ providers: [provider] });
		const guildPlayer = manager.create(createVoiceConnection().connection);
		await guildPlayer.enqueue(createTrack());
		await flushWork();

		await expect(manager.close()).rejects.toEqual(
			expect.objectContaining({ errors: expect.arrayContaining([cleanupFailure]) }),
		);
		expect(close).toHaveBeenCalledOnce();
		expect(guildPlayer.state).toEqual({ status: 'destroyed' });
		expect(manager.get(GUILD_ID)).toBeUndefined();
	});
});

const GUILD_ID = '200000000000000001';
const CHANNEL_ID = '300000000000000001';
