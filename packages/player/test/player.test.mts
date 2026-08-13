import type { VoicePlaybackSource } from '@slipher/voice';
import { describe, expect, test, vi } from 'vitest';
import { GuildPlayer, type GuildPlayerActions, type GuildPlayerController } from '../src/player';
import type {
	GuildPlayerState,
	MediaProviderOpenContext,
	MediaResource,
	MediaTimeline,
	MediaTrack,
	PlayerCustomEvents,
	PlayerQueueItem,
	PlayerTrackEndReason,
} from '../src/types';

function track(identifier: string, timeline: MediaTimeline = FINITE_TIMELINE): MediaTrack {
	return Object.freeze({ provider: 'test', identifier, title: identifier, timeline });
}

function createHarness(voiceAvailable = true, historyLimit = 100) {
	const opens: OpenRecord[] = [];
	const playbacks: FakePlayback[] = [];
	const events: EventRecord[] = [];
	const destroyed = vi.fn();
	const actions: GuildPlayerActions = {
		open: vi.fn(async (media, context) => {
			const source = new ControlledSource();
			const resource = {
				packets: source,
				close: vi.fn(async () => source.close()),
			};
			opens.push({ media, context, source, resource });
			return resource;
		}),
		play: vi.fn(source => {
			const playback = new FakePlayback(source);
			playbacks.push(playback);
			return playback.playback;
		}),
		emit: (name, ...args) =>
			events.push({ name, args, state: controller?.player.state, current: controller?.player.current }),
		onDestroy: destroyed,
	};
	let controller: GuildPlayerController | undefined;
	controller = GuildPlayer.create(GUILD_ID, actions, voiceAvailable, historyLimit);
	return { actions, controller, destroyed, events, opens, player: controller.player, playbacks };
}

async function flushWork(iterations = 12): Promise<void> {
	for (let index = 0; index < iterations; index++) await Promise.resolve();
}

