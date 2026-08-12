export type VoicePlaybackSource = AsyncIterable<Uint8Array>;

export class VoicePlayback {
	readonly done: Promise<void>;
	readonly #stopPlayback: () => Promise<void>;

	private constructor(done: Promise<void>, stopPlayback: () => Promise<void>) {
		this.done = done;
		this.#stopPlayback = stopPlayback;
	}

	stop(): Promise<void> {
		return this.#stopPlayback();
	}

	/** @internal */
	static create(done: Promise<void>, stopPlayback: () => Promise<void>): VoicePlayback {
		return new VoicePlayback(done, stopPlayback);
	}
}
