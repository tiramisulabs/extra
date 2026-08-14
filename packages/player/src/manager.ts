import { VoiceConnection, type VoiceConnectionState } from '@slipher/voice';
import { PlayerError } from './errors';
import { GuildPlayer, type GuildPlayerController } from './player';
import { type BuiltinMediaProviderBundle, createBuiltinMediaProviderBundle } from './providers/builtin';
import { ReadonlyMapView } from './readonly-map';
import type {
	MediaLoadResult,
	MediaProvider,
	MediaProviderOpenContext,
	MediaResource,
	MediaTrack,
	PlayerCustomEvents,
	PlayerPluginOptions,
	PlayerResolveOptions,
} from './types';

function voiceCanPlay(state: VoiceConnectionState): boolean {
	return state.status === 'ready' && !state.confirmed.selfMute && !state.confirmed.suppress;
}

const DEFAULT_HISTORY_LIMIT = 100;

export class PlayerManager {
	readonly players: ReadonlyMap<string, GuildPlayer>;
	readonly #records = new Map<string, PlayerRecord>();
	readonly #playerValues = new Map<string, GuildPlayer>();
	readonly #providers = new Map<string, MediaProvider>();
	readonly #providerOrder: readonly MediaProvider[];
	readonly #builtins: BuiltinMediaProviderBundle;
	readonly #shutdown = new AbortController();
	readonly #historyLimit: number;
	#client?: PlayerManagerClient;
	#closed = false;
	#closePromise?: Promise<void>;

