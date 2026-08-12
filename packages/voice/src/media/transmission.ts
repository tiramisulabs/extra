import { getOpusPacketSamples, OPUS_SAMPLE_RATE, OPUS_SILENCE_FRAME, OPUS_SILENCE_SAMPLES } from './opus';
import { VoicePlayback, type VoicePlaybackSource } from './playback';

const SILENCE_FRAME_DURATION_MS = (OPUS_SILENCE_SAMPLES / OPUS_SAMPLE_RATE) * 1_000;
const SILENCE_FRAME_COUNT = 5;

export interface VoiceTransmissionOutput {
	now(): number;
	setSpeaking(speaking: boolean): void;
	sendFrame(frame: Uint8Array, samples: number): Promise<void>;
	advanceTimestamp(samples: number): void;
}

/** @internal */
export class VoiceAudioTransmission {
	readonly playback: VoicePlayback;
	readonly #iterator: AsyncIterator<Uint8Array>;
	readonly #output: VoiceTransmissionOutput;
	readonly #stopSignal = Promise.withResolvers<void>();
	readonly #abortSignal = Promise.withResolvers<never>();
	readonly #done: Promise<void>;
	#stopRequested = false;
	#returnRequested = false;
	#started = false;
	#settled = false;

	constructor(source: VoicePlaybackSource, output: VoiceTransmissionOutput) {
		if (!source || typeof source[Symbol.asyncIterator] !== 'function') {
			throw new TypeError('A voice playback source must be an AsyncIterable of Opus packets.');
		}
		this.#iterator = source[Symbol.asyncIterator]();
		this.#output = output;
		this.#done = this.run().finally(() => {
			this.#settled = true;
		});
		this.playback = VoicePlayback.create(this.#done, () => this.stop());
	}

	stop(): Promise<void> {
		if (this.#settled) return this.#done;
		if (!this.#stopRequested) {
			this.#stopRequested = true;
			this.#stopSignal.resolve();
			this.returnIterator();
		}
		return this.#done;
	}

	abort(error: unknown): void {
		if (this.#settled) return;
		this.#stopRequested = true;
		this.returnIterator();
		this.#abortSignal.reject(error);
	}

	private async run(): Promise<void> {
		let next = this.nextPacket();
		try {
			const initial = await Promise.race([
				next,
				this.#stopSignal.promise.then(() => ({ kind: 'stop' }) as const),
				this.#abortSignal.promise,
			]);
			if (initial.kind === 'stop') return;
			if (initial.kind === 'error') throw initial.error;
			if (initial.result.done) return;

			let packet = copyOpusPacket(initial.result.value);
			let samples = getOpusPacketSamples(packet);
			this.#output.setSpeaking(true);
			this.#started = true;
			let scheduledAt = this.#output.now();
			await this.#output.sendFrame(packet, samples);

			while (true) {
				const deadline = scheduledAt + samplesToMilliseconds(samples);
				next = this.nextPacket();
				const outcome = await this.waitUntilDeadline(next, deadline);
				if (outcome.kind === 'packet') {
					packet = copyOpusPacket(outcome.result.value);
					samples = getOpusPacketSamples(packet);
					if (await this.stopBefore(deadline)) {
						await this.finishSpeaking(deadline);
						return;
					}
					scheduledAt = deadline;
					await this.#output.sendFrame(packet, samples);
					continue;
				}

				const terminalAt = await this.finishSpeaking(deadline);
				if (outcome.kind === 'stop' || outcome.kind === 'done') return;
				if (outcome.kind === 'error') throw outcome.error;

				// Underflow is not end-of-stream: finish speaking cleanly, then resume this source when it yields again.
				const delayed = await Promise.race([
					next,
					this.#stopSignal.promise.then(() => ({ kind: 'stop' }) as const),
					this.#abortSignal.promise,
				]);
				if (delayed.kind === 'stop') return;
				if (delayed.kind === 'error') throw delayed.error;
				if (delayed.result.done) return;
				const resumeAt = this.#output.now();
				const elapsedSamples = Math.floor(Math.max(0, resumeAt - terminalAt) * (OPUS_SAMPLE_RATE / 1_000));
				if (elapsedSamples > 0) this.#output.advanceTimestamp(elapsedSamples);
				packet = copyOpusPacket(delayed.result.value);
				samples = getOpusPacketSamples(packet);
				this.#output.setSpeaking(true);
				scheduledAt = resumeAt;
				await this.#output.sendFrame(packet, samples);
			}
		} finally {
			if (this.#started) this.setSpeakingFalseQuietly();
		}
	}

	private nextPacket(): Promise<PacketOutcome> {
		return Promise.resolve()
			.then(() => this.#iterator.next())
			.then(
				result => ({ kind: 'result', result }) as const,
				error => ({ kind: 'error', error }) as const,
			);
	}

	private async waitUntilDeadline(next: Promise<PacketOutcome>, deadline: number): Promise<DeadlineOutcome> {
		const delay = Math.max(0, deadline - this.#output.now());
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadlineReached = new Promise<{ readonly kind: 'underflow' }>(resolve => {
			timer = setTimeout(() => resolve({ kind: 'underflow' }), delay);
		});
		try {
			const outcome = await Promise.race([
				next,
				deadlineReached,
				this.#stopSignal.promise.then(() => ({ kind: 'stop' }) as const),
				this.#abortSignal.promise,
			]);
			if (outcome.kind === 'underflow' || outcome.kind === 'stop' || outcome.kind === 'error') return outcome;
			if (outcome.result.done) return { kind: 'done' };
			return { kind: 'packet', result: { done: false, value: outcome.result.value } };
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	private async finishSpeaking(deadline: number): Promise<number> {
		for (let index = 0; index < SILENCE_FRAME_COUNT; index++) {
			await this.sleepUntil(deadline + index * SILENCE_FRAME_DURATION_MS);
			await this.#output.sendFrame(OPUS_SILENCE_FRAME, OPUS_SILENCE_SAMPLES);
		}
		const terminalAt = deadline + SILENCE_FRAME_COUNT * SILENCE_FRAME_DURATION_MS;
		await this.sleepUntil(terminalAt);
		this.#output.setSpeaking(false);
		this.#started = false;
		return terminalAt;
	}

	private async sleepUntil(deadline: number): Promise<void> {
		const delay = Math.max(0, deadline - this.#output.now());
		if (delay === 0) {
			await Promise.race([Promise.resolve(), this.#abortSignal.promise]);
			return;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const elapsed = new Promise<void>(resolve => {
			timer = setTimeout(resolve, delay);
		});
		try {
			await Promise.race([elapsed, this.#abortSignal.promise]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	private async stopBefore(deadline: number): Promise<boolean> {
		const delay = Math.max(0, deadline - this.#output.now());
		if (delay === 0) {
			await Promise.race([Promise.resolve(), this.#abortSignal.promise]);
			return this.#stopRequested;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const elapsed = new Promise<false>(resolve => {
			timer = setTimeout(() => resolve(false), delay);
		});
		try {
			return await Promise.race([elapsed, this.#stopSignal.promise.then(() => true), this.#abortSignal.promise]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	private returnIterator(): void {
		if (this.#returnRequested) return;
		this.#returnRequested = true;
		if (!this.#iterator.return) return;
		try {
			void Promise.resolve(this.#iterator.return()).catch(() => undefined);
		} catch {
			// Iterator cleanup is best effort and must not delay playback termination.
		}
	}

	private setSpeakingFalseQuietly(): void {
		try {
			this.#output.setSpeaking(false);
		} catch {
			// Preserve the source or transport failure that ended the transmission.
		}
		this.#started = false;
	}
}

type PacketOutcome =
	| { readonly kind: 'result'; readonly result: IteratorResult<Uint8Array> }
	| { readonly kind: 'error'; readonly error: unknown };

type DeadlineOutcome =
	| { readonly kind: 'packet'; readonly result: IteratorYieldResult<Uint8Array> }
	| { readonly kind: 'done' }
	| { readonly kind: 'underflow' }
	| { readonly kind: 'stop' }
	| { readonly kind: 'error'; readonly error: unknown };

function samplesToMilliseconds(samples: number): number {
	return (samples / OPUS_SAMPLE_RATE) * 1_000;
}

function copyOpusPacket(value: Uint8Array): Uint8Array {
	if (!(value instanceof Uint8Array))
		throw new TypeError('A voice playback source must yield Uint8Array Opus packets.');
	return value.slice();
}