describe('GuildPlayer', () => {
	test('serializes enqueue, exposes defensive queue snapshots, and advances once after natural completion', async () => {
		const harness = createHarness();
		const first = track('first');
		const second = track('second');
		const [firstItem, secondItem] = await harness.player.enqueue([first, second]);
		expect(harness.player.current).toBe(firstItem);
		expect(harness.player.queue).toEqual([secondItem]);
		const snapshot = harness.player.queue;
		await harness.player.clear();
		expect(snapshot).toEqual([secondItem]);

		await harness.player.enqueue(second);
		await flushWork();
		harness.playbacks[0]!.finish();
		await flushWork();
		expect(harness.player.current?.track.identifier).toBe(second.identifier);
		expect(harness.opens).toHaveLength(2);
		expect(trackEndReasons(harness.events)).toEqual(['finished']);
	});

	test('inserts a batch atomically at a pending queue position', async () => {
		const harness = createHarness();
		await harness.player.enqueue([track('current'), track('last')]);
		const inserted = await harness.player.enqueue([track('next'), track('after-next')], { position: 0 });

		expect(harness.player.current?.track.identifier).toBe('current');
		expect(harness.player.queue.map(item => item.track.identifier)).toEqual(['next', 'after-next', 'last']);
		expect(harness.player.queue.slice(0, 2)).toEqual(inserted);
	});

	test('fences a late playback rejection when voice becomes unavailable', async () => {
		const harness = createHarness();
		const first = await harness.player.enqueue(track('first'));
		const second = await harness.player.enqueue(track('second'));
		await flushWork();
		const lost = harness.controller.setVoiceAvailable(false);
		harness.playbacks[0]!.fail(new Error('transport lost'));
		await lost;
		await flushWork();

		expect(harness.player.current).toBeNull();
		expect(harness.player.queue).toEqual([second]);
		expect(harness.player.state).toEqual({ status: 'waiting', reason: 'voice-unavailable' });
		expect(trackEndReasons(harness.events)).toEqual(['connection-unavailable']);
		expect(harness.events.filter(event => event.name === 'playerTrackError')).toHaveLength(0);
		expect(first.track.identifier).toBe('first');

		await harness.controller.setVoiceAvailable(true);
		expect(harness.player.current).toBe(second);
		expect(harness.opens).toHaveLength(2);
	});

	test('skip and stop do not repeat tracks', async () => {
		const harness = createHarness();
		await expect(harness.player.skip()).resolves.toBeUndefined();
		await harness.player.setRepeat('track');
		await harness.player.enqueue([track('first'), track('second')]);
		await harness.player.skip();
		expect(harness.player.current?.track.identifier).toBe('second');
		expect(harness.player.queue).toEqual([]);
		await harness.player.stop();
		expect(harness.player.current).toBeNull();
		expect(harness.player.queue).toEqual([]);
		expect(trackEndReasons(harness.events)).toEqual(['skipped', 'stopped']);
	});

	test('skips the current track and the requested number of pending items', async () => {
		const harness = createHarness();
		await harness.player.enqueue([track('first'), track('second'), track('third'), track('fourth')]);
		await harness.player.skip(3);

		expect(harness.player.current?.track.identifier).toBe('fourth');
		expect(harness.player.queue).toEqual([]);
		expect(harness.player.history.map(entry => entry.item.track.identifier)).toEqual(['first']);
		expect(trackEndReasons(harness.events)).toEqual(['skipped']);
	});

	test('skips pending items while voice is unavailable without adding them to history', async () => {
		const harness = createHarness(false);
		await harness.player.enqueue([track('first'), track('second'), track('third')]);
		await harness.player.skip(2);

		expect(harness.player.current).toBeNull();
		expect(harness.player.queue.map(item => item.track.identifier)).toEqual(['third']);
		expect(harness.player.history).toEqual([]);
		expect(harness.player.state).toEqual({ status: 'waiting', reason: 'voice-unavailable' });
	});

	test('keeps bounded chronological history snapshots with explicit end reasons', async () => {
		const harness = createHarness(true, 2);
		const retainedMetadata = { payload: new Uint8Array(1_024) };
		const items = await harness.player.enqueue([track('first'), track('second'), track('third')], {
			metadata: retainedMetadata,
		});
		await flushWork();
		harness.playbacks[0]!.finish();
		await flushWork();
		await harness.player.skip();
		await harness.player.stop();

		const history = harness.player.history;
		expect(history.map(entry => [entry.item.track.identifier, entry.reason])).toEqual([
			['second', 'skipped'],
			['third', 'stopped'],
		]);
		expect(history[0]!.item).not.toBe(items[1]);
		expect(history[0]!.item.metadata).toBeUndefined();
		expect(Object.isFrozen(history)).toBe(true);
		expect(Object.isFrozen(history[0])).toBe(true);
		expect(Object.isFrozen(history[0]!.item)).toBe(true);
		expect(harness.player.previous).toBe(history.at(-1));

		await harness.player.clearHistory();
		expect(harness.player.history).toEqual([]);
		expect(harness.player.previous).toBeNull();
		expect(history).toHaveLength(2);
	});

	test('reports finite position from the seek offset and transmitted Opus duration', async () => {
		const harness = createHarness();
		await harness.player.enqueue(track('finite'));
		expect(harness.player.positionMs).toBe(0);
		await flushWork();
		harness.playbacks[0]!.advance(1_250);
		expect(harness.player.positionMs).toBe(1_250);

		await harness.player.seek(3_000);
		expect(harness.player.positionMs).toBe(3_000);
		await flushWork();
		harness.playbacks[1]!.advance(250);
		expect(harness.player.positionMs).toBe(3_250);

		harness.playbacks[1]!.finish();
		await flushWork();
		expect(harness.player.positionMs).toBeNull();
	});

	test('does not expose a finite position for live media', async () => {
		const harness = createHarness();
		await harness.player.enqueue(track('radio', { kind: 'live' }));
		await flushWork();
		harness.playbacks[0]!.advance(5_000);
		expect(harness.player.positionMs).toBeNull();
	});

	test('publishes terminal snapshots before track and queue end events', async () => {
		const harness = createHarness();
		await harness.player.enqueue(track('only'));
		await flushWork();
		harness.playbacks[0]!.finish();
		await flushWork();
		const names = harness.events.map(event => event.name);
		expect(names.indexOf('playerTrackEnd')).toBeLessThan(names.indexOf('playerQueueEnd'));
		const ended = harness.events.find(event => event.name === 'playerTrackEnd');
		expect(ended?.state).toEqual({ status: 'idle' });
		expect(ended?.current).toBeNull();
	});

	test('clear turns an unavailable waiting queue idle and ends it exactly once', async () => {
		const harness = createHarness(false);
		await harness.player.enqueue(track('waiting'));
		await harness.player.clear();
		expect(harness.player.state).toEqual({ status: 'idle' });
		expect(harness.events.filter(event => event.name === 'playerQueueEnd')).toHaveLength(1);
		await harness.player.clear();
		expect(harness.events.filter(event => event.name === 'playerQueueEnd')).toHaveLength(1);
	});

	test.each(['clear', 'stop', 'remove'] as const)('%s ends the last unavailable queued item', async operation => {
		const harness = createHarness(false);
		const item = await harness.player.enqueue(track('waiting'));
		if (operation === 'clear') await harness.player.clear();
		else if (operation === 'stop') await harness.player.stop();
		else await harness.player.remove(item.id);
		expect(harness.player.state).toEqual({ status: 'idle' });
		expect(harness.player.queue).toEqual([]);
		expect(harness.events.filter(event => event.name === 'playerQueueEnd')).toHaveLength(1);
	});

	test('track and queue repeat apply only after natural completion', async () => {
		const trackRepeat = createHarness();
		await trackRepeat.player.setRepeat('track');
		await trackRepeat.player.enqueue(track('first'));
		await flushWork();
		trackRepeat.playbacks[0]!.finish();
		await flushWork();
		expect(trackRepeat.player.current?.track.identifier).toBe('first');
		expect(trackRepeat.opens).toHaveLength(2);

		const queueRepeat = createHarness();
		await queueRepeat.player.setRepeat('queue');
		await queueRepeat.player.enqueue([track('first'), track('second')]);
		await flushWork();
		queueRepeat.playbacks[0]!.finish();
		await flushWork();
		expect(queueRepeat.player.current?.track.identifier).toBe('second');
		expect(queueRepeat.player.queue.map(item => item.track.identifier)).toEqual(['first']);
	});

	test('finite pause gates pulls and resume releases the gate', async () => {
		const harness = createHarness();
		await harness.player.enqueue(track('finite'));
		await flushWork();
		const iterator = harness.playbacks[0]!.source[Symbol.asyncIterator]();
		const first = iterator.next();
		harness.opens[0]!.source.push(Uint8Array.of(1));
		await expect(first).resolves.toEqual({ done: false, value: Uint8Array.of(1) });

		await harness.player.pause();
		let pulled = false;
		const gated = iterator.next().then(result => {
			pulled = true;
			return result;
		});
		harness.opens[0]!.source.push(Uint8Array.of(2));
		await flushWork();
		expect(pulled).toBe(false);
		await harness.player.resume();
		await flushWork();
		await expect(gated).resolves.toEqual({ done: false, value: Uint8Array.of(2) });
	});

	test('finite pause holds a packet whose pull was already pending', async () => {
		const harness = createHarness();
		await harness.player.enqueue(track('finite'));
		await flushWork();
		const iterator = harness.playbacks[0]!.source[Symbol.asyncIterator]();
		let delivered = false;
		const pending = iterator.next().then(result => {
			delivered = true;
			return result;
		});
		await harness.player.pause();
		harness.opens[0]!.source.push(Uint8Array.of(3));
		await flushWork();
		expect(delivered).toBe(false);
		await harness.player.resume();
		await expect(pending).resolves.toEqual({ done: false, value: Uint8Array.of(3) });
	});

	test('pause while loading is applied when the resource opens', async () => {
		const deferred = Promise.withResolvers<MediaResource>();
		const harness = createHarness();
		vi.mocked(harness.actions.open).mockReturnValueOnce(deferred.promise);
		await harness.player.enqueue(track('slow'));
		await harness.player.pause();
		expect(harness.player.state.status).toBe('paused');
		deferred.resolve(createResource());
		await flushWork();
		expect(harness.player.state.status).toBe('paused');
		await harness.player.resume();
		expect(harness.player.state.status).toBe('playing');
	});

	test('live pause closes the resource and resume reopens at the live edge', async () => {
		const harness = createHarness();
		await harness.player.enqueue(track('radio', { kind: 'live' }));
		await flushWork();
		const first = harness.opens[0]!;
		await harness.player.pause();
		expect(first.context.startAtMs).toBeUndefined();
		expect(first.resource.close).toHaveBeenCalledOnce();
		expect(harness.player.state.status).toBe('paused');

		await harness.player.resume();
		await flushWork();
		expect(harness.opens).toHaveLength(2);
		expect(harness.opens[1]!.context.startAtMs).toBeUndefined();
		expect(harness.player.state.status).toBe('playing');
		expect(harness.events.filter(event => event.name === 'playerTrackStart')).toHaveLength(1);
	});

	test('live pause aborts a pending open and resume starts from a fresh live edge', async () => {
		const deferred = Promise.withResolvers<MediaResource>();
		const harness = createHarness();
		let signal: AbortSignal | undefined;
		vi.mocked(harness.actions.open).mockImplementationOnce(async (_media, context) => {
			signal = context.signal;
			return deferred.promise;
		});
		await harness.player.enqueue(track('radio', { kind: 'live' }));
		await harness.player.pause();
		expect(signal?.aborted).toBe(true);
		expect(harness.player.state.status).toBe('paused');
		const stale = createResource();
		deferred.resolve(stale);
		await flushWork();
		expect(stale.close).toHaveBeenCalledOnce();

		await harness.player.resume();
		await flushWork();
		expect(harness.opens).toHaveLength(1);
		expect(harness.player.state.status).toBe('playing');
	});

	test('seek rejects unsupported timelines and reopens seekable media without another start event', async () => {
		const live = createHarness();
		await live.player.enqueue(track('radio', { kind: 'live' }));
		await expect(live.player.seek(100)).rejects.toMatchObject({ code: 'PLAYER_OPERATION_UNSUPPORTED' });

		const finite = createHarness();
		await finite.player.enqueue(track('finite'));
		await flushWork();
		await finite.player.seek(1_500);
		expect(finite.opens[0]!.resource.close).toHaveBeenCalledOnce();
		expect(finite.opens[1]!.context.startAtMs).toBe(1_500);
		expect(finite.events.filter(event => event.name === 'playerTrackStart')).toHaveLength(1);
	});

	test('seek while the initial resource is loading starts the item exactly once after reopening', async () => {
		const deferred = Promise.withResolvers<MediaResource>();
		const harness = createHarness();
		vi.mocked(harness.actions.open).mockReturnValueOnce(deferred.promise);
		await harness.player.enqueue(track('slow'));
		await harness.player.seek(2_000);
		await flushWork();
		expect(harness.opens).toHaveLength(1);
		expect(harness.opens[0]!.context.startAtMs).toBe(2_000);
		expect(harness.events.filter(event => event.name === 'playerTrackStart')).toHaveLength(1);
		const stale = createResource();
		deferred.resolve(stale);
		await flushWork();
		expect(stale.close).toHaveBeenCalledOnce();
		expect(harness.events.filter(event => event.name === 'playerTrackStart')).toHaveLength(1);
	});

	test('aborts an open operation on connection loss and ignores its late resource', async () => {
		const deferred = Promise.withResolvers<MediaResource>();
		const harness = createHarness();
		vi.mocked(harness.actions.open).mockImplementationOnce(async (_media, context) => {
			await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }));
			return deferred.promise;
		});
		const queued = harness.player.enqueue(track('slow'));
		await flushWork();
		const unavailable = harness.controller.setVoiceAvailable(false);
		await flushWork();
		const resource = createResource();
		deferred.resolve(resource);
		await queued;
		await unavailable;
		await flushWork();
		expect(resource.close).toHaveBeenCalledOnce();
		expect(harness.player.current).toBeNull();
		expect(trackEndReasons(harness.events)).toEqual(['connection-unavailable']);
	});

	test('advances after a provider throws synchronously while opening', async () => {
		const harness = createHarness();
		vi.mocked(harness.actions.open).mockImplementationOnce(() => {
			throw new Error('sync open failure');
		});
		await harness.player.enqueue([track('broken'), track('next')]);
		await flushWork();
		expect(harness.player.current?.track.identifier).toBe('next');
		expect(trackEndReasons(harness.events)).toEqual(['load-failed']);
		expect(harness.events.filter(event => event.name === 'playerTrackError')).toHaveLength(1);
	});

	test.each(['stop', 'destroy'] as const)('%s aborts a pending open without waiting for it', async operation => {
		const deferred = Promise.withResolvers<MediaResource>();
		const harness = createHarness();
		let signal: AbortSignal | undefined;
		vi.mocked(harness.actions.open).mockImplementationOnce(async (_media, context) => {
			signal = context.signal;
			return deferred.promise;
		});
		await harness.player.enqueue(track('slow'));
		const completed = operation === 'stop' ? harness.player.stop() : harness.player.destroy();
		await expect(completed).resolves.toBeUndefined();
		expect(signal?.aborted).toBe(true);
		const resource = createResource();
		deferred.resolve(resource);
		await flushWork();
		expect(resource.close).toHaveBeenCalledOnce();
	});

	test('validates tracks, empty batches, queue indexes, and repeat modes at the public boundary', async () => {
		const harness = createHarness(false);
		await expect(harness.player.enqueue([])).rejects.toMatchObject({ code: 'PLAYER_INVALID_ARGUMENT' });
		await expect(harness.player.enqueue({} as MediaTrack)).rejects.toMatchObject({ code: 'PLAYER_INVALID_ARGUMENT' });
		await expect(
			harness.player.enqueue(track('invalid-timeline', { kind: 'finite', durationMs: Number.NaN, seekable: true })),
		).rejects.toMatchObject({ code: 'PLAYER_INVALID_ARGUMENT' });
		const item = await harness.player.enqueue(track('queued'));
		await expect(harness.player.enqueue(track('before'), { position: -1 })).rejects.toMatchObject({
			code: 'PLAYER_INVALID_ARGUMENT',
		});
		await expect(harness.player.enqueue(track('after'), { position: 2 })).rejects.toMatchObject({
			code: 'PLAYER_INVALID_ARGUMENT',
		});
		await expect(harness.player.skip(0)).rejects.toMatchObject({ code: 'PLAYER_INVALID_ARGUMENT' });
		await expect(harness.player.skip(2)).rejects.toMatchObject({ code: 'PLAYER_INVALID_ARGUMENT' });
		await expect(harness.player.move(item.id, 1)).rejects.toMatchObject({ code: 'PLAYER_INVALID_ARGUMENT' });
		await expect(harness.player.setRepeat('invalid' as never)).rejects.toMatchObject({
			code: 'PLAYER_INVALID_ARGUMENT',
		});
	});

	test('owns an immutable track snapshot without freezing caller objects', async () => {
		const harness = createHarness(false);
		const timeline = { kind: 'finite', durationMs: 10_000, seekable: true } as const;
		const input: MediaTrack = { provider: 'test', identifier: 'before', title: 'Before', timeline };
		const item = await harness.player.enqueue(input);
		(input as { identifier: string }).identifier = 'after';
		(timeline as { seekable: boolean }).seekable = false;
		expect(item.track).not.toBe(input);
		expect(item.track.identifier).toBe('before');
		expect(item.track.timeline).toEqual({ kind: 'finite', durationMs: 10_000, seekable: true });
		expect(Object.isFrozen(item.track)).toBe(true);
		expect(Object.isFrozen(item.track.timeline)).toBe(true);
	});

	test('destroy is terminal, cleans up once, and notifies ownership once', async () => {
		const harness = createHarness();
		await harness.player.enqueue(track('first'));
		await flushWork();
		await Promise.all([harness.player.destroy(), harness.player.destroy()]);
		expect(harness.player.state).toEqual({ status: 'destroyed' });
		expect(harness.opens[0]!.resource.close).toHaveBeenCalledOnce();
		expect(harness.playbacks[0]!.stop).toHaveBeenCalledOnce();
		expect(harness.destroyed).toHaveBeenCalledExactlyOnceWith(harness.player);
		expect(harness.events.filter(event => event.name === 'playerQueueEnd')).toHaveLength(0);
		const ended = harness.events.find(event => event.name === 'playerTrackEnd');
		expect(ended?.state).toEqual({ status: 'destroyed' });
		expect(ended?.current).toBeNull();
		await expect(harness.player.enqueue(track('later'))).rejects.toMatchObject({ code: 'PLAYER_DESTROYED' });
	});

	test('destroy attempts every cleanup and reports failures after committing terminal state', async () => {
		const harness = createHarness();
		const stopFailure = new Error('stop failed');
		const closeFailure = new Error('close failed');
		await harness.player.enqueue(track('first'));
		await flushWork();
		harness.playbacks[0]!.stop.mockRejectedValueOnce(stopFailure);
		harness.opens[0]!.resource.close.mockRejectedValueOnce(closeFailure);

		await expect(harness.player.destroy()).rejects.toEqual(
			expect.objectContaining({ errors: [stopFailure, closeFailure] }),
		);
		expect(harness.playbacks[0]!.stop).toHaveBeenCalledOnce();
		expect(harness.opens[0]!.resource.close).toHaveBeenCalledOnce();
		expect(harness.player.state).toEqual({ status: 'destroyed' });
		expect(harness.destroyed).toHaveBeenCalledExactlyOnceWith(harness.player);
	});
});

