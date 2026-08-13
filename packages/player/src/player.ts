import type { VoicePlaybackSource } from '@slipher/voice';
import { PlayerError } from './errors';
import { createMediaTrack, snapshotMediaTrack } from './track';
import type {
	GuildPlayerState,
	MediaProviderOpenContext,
	MediaResource,
	MediaTrack,
	PlayerCustomEvents,
	PlayerEnqueueOptions,
	PlayerHistoryEntry,
	PlayerQueueItem,
	PlayerRepeatMode,
	PlayerTrackEndReason,
} from './types';

export class GuildPlayer {
	readonly guildId: string;
	readonly #actions: GuildPlayerActions;
	readonly #items: PlayerQueueItem[] = [];
	readonly #historyEntries: PlayerHistoryEntry[] = [];
	readonly #historyLimit: number;
	#state: GuildPlayerState = IDLE_STATE;
	#current: PlayerQueueItem | null = null;
	#repeatMode: PlayerRepeatMode = 'off';
	#voiceAvailable: boolean;
	#active: ActivePlayback | undefined;
	#opening: AbortController | undefined;
	#operation = Promise.resolve();
	#generation = 0;
	#nextItemId = 0;
	#destroyNotified = false;
	#pauseOnOpen = false;
	#currentStarted = false;
	#positionBaseMs = 0;

	private constructor(guildId: string, actions: GuildPlayerActions, voiceAvailable: boolean, historyLimit: number) {
		this.guildId = guildId;
		this.#actions = actions;
		this.#voiceAvailable = voiceAvailable;
		this.#historyLimit = historyLimit;
	}

	get state(): GuildPlayerState {
		return this.#state;
	}

	get current(): PlayerQueueItem | null {
		return this.#current;
	}