	private constructor(options: PlayerPluginOptions) {
		const historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
		if (!Number.isSafeInteger(historyLimit) || historyLimit < 0) {
			throw new PlayerError('PLAYER_INVALID_ARGUMENT', {
				metadata: {
					detail: 'The player history limit must be a non-negative safe integer.',
					field: 'historyLimit',
					received: historyLimit,
				},
			});
		}
		this.#historyLimit = historyLimit;
		this.#builtins = createBuiltinMediaProviderBundle({ ffmpegPath: options.ffmpegPath });
		this.#providerOrder = Object.freeze([...this.#builtins.providers, ...(options.providers ?? [])]);
		for (const provider of this.#providerOrder) this.registerProvider(provider);
		this.players = new ReadonlyMapView(this.#playerValues);
	}

	create(connection: VoiceConnection): GuildPlayer {
		this.assertOpen();
		if (!(connection instanceof VoiceConnection)) {
			throw new PlayerError('PLAYER_INVALID_ARGUMENT', {
				metadata: { detail: 'A guild player requires a VoiceConnection.', field: 'connection' },
			});
		}
		if (connection.state.status === 'destroyed') {
			throw new PlayerError('PLAYER_INVALID_ARGUMENT', {
				metadata: {
					detail: 'A guild player cannot bind to a destroyed voice connection.',
					guildId: connection.guildId,
				},
			});
		}

		const existing = this.#records.get(connection.guildId);
		if (existing) {
			if (existing.connection === connection) return existing.controller.player;
			if (existing.connection.state.status !== 'destroyed') {
				throw new PlayerError('PLAYER_INVALID_ARGUMENT', {
					metadata: {
						detail: 'A guild player is already bound to another live voice connection.',
						guildId: connection.guildId,
					},
				});
			}
			existing.connection = connection;
			this.updateVoiceAvailability(existing, false);
			this.updateVoiceAvailability(existing, voiceCanPlay(connection.state));
			return existing.controller.player;
		}

		let record!: PlayerRecord;
		const controller = GuildPlayer.create(
			connection.guildId,
			{
				open: (track, context) => this.open(track, context),
				play: source => record.connection.play(source),
				emit: (event, ...args) => this.emit(event, ...args),
				onDestroy: player => this.removePlayer(player),
			},
			voiceCanPlay(connection.state),
			this.#historyLimit,
		);
		record = { connection, controller };
		this.#records.set(connection.guildId, record);
		this.#playerValues.set(connection.guildId, controller.player);
		return controller.player;
	}

	get(guildId: string): GuildPlayer | undefined {
		return this.#playerValues.get(guildId);
	}

	async resolve(query: string, options: PlayerResolveOptions = {}): Promise<MediaLoadResult> {
		this.assertOpen();
		if (typeof query !== 'string' || !query.trim()) {
			throw new PlayerError('PLAYER_INVALID_ARGUMENT', {
				metadata: { detail: 'A media query must be a non-empty string.', field: 'query', received: query },
			});
		}
		if (!options || typeof options !== 'object') {
			throw new PlayerError('PLAYER_INVALID_ARGUMENT', {
				metadata: { detail: 'Player resolve options must be an object.', field: 'options', received: options },
			});
		}

		if (options.provider !== undefined && (typeof options.provider !== 'string' || !options.provider.trim())) {
			throw new PlayerError('PLAYER_INVALID_ARGUMENT', {
				metadata: {
					detail: 'A media provider name must be a non-empty string.',
					field: 'provider',
					received: options.provider,
				},
			});
		}
		const providers = options.provider === undefined ? this.#providerOrder : [this.requireProvider(options.provider)];
		const signal = options.signal ? AbortSignal.any([options.signal, this.#shutdown.signal]) : this.#shutdown.signal;
		for (const provider of providers) {
			if (!provider.resolve) continue;
			signal.throwIfAborted();
			const result = await waitForAbort(provider.resolve(query, { signal }), signal);
			signal.throwIfAborted();
			this.assertOpen();
			if (result) return result;
		}
		return { kind: 'empty' };
	}

	/** @internal */
	attach(client: PlayerManagerClient): void {
		if (this.#client === client) return;
		if (this.#client) {
			throw new PlayerError('PLAYER_INVALID_ARGUMENT', {
				metadata: {
					detail: 'A player plugin instance cannot be installed on more than one Seyfert client.',
					reason: 'plugin-instance-reused',
				},
			});
		}
		this.#client = client;
	}

	/** @internal */
	handleVoiceStateChange(connection: VoiceConnection, state: VoiceConnectionState): void {
		const record = this.#records.get(connection.guildId);
		if (!record || record.connection !== connection) return;
		this.updateVoiceAvailability(record, voiceCanPlay(state));
	}

	/** @internal */
	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#closed = true;
		this.#shutdown.abort(
			new PlayerError('PLAYER_DESTROYED', {
				metadata: { detail: 'The player manager is closed.' },
			}),
		);
		this.#closePromise = this.closeResources();
		return this.#closePromise;
	}

	/** @internal */
	static create(options: PlayerPluginOptions = {}): PlayerManager {
		return new PlayerManager(options);
	}

	private open(track: MediaTrack, context: MediaProviderOpenContext): Promise<MediaResource> {
		this.assertOpen();
		return this.requireProvider(track.provider).open(track, context);
	}

	private registerProvider(provider: MediaProvider): void {
		if (!provider || typeof provider !== 'object' || typeof provider.name !== 'string' || !provider.name.trim()) {
			throw new PlayerError('PLAYER_INVALID_ARGUMENT', {
				metadata: { detail: 'Every media provider must have a non-empty name.' },
			});
		}
		if (typeof provider.open !== 'function') {
			throw new PlayerError('PLAYER_INVALID_ARGUMENT', {
				metadata: { detail: `Media provider "${provider.name}" must implement open().`, provider: provider.name },
			});
		}
		if (this.#providers.has(provider.name)) {
			throw new PlayerError('PLAYER_INVALID_ARGUMENT', {
				metadata: {
					detail: `Media provider "${provider.name}" is registered more than once.`,
					provider: provider.name,
				},
			});
		}
		this.#providers.set(provider.name, provider);
	}

	private requireProvider(name: string): MediaProvider {
		const provider = this.#providers.get(name);
		if (provider) return provider;
		throw new PlayerError('PLAYER_PROVIDER_NOT_FOUND', {
			metadata: { detail: `Media provider "${name}" is not registered.`, provider: name },
		});
	}

	private updateVoiceAvailability(record: PlayerRecord, available: boolean): void {
		void record.controller
			.setVoiceAvailable(available)
			.catch(error => this.warn('@slipher/player voice availability', error));
	}

	private removePlayer(player: GuildPlayer): void {
		const record = this.#records.get(player.guildId);
		if (!record || record.controller.player !== player) return;
		this.#records.delete(player.guildId);
		if (this.#playerValues.get(player.guildId) === player) this.#playerValues.delete(player.guildId);
	}

	private emit<Event extends keyof PlayerCustomEvents>(
		event: Event,
		...args: Parameters<PlayerCustomEvents[Event]>
	): void {
		try {
			void Promise.resolve(this.#client?.events?.emit(event, ...args)).catch(error =>
				this.warn(`@slipher/player ${event}`, error),
			);
		} catch (error) {
			this.warn(`@slipher/player ${event}`, error);
		}
	}

	private warn(message: string, error: unknown): void {
		try {
			void Promise.resolve(this.#client?.logger?.warn(message, error)).catch(() => undefined);
		} catch {
			return;
		}
	}

	private async closeResources(): Promise<void> {
		const players = [...this.#playerValues.values()];
		const results = await Promise.allSettled([...players.map(player => player.destroy()), this.#builtins.close()]);
		this.#records.clear();
		this.#playerValues.clear();
		const errors = results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []));
		if (errors.length) throw new AggregateError(errors, 'Failed to close player resources.');
	}

	private assertOpen(): void {
		if (!this.#closed) return;
		throw new PlayerError('PLAYER_DESTROYED', {
			metadata: { detail: 'The player manager is closed.' },
		});
	}
}

interface PlayerRecord {
	connection: VoiceConnection;
	readonly controller: GuildPlayerController;
}

interface PlayerManagerEvents {
	emit(name: string, ...args: readonly unknown[]): unknown;
}

interface PlayerManagerLogger {
	warn(...args: readonly unknown[]): unknown;
}

interface PlayerManagerClient {
	events?: PlayerManagerEvents;
	logger?: PlayerManagerLogger;
}

function waitForAbort<Value>(pending: Promise<Value>, signal: AbortSignal): Promise<Value> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<Value>((resolve, reject) => {
		const aborted = () => reject(signal.reason);
		signal.addEventListener('abort', aborted, { once: true });
		void pending.then(
			value => {
				signal.removeEventListener('abort', aborted);
				resolve(value);
			},
			error => {
				signal.removeEventListener('abort', aborted);
				reject(error);
			},
		);
	});
}