class ControlledSource implements AsyncIterable<Uint8Array>, AsyncIterator<Uint8Array> {
	readonly #values: Uint8Array[] = [];
	readonly #waiters: Array<(result: IteratorResult<Uint8Array>) => void> = [];
	#closed = false;

	[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
		return this;
	}

	next(): Promise<IteratorResult<Uint8Array>> {
		const value = this.#values.shift();
		if (value) return Promise.resolve({ done: false, value });
		if (this.#closed) return Promise.resolve({ done: true, value: undefined });
		return new Promise(resolve => this.#waiters.push(resolve));
	}

	return(): Promise<IteratorResult<Uint8Array>> {
		this.close();
		return Promise.resolve({ done: true, value: undefined });
	}

	push(value: Uint8Array): void {
		const waiter = this.#waiters.shift();
		if (waiter) waiter({ done: false, value });
		else this.#values.push(value);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
	}
}

class FakePlayback {
	readonly source: VoicePlaybackSource;
	readonly #completion = Promise.withResolvers<void>();
	readonly stop = vi.fn(async () => this.#completion.resolve());
	readonly playback: {
		readonly done: Promise<void>;
		readonly playedDurationMs: number;
		stop(): Promise<void>;
	};
	#playedDurationMs = 0;

	constructor(source: VoicePlaybackSource) {
		this.source = source;
		const playback = this;
		this.playback = {
			done: this.#completion.promise,
			get playedDurationMs() {
				return playback.#playedDurationMs;
			},
			stop: this.stop,
		};
	}

	advance(durationMs: number): void {
		this.#playedDurationMs += durationMs;
	}

	finish(): void {
		this.#completion.resolve();
	}

	fail(error: unknown): void {
		this.#completion.reject(error);
	}
}

function createResource(): MediaResource & { readonly close: ReturnType<typeof vi.fn> } {
	return {
		packets: new ControlledSource(),
		close: vi.fn(async () => undefined),
	};
}

function trackEndReasons(events: readonly EventRecord[]): PlayerTrackEndReason[] {
	return events.filter(event => event.name === 'playerTrackEnd').map(event => event.args[2] as PlayerTrackEndReason);
}

const GUILD_ID = '200000000000000001';
const FINITE_TIMELINE = Object.freeze({ kind: 'finite', durationMs: 10_000, seekable: true } as const);

interface OpenRecord {
	readonly media: MediaTrack;
	readonly context: MediaProviderOpenContext;
	readonly source: ControlledSource;
	readonly resource: MediaResource & { readonly close: ReturnType<typeof vi.fn> };
}

interface EventRecord {
	readonly name: keyof PlayerCustomEvents;
	readonly args: readonly unknown[];
	readonly state?: GuildPlayerState;
	readonly current?: PlayerQueueItem | null;
}
