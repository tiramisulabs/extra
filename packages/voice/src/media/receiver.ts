import { VoiceError } from '../errors';

const DEFAULT_MAX_BUFFERED_PACKETS = 32;
const MAX_BUFFERED_PACKETS = 1_024;

export interface VoiceReceiveOptions {
	/**
	 * Maximum number of decoded Opus packets retained while the consumer is slower than the live stream.
	 * The oldest packet is dropped first. Defaults to 32.
	 */
	maxBufferedPackets?: number;
}

export interface VoiceReceivedPacket {
	readonly userId: string;
	readonly opus: Uint8Array;
	readonly sequence: number;
	readonly timestamp: number;
	readonly ssrc: number;
}

interface VoiceReceiveStreamController {
	readonly stream: VoiceReceiveStream;
	push(packet: VoiceReceivedPacket): void;
	close(): void;
}

/** A bounded live stream of complete encoded Opus packets from one Discord participant. */
export class VoiceReceiveStream implements AsyncIterableIterator<VoiceReceivedPacket> {
	readonly userId: string;
	readonly #maxBufferedPackets: number;
	readonly #onClose: () => void;
	readonly #queue: VoiceReceivedPacket[] = [];
	readonly #waiters: Array<(result: IteratorResult<VoiceReceivedPacket>) => void> = [];
	#closed = false;

	private constructor(userId: string, maxBufferedPackets: number, onClose: () => void) {
		this.userId = userId;
		this.#maxBufferedPackets = maxBufferedPackets;
		this.#onClose = onClose;
	}

	next(): Promise<IteratorResult<VoiceReceivedPacket>> {
		const packet = this.#queue.shift();
		if (packet) return Promise.resolve({ done: false, value: packet });
		if (this.#closed) return Promise.resolve({ done: true, value: undefined });
		return new Promise(resolve => this.#waiters.push(resolve));
	}

	return(): Promise<IteratorResult<VoiceReceivedPacket>> {
		this.close();
		return Promise.resolve({ done: true, value: undefined });
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const packet of this.#queue) packet.opus.fill(0);
		this.#queue.length = 0;
		for (const resolve of this.#waiters.splice(0)) resolve({ done: true, value: undefined });
		this.#onClose();
	}

	[Symbol.asyncIterator](): AsyncIterableIterator<VoiceReceivedPacket> {
		return this;
	}

	/** @internal */
	static create(userId: string, options: VoiceReceiveOptions, onClose: () => void): VoiceReceiveStreamController {
		const maxBufferedPackets = resolveMaxBufferedPackets(options.maxBufferedPackets);
		const stream = new VoiceReceiveStream(userId, maxBufferedPackets, onClose);
		return {
			stream,
			push(packet) {
				if (stream.#closed) return;
				const value = copyReceivedPacket(packet);
				const resolve = stream.#waiters.shift();
				if (resolve) {
					resolve({ done: false, value });
					return;
				}
				// This is live audio: bounded latency is more useful than replaying an ever-growing backlog.
				if (stream.#queue.length === stream.#maxBufferedPackets) stream.#queue.shift()?.opus.fill(0);
				stream.#queue.push(value);
			},
			close: () => stream.close(),
		};
	}
}

/** @internal */
export class VoiceAudioReceiver {
	readonly #subscriptions = new Map<string, Set<VoiceReceiveStreamController>>();
	#closed = false;

	subscribe(userId: string, options: VoiceReceiveOptions): VoiceReceiveStream {
		if (this.#closed) throw new Error('The voice audio receiver is closed.');
		if (!options || typeof options !== 'object') {
			throw new VoiceError('VOICE_INVALID_ARGUMENT', {
				metadata: { detail: 'Voice receive options must be an object.', field: 'options', received: options },
			});
		}
		const subscriptions = this.#subscriptions.get(userId) ?? new Set<VoiceReceiveStreamController>();
		let controller!: VoiceReceiveStreamController;
		controller = VoiceReceiveStream.create(userId, options, () => {
			subscriptions.delete(controller);
			if (subscriptions.size === 0) this.#subscriptions.delete(userId);
		});
		subscriptions.add(controller);
		this.#subscriptions.set(userId, subscriptions);
		return controller.stream;
	}

	push(packet: VoiceReceivedPacket): void {
		if (this.#closed) return;
		for (const subscription of this.#subscriptions.get(packet.userId) ?? []) subscription.push(packet);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		const subscriptions = [...this.#subscriptions.values()].flatMap(group => [...group]);
		this.#subscriptions.clear();
		for (const subscription of subscriptions) subscription.close();
	}
}

function resolveMaxBufferedPackets(value: number | undefined): number {
	if (value === undefined) return DEFAULT_MAX_BUFFERED_PACKETS;
	if (Number.isInteger(value) && value > 0 && value <= MAX_BUFFERED_PACKETS) return value;
	throw new VoiceError('VOICE_INVALID_ARGUMENT', {
		metadata: {
			detail: `maxBufferedPackets must be an integer from 1 through ${MAX_BUFFERED_PACKETS}.`,
			field: 'maxBufferedPackets',
			received: value,
		},
	});
}

function copyReceivedPacket(packet: VoiceReceivedPacket): VoiceReceivedPacket {
	return Object.freeze({ ...packet, opus: packet.opus.slice() });
}