	get queue(): readonly PlayerQueueItem[] {
		return Object.freeze([...this.#items]);
	}

	get history(): readonly PlayerHistoryEntry[] {
		return Object.freeze([...this.#historyEntries]);
	}

	/** Most recently completed history entry. */
	get previous(): PlayerHistoryEntry | null {
		return this.#historyEntries.at(-1) ?? null;
	}

	/** Position in finite media based on Opus audio sent to Discord, or `null` for live media and no current item. */
	get positionMs(): number | null {
		if (!this.#current || this.#current.track.timeline.kind === 'live') return null;
		return this.#positionBaseMs + (this.#active?.playback.playedDurationMs ?? 0);
	}

	get repeatMode(): PlayerRepeatMode {
		return this.#repeatMode;
	}

	enqueue(track: MediaTrack, options?: PlayerEnqueueOptions): Promise<PlayerQueueItem>;
	enqueue(tracks: readonly MediaTrack[], options?: PlayerEnqueueOptions): Promise<readonly PlayerQueueItem[]>;
	enqueue(
		trackOrTracks: MediaTrack | readonly MediaTrack[],
		options: PlayerEnqueueOptions = {},
	): Promise<PlayerQueueItem | readonly PlayerQueueItem[]> {
		const many = Array.isArray(trackOrTracks);
		const tracks = many ? trackOrTracks : [trackOrTracks as MediaTrack];
		return this.mutate(() => {
			this.assertAlive();
			if (tracks.length === 0) {
				throw new PlayerError('PLAYER_INVALID_ARGUMENT', {
					metadata: { detail: 'At least one media track is required.' },
				});
			}
			const position = options.position ?? this.#items.length;
			if (!Number.isSafeInteger(position) || position < 0 || position > this.#items.length) {
				throw new PlayerError('PLAYER_INVALID_ARGUMENT', {
					metadata: {
						detail: 'A player enqueue position must be an index in the pending queue.',
						field: 'position',
						received: options.position,
					},
				});
			}
			const items = tracks.map(track => this.createItem(track, options.metadata));
			this.#items.splice(position, 0, ...items);
			this.startNextIfPossible();
			return many ? Object.freeze([...items]) : items[0]!;
		});
	}

	remove(id: string): Promise<PlayerQueueItem | undefined> {
		return this.mutate(() => {
			this.assertAlive();
			const index = this.#items.findIndex(item => item.id === id);
			if (index === -1) return undefined;
			const removed = this.#items.splice(index, 1)[0];
			this.finishQueueRemoval(1);
			return removed;
		});
	}

	move(id: string, index: number): Promise<void> {
		return this.mutate(() => {
			this.assertAlive();
			if (!Number.isSafeInteger(index) || index < 0 || index >= this.#items.length) {
				throw new PlayerError('PLAYER_INVALID_ARGUMENT', {
					metadata: { detail: 'A player queue index must identify an existing item.', index },
				});
			}
			const currentIndex = this.#items.findIndex(item => item.id === id);
			if (currentIndex === -1) {
				throw new PlayerError('PLAYER_INVALID_ARGUMENT', {
					metadata: { detail: `Player queue item ${id} does not exist.`, id },
				});
			}
			if (currentIndex === index) return;
			const [item] = this.#items.splice(currentIndex, 1);
			this.#items.splice(index, 0, item!);
		});
	}

	shuffle(): Promise<void> {
		return this.mutate(() => {
			this.assertAlive();
			for (let index = this.#items.length - 1; index > 0; index--) {
				const randomIndex = Math.floor(Math.random() * (index + 1));
				[this.#items[index], this.#items[randomIndex]] = [this.#items[randomIndex]!, this.#items[index]!];
			}
		});
	}

	clear(): Promise<void> {
		return this.mutate(() => {
			this.assertAlive();
			const removed = this.#items.length;
			this.#items.length = 0;
			this.finishQueueRemoval(removed);
		});
	}

	clearHistory(): Promise<void> {
		return this.mutate(() => {
			this.assertAlive();
			this.#historyEntries.length = 0;
		});
	}

	/** Ends the current item and bypasses additional pending items when `count` is greater than one. */
	skip(count = 1): Promise<void> {
		return this.mutate(async () => {
			this.assertAlive();
			if (!Number.isSafeInteger(count) || count < 1) {
				throw new PlayerError('PLAYER_INVALID_ARGUMENT', {
					metadata: { detail: 'A skip count must be a positive safe integer.', field: 'count', received: count },
				});
			}
			const available = this.#items.length + Number(this.#current !== null);
			if (available === 0 && count === 1) return;
			if (count > available) {
				throw new PlayerError('PLAYER_INVALID_ARGUMENT', {
					metadata: {
						detail: 'A skip count cannot exceed the current and pending queue.',
						field: 'count',
						received: count,
						available,
					},
				});
			}
			const pendingCount = count - Number(this.#current !== null);
			if (pendingCount > 0) this.#items.splice(0, pendingCount);
			if (!this.#current) {
				this.finishQueueRemoval(pendingCount);
				this.startNextIfPossible();
				return;
			}
			await this.endCurrent('skipped', false);
			this.startNextIfPossible();
		});
	}

	stop(): Promise<void> {
		return this.mutate(async () => {
			this.assertAlive();
			const removed = this.#items.length;
			this.#items.length = 0;
			if (this.#current) await this.endCurrent('stopped', false);
			else this.finishQueueRemoval(removed);
		});
	}

	pause(): Promise<void> {
		return this.mutate(async () => {
			this.assertAlive();
			const current = this.#current;
			if (!current || this.#state.status === 'paused') return;
			if (this.#state.status === 'loading') {
				if (current.track.timeline.kind === 'live') await this.closeActive();
				this.#pauseOnOpen = true;
				this.setState({ status: 'paused', item: current });
				return;
			}
			if (this.#state.status !== 'playing') return;
			if (current.track.timeline.kind === 'live') {
				await this.closeActive();
			} else {
				this.#active?.gate.pause();
			}
			if (this.#current === current) this.setState({ status: 'paused', item: current });
		});
	}

	resume(): Promise<void> {
		return this.mutate(async () => {
			this.assertAlive();
			const current = this.#current;
			if (!current || this.#state.status !== 'paused') return;
			if (!this.#voiceAvailable) {
				this.setState(WAITING_STATE);
				return;
			}
			if (this.#opening) {
				this.#pauseOnOpen = false;
				this.setState({ status: 'loading', item: current });
			} else if (current.track.timeline.kind === 'live') this.openCurrent();
			else {
				this.#active?.gate.resume();
				this.setState({ status: 'playing', item: current });
			}
		});
	}

	seek(positionMs: number): Promise<void> {
		return this.mutate(async () => {
			this.assertAlive();
			const current = this.#current;
			if (!current) {
				throw new PlayerError('PLAYER_OPERATION_UNSUPPORTED', {
					metadata: { detail: 'The player has no current track to seek.' },
				});
			}
			const timeline = current.track.timeline;
			if (timeline.kind !== 'finite' || !timeline.seekable) {
				throw new PlayerError('PLAYER_OPERATION_UNSUPPORTED', {
					metadata: { detail: 'The current track is not seekable.' },
				});
			}
			if (
				!Number.isFinite(positionMs) ||
				positionMs < 0 ||
				(timeline.durationMs !== null && positionMs > timeline.durationMs)
			) {
				throw new PlayerError('PLAYER_INVALID_ARGUMENT', {
					metadata: { detail: 'A seek position must be within the current track timeline.', positionMs },
				});
			}
			if (!this.#voiceAvailable) {
				throw new PlayerError('PLAYER_OPERATION_UNSUPPORTED', {
					metadata: { detail: 'The player cannot seek while voice is unavailable.' },
				});
			}
			const paused = this.#state.status === 'paused';
			await this.closeActive();
			this.openCurrent(positionMs, paused);
		});
	}

	setRepeat(mode: PlayerRepeatMode): Promise<void> {
		return this.mutate(() => {
			this.assertAlive();
			if (mode !== 'off' && mode !== 'track' && mode !== 'queue') {
				throw new PlayerError('PLAYER_INVALID_ARGUMENT', {
					metadata: { detail: 'A player repeat mode must be off, track, or queue.', mode },
				});
			}
			this.#repeatMode = mode;
		});
	}

	destroy(): Promise<void> {
		return this.mutate(async () => {
			if (this.#state.status === 'destroyed') return;
			this.#items.length = 0;
			const current = this.#current;
			const cleanupFailures = await this.closeActive();
			this.#current = null;
			this.#currentStarted = false;
			this.#voiceAvailable = false;
			if (current) this.recordHistory(current, 'destroyed');
			this.setState(DESTROYED_STATE);
			if (current) this.#actions.emit('playerTrackEnd', this, current, 'destroyed');
			if (!this.#destroyNotified) {
				this.#destroyNotified = true;
				this.#actions.onDestroy(this);
			}
			if (cleanupFailures.length === 1) throw cleanupFailures[0];
			if (cleanupFailures.length > 1) {
				throw new AggregateError(cleanupFailures, 'Failed to close player playback resources.');
			}
		});
	}

	private mutate<T>(operation: () => T | Promise<T>): Promise<T> {
		const result = this.#operation.then(operation, operation);
		this.#operation = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private assertAlive(): void {
		if (this.#state.status === 'destroyed') {
			throw new PlayerError('PLAYER_DESTROYED', { metadata: { guildId: this.guildId } });
		}
	}

	private createItem(track: MediaTrack, metadata: unknown): PlayerQueueItem {
		let snapshot: MediaTrack;
		try {
			snapshot = snapshotMediaTrack(track);
		} catch (error) {
			throw new PlayerError('PLAYER_INVALID_ARGUMENT', {
				cause: error,
				metadata: { detail: 'A queued media track contains invalid values.' },
			});
		}
		return Object.freeze({
			id: `${this.guildId}:${++this.#nextItemId}`,
			track: snapshot,
			...(metadata === undefined ? {} : { metadata }),
		});
	}

	private finishQueueRemoval(removed: number): void {
		if (removed === 0 || this.#current || this.#items.length > 0) return;
		this.setState(IDLE_STATE);
		this.#actions.emit('playerQueueEnd', this);
	}

	private recordHistory(item: PlayerQueueItem, reason: PlayerTrackEndReason): void {
		if (this.#historyLimit === 0) return;
		const historyItem = Object.freeze({ id: item.id, track: createMediaTrack(item.track) });
		this.#historyEntries.push(Object.freeze({ item: historyItem, reason }));
		const overflow = this.#historyEntries.length - this.#historyLimit;
		if (overflow > 0) this.#historyEntries.splice(0, overflow);
	}

	private async setVoiceAvailable(available: boolean): Promise<void> {
		if (this.#state.status === 'destroyed' || this.#voiceAvailable === available) return;
		this.#voiceAvailable = available;
		if (!available) {
			if (this.#current) await this.endCurrent('connection-unavailable', false);
			this.setState(this.#items.length > 0 ? WAITING_STATE : IDLE_STATE);
			return;
		}
		this.startNextIfPossible();
	}

	private startNextIfPossible(): void {
		if (this.#current || this.#state.status === 'destroyed') return;
		if (this.#items.length === 0) {
			this.setState(IDLE_STATE);
			return;
		}
		if (!this.#voiceAvailable) {
			this.setState(WAITING_STATE);
			return;
		}
		const item = this.#items.shift()!;
		this.#current = item;
		this.#currentStarted = false;
		this.#positionBaseMs = 0;
		this.openCurrent();
	}

	private openCurrent(startAtMs?: number, paused = false): void {
		const item = this.#current;
		if (!item) return;
		if (startAtMs !== undefined) this.#positionBaseMs = startAtMs;
		const generation = ++this.#generation;
		const abort = new AbortController();
		this.#pauseOnOpen = paused;
		this.#opening = abort;
		this.setState({ status: 'loading', item });
		void Promise.resolve()
			.then(() =>
				this.#actions.open(item.track, {
					signal: abort.signal,
					...(startAtMs === undefined ? {} : { startAtMs }),
				}),
			)
			.then(
				resource => this.resourceOpened(generation, item, abort, resource),
				error => this.resourceOpenFailed(generation, item, error),
			);
	}

	private resourceOpened(
		generation: number,
		item: PlayerQueueItem,
		abort: AbortController,
		resource: MediaResource,
	): Promise<void> {
		return this.mutate(async () => {
			if (generation !== this.#generation || this.#current !== item || !this.#voiceAvailable) {
				abort.abort();
				await closeUnownedResource(resource);
				return;
			}
			this.#opening = undefined;
			const paused = this.#pauseOnOpen;
			this.#pauseOnOpen = false;
			const gate = new PausablePlaybackSource(resource.packets);
			if (paused) gate.pause();
			let playback: PlayerPlayback;
			try {
				playback = this.#actions.play(gate);
			} catch (error) {
				abort.abort();
				gate.close();
				await closeUnownedResource(resource);
				this.#actions.emit('playerTrackError', this, item, error);
				await this.endCurrent('load-failed', false);
				this.startNextIfPossible();
				return;
			}
			this.#active = { generation, abort, resource, playback, gate };
			this.setState({ status: paused ? 'paused' : 'playing', item });
			if (!this.#currentStarted) {
				this.#currentStarted = true;
				this.#actions.emit('playerTrackStart', this, item);
			}
			void playback.done.then(
				() => this.playbackSettled(generation),
				error => this.playbackSettled(generation, error),
			);
		});
	}

	private resourceOpenFailed(generation: number, item: PlayerQueueItem, error: unknown): Promise<void> {
		return this.mutate(async () => {
			if (generation !== this.#generation || this.#current !== item) return;
			this.#opening = undefined;
			this.#actions.emit('playerTrackError', this, item, error);
			await this.endCurrent('load-failed', false);
			this.startNextIfPossible();
		});
	}

	private playbackSettled(generation: number, error?: unknown): Promise<void> {
		return this.mutate(async () => {
			const active = this.#active;
			const item = this.#current;
			if (!active || active.generation !== generation || !item) return;
			await this.closeActive(false);
			if (error !== undefined) {
				this.#actions.emit('playerTrackError', this, item, error);
				await this.endCurrent('load-failed', false);
			} else {
				await this.endCurrent('finished', true);
			}
			this.startNextIfPossible();
		});
	}

	private async endCurrent(reason: PlayerTrackEndReason, natural: boolean): Promise<void> {
		const item = this.#current;
		if (!item) return;
		await this.closeActive();
		this.#current = null;
		this.#currentStarted = false;
		if (natural && this.#repeatMode === 'track') this.#items.unshift(item);
		else if (natural && this.#repeatMode === 'queue') this.#items.push(item);
		this.recordHistory(item, reason);
		this.setState(this.#voiceAvailable || this.#items.length === 0 ? IDLE_STATE : WAITING_STATE);
		this.#actions.emit('playerTrackEnd', this, item, reason);
		if (this.#items.length === 0) this.#actions.emit('playerQueueEnd', this);
	}

	private async closeActive(stopPlayback = true): Promise<readonly unknown[]> {
		const active = this.#active;
		++this.#generation;
		this.#opening?.abort();
		this.#opening = undefined;
		this.#pauseOnOpen = false;
		if (!active) return [];
		this.#active = undefined;
		active.abort.abort();
		active.gate.close();
		const failures: unknown[] = [];
		if (stopPlayback) {
			try {
				await active.playback.stop();
			} catch (error) {
				failures.push(error);
			}
		}
		try {
			await active.resource.close();
		} catch (error) {
			failures.push(error);
		}
		return failures;
	}

	private setState(next: GuildPlayerState): void {
		if (sameState(this.#state, next)) return;
		const previous = this.#state;
		this.#state = Object.freeze(next);
		this.#actions.emit('playerStateChange', this, this.#state, previous);
	}

	/** @internal */
	static create(
		guildId: string,
		actions: GuildPlayerActions,
		voiceAvailable: boolean,
		historyLimit: number,
	): GuildPlayerController {
		const player = new GuildPlayer(guildId, actions, voiceAvailable, historyLimit);
		return {
			player,
			setVoiceAvailable: available => player.mutate(() => player.setVoiceAvailable(available)),
		};
	}
}

class PausablePlaybackSource implements VoicePlaybackSource {
	readonly #iterator: AsyncIterator<Uint8Array>;
	#resume: ReturnType<typeof Promise.withResolvers<void>> | undefined;
	#closed = false;
	#returned = false;

	constructor(source: VoicePlaybackSource) {
		this.#iterator = source[Symbol.asyncIterator]();
	}

	[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
		return this;
	}

	async next(): Promise<IteratorResult<Uint8Array>> {
		while (this.#resume && !this.#closed) await this.#resume.promise;
		if (this.#closed) return { done: true, value: undefined };
		const result = await this.#iterator.next();
		while (this.#resume && !this.#closed) await this.#resume.promise;
		if (this.#closed) return { done: true, value: undefined };
		return result;
	}

	async return(): Promise<IteratorResult<Uint8Array>> {
		this.close();
		if (!this.#iterator.return || this.#returned) return { done: true, value: undefined };
		this.#returned = true;
		return this.#iterator.return();
	}

	pause(): void {
		if (!this.#closed && !this.#resume) this.#resume = Promise.withResolvers<void>();
	}

	resume(): void {
		this.#resume?.resolve();
		this.#resume = undefined;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.resume();
	}
}

function sameState(previous: GuildPlayerState, next: GuildPlayerState): boolean {
	if (previous.status !== next.status) return false;
	if ('item' in previous && 'item' in next) return previous.item === next.item;
	if ('reason' in previous && 'reason' in next) return previous.reason === next.reason;
	return true;
}

async function closeUnownedResource(resource: MediaResource): Promise<void> {
	try {
		await resource.close();
	} catch {
		// The resource failed before ownership was committed, so cleanup cannot block the current player transition.
	}
}

const IDLE_STATE = Object.freeze({ status: 'idle' } as const);
const WAITING_STATE = Object.freeze({ status: 'waiting', reason: 'voice-unavailable' } as const);
const DESTROYED_STATE = Object.freeze({ status: 'destroyed' } as const);
interface ActivePlayback {
	readonly generation: number;
	readonly abort: AbortController;
	readonly resource: MediaResource;
	readonly playback: PlayerPlayback;
	readonly gate: PausablePlaybackSource;
}

interface PlayerPlayback {
	readonly done: Promise<void>;
	readonly playedDurationMs: number;
	stop(): Promise<void>;
}

/** @internal */
export interface GuildPlayerActions {
	open(track: MediaTrack, context: MediaProviderOpenContext): Promise<MediaResource>;
	play(source: VoicePlaybackSource): PlayerPlayback;
	emit<Event extends keyof PlayerCustomEvents>(event: Event, ...args: Parameters<PlayerCustomEvents[Event]>): void;
	onDestroy(player: GuildPlayer): void;
}

/** @internal */
export interface GuildPlayerController {
	readonly player: GuildPlayer;
	setVoiceAvailable(available: boolean): Promise<void>;
}
