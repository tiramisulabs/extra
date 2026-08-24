export type VoicePlaybackSource = AsyncIterable<Uint8Array>;

export class VoicePlayback {
	readonly done: Promise<void>;
	readonly #getPlayedDurationMs: () => number;
	readonly #stopPlayback: () => Promise<void>;

	private constructor(done: Promise<void>, stopPlayback: () => Promise<void>, getPlayedDurationMs: () => number) {
		this.done = done;
		this.#stopPlayback = stopPlayback;
		this.#getPlayedDurationMs = getPlayedDurationMs;
	}

	/** Duration of source audio successfully sent to the voice transport. Closing silence is not included. */
	get playedDurationMs(): number {
		return this.#getPlayedDurationMs();
	}

	stop(): Promise<void> {
		return this.#stopPlayback();
	}

	/** @internal */
	static create(
		done: Promise<void>,
		stopPlayback: () => Promise<void>,
		getPlayedDurationMs: () => number,
	): VoicePlayback {
		return new VoicePlayback(done, stopPlayback, getPlayedDurationMs);
	}
}
