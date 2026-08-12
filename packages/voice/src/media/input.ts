import type { VoicePlaybackSource } from './playback';

export type VoiceByteInput = Uint8Array | AsyncIterable<Uint8Array>;

/** @internal */
export class AsyncByteReader {
	readonly #iterator: AsyncIterator<Uint8Array>;
	readonly #chunks: Uint8Array[] = [];
	#chunkOffset = 0;
	#buffered = 0;
	#ended = false;
	#closed = false;
	#position = 0;

	constructor(input: VoiceByteInput) {
		if (input instanceof Uint8Array) {
			this.#iterator = singleChunk(input)[Symbol.asyncIterator]();
			return;
		}
		if (!input || typeof input[Symbol.asyncIterator] !== 'function') {
			throw new TypeError('A voice container input must be a Uint8Array or AsyncIterable of Uint8Array chunks.');
		}
		this.#iterator = input[Symbol.asyncIterator]();
	}

	get position(): number {
		return this.#position;
	}

	async readExactly(length: number): Promise<Uint8Array> {
		const value = await this.readExactlyOrEof(length);
		if (value) return value;
		throw new TypeError('The voice container ended before the current structure was complete.');
	}

	async readExactlyOrEof(length: number): Promise<Uint8Array | undefined> {
		if (!Number.isSafeInteger(length) || length < 0) throw new RangeError('A byte read length must be non-negative.');
		if (length === 0) return new Uint8Array();
		await this.fill(length);
		if (this.#buffered === 0 && this.#ended) return undefined;
		if (this.#buffered < length) {
			throw new TypeError('The voice container ended before the current structure was complete.');
		}
		const output = new Uint8Array(length);
		this.consume(length, output);
		return output;
	}

	async skip(length: number): Promise<void> {
		if (!Number.isSafeInteger(length) || length < 0) throw new RangeError('A byte skip length must be non-negative.');
		let remaining = length;
		while (remaining > 0) {
			if (this.#buffered === 0) await this.fill(1);
			if (this.#buffered === 0) {
				throw new TypeError('The voice container ended before the current structure was complete.');
			}
			const consumed = Math.min(remaining, this.#buffered);
			this.consume(consumed);
			remaining -= consumed;
		}
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		if (!this.#iterator.return) return;
		await this.#iterator.return();
	}

	private async fill(length: number): Promise<void> {
		while (!this.#ended && this.#buffered < length) {
			const result = await this.#iterator.next();
			if (result.done) {
				this.#ended = true;
				break;
			}
			if (!(result.value instanceof Uint8Array)) {
				throw new TypeError('A voice container source yielded a value that is not a Uint8Array.');
			}
			if (result.value.byteLength === 0) continue;
			const chunk = result.value.slice();
			this.#chunks.push(chunk);
			this.#buffered += chunk.byteLength;
		}
	}

	private consume(length: number, output?: Uint8Array): void {
		let remaining = length;
		let outputOffset = 0;
		while (remaining > 0) {
			const chunk = this.#chunks[0];
			if (!chunk) throw new Error('The byte reader buffer is inconsistent.');
			const available = chunk.byteLength - this.#chunkOffset;
			const count = Math.min(available, remaining);
			if (output) output.set(chunk.subarray(this.#chunkOffset, this.#chunkOffset + count), outputOffset);
			this.#chunkOffset += count;
			outputOffset += count;
			remaining -= count;
			this.#buffered -= count;
			this.#position += count;
			if (this.#chunkOffset === chunk.byteLength) {
				this.#chunks.shift();
				this.#chunkOffset = 0;
			}
		}
	}
}

function singleChunk(chunk: Uint8Array): VoicePlaybackSource {
	return {
		async *[Symbol.asyncIterator]() {
			yield chunk;
		},
	};
}
