import { concatenateBytes } from '../bytes';
import type { VoiceCryptoProvider } from '../crypto/provider';
import { isOpusSilenceFrame } from '../media/opus';
import { deriveTreeSecret } from '../mls/crypto';
import { unrefTimer } from '../runtime/adapter';

const EMPTY = new Uint8Array();
const KEY_SIZE = 16;
const SECRET_SIZE = 32;
const TAG_SIZE = 8;
const NONCE_SIZE = 12;
const SUPPLEMENTAL_FIXED_SIZE = TAG_SIZE + 1 + 2;
const MAX_GENERATION_GAP = 250;
const MAX_MISSING_NONCES = 1_000;
const MAX_FRAMES_PER_SECOND = 170;
const GENERATION_NONCE_BITS = 24n;
const GENERATION_WRAP = 256;
const OLD_GENERATION_RETENTION_MS = 10_000;

interface DaveParsedAudioFrame {
	readonly sealed: Uint8Array;
	readonly truncatedNonce: number;
}

interface DaveDecryptorKey {
	readonly key: Uint8Array;
	expiresAt?: number;
}

/** @internal */
export class DaveAudioEncryptor {
	readonly #provider: VoiceCryptoProvider;
	#nextSecret: Uint8Array;
	#nextGeneration = 0;
	#key?: Uint8Array;
	#keyGeneration?: number;
	#frameCounter = 0n;
	#closed = false;

	constructor(provider: VoiceCryptoProvider, baseSecret: Uint8Array) {
		if (baseSecret.byteLength !== KEY_SIZE) {
			throw new TypeError('A DAVE sender ratchet base secret must contain 16 bytes.');
		}
		this.#provider = provider;
		this.#nextSecret = baseSecret.slice();
	}

	encrypt(frame: Uint8Array): Uint8Array {
		this.assertOpen();
		if (frame.byteLength === 0) throw new TypeError('A DAVE audio frame cannot be empty.');
		if (isOpusSilenceFrame(frame)) return frame.slice();
		this.#frameCounter++;
		const { generation, truncatedNonce } = resolveDaveNonce(this.#frameCounter);
		const key = this.getKey(generation);
		const nonce = new Uint8Array(NONCE_SIZE);
		new DataView(nonce.buffer).setUint32(NONCE_SIZE - 4, truncatedNonce, true);
		const ciphertext = this.#provider.aesGcmSeal(key, nonce, EMPTY, frame, TAG_SIZE);
		const encodedNonce = encodeUleb128(truncatedNonce);
		const supplementalSize = SUPPLEMENTAL_FIXED_SIZE + encodedNonce.byteLength;
		return concatenateBytes(ciphertext, encodedNonce, Uint8Array.of(supplementalSize, 0xfa, 0xfa));
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#nextSecret.fill(0);
		this.#key?.fill(0);
		this.#key = undefined;
	}

	private getKey(generation: number): Uint8Array {
		if (this.#keyGeneration === generation && this.#key) return this.#key;
		while (this.#nextGeneration <= generation) {
			const currentGeneration = this.#nextGeneration;
			const key = deriveTreeSecret(this.#provider, this.#nextSecret, 'key', currentGeneration, KEY_SIZE);
			const nextSecret = deriveTreeSecret(this.#provider, this.#nextSecret, 'secret', currentGeneration, SECRET_SIZE);
			this.#nextSecret.fill(0);
			this.#nextSecret = nextSecret;
			this.#nextGeneration++;
			if (currentGeneration === generation) {
				this.#key?.fill(0);
				this.#key = key;
				this.#keyGeneration = generation;
			} else {
				key.fill(0);
			}
		}
		if (!this.#key) throw new Error('The DAVE sender ratchet did not produce an encryption key.');
		return this.#key;
	}

	private assertOpen(): void {
		if (!this.#closed) return;
		throw new Error('The DAVE audio encryptor is closed.');
	}
}

/** @internal */
export class DaveAudioDecryptor {
	readonly #provider: VoiceCryptoProvider;
	readonly #now: () => number;
	readonly #createdAt: number;
	readonly #keys = new Map<number, DaveDecryptorKey>();
	readonly #missingNonces = new Set<bigint>();
	#nextSecret: Uint8Array;
	#nextGeneration = 0;
	#oldestGeneration = 0;
	#newestGeneration = 0;
	#newestProcessedNonce?: bigint;
	#expiryTimer?: ReturnType<typeof setTimeout>;
	#closed = false;

	constructor(provider: VoiceCryptoProvider, baseSecret: Uint8Array, now: () => number = Date.now) {
		if (baseSecret.byteLength !== KEY_SIZE) {
			throw new TypeError('A DAVE receiver ratchet base secret must contain 16 bytes.');
		}
		this.#provider = provider;
		this.#nextSecret = baseSecret.slice();
		this.#now = now;
		this.#createdAt = now();
	}

	decrypt(parsed: DaveParsedAudioFrame): Uint8Array | undefined {
		this.assertOpen();
		const announcedGeneration = parsed.truncatedNonce >>> 24;
		const generation = resolveWrappedGeneration(this.#oldestGeneration, announcedGeneration);
		const fullNonce = (BigInt(generation) << GENERATION_NONCE_BITS) | BigInt(parsed.truncatedNonce & 0x00ff_ffff);
		if (!this.canProcessNonce(fullNonce)) return undefined;
		const key = this.getKey(generation);
		if (!key) return undefined;
		const nonce = new Uint8Array(NONCE_SIZE);
		new DataView(nonce.buffer).setUint32(NONCE_SIZE - 4, parsed.truncatedNonce, true);
		let plaintext: Uint8Array;
		try {
			plaintext = this.#provider.aesGcmOpen(key, nonce, EMPTY, parsed.sealed, TAG_SIZE);
		} catch {
			return undefined;
		}
		this.reportSuccess(generation, fullNonce);
		return plaintext;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		if (this.#expiryTimer) clearTimeout(this.#expiryTimer);
		this.#expiryTimer = undefined;
		this.#nextSecret.fill(0);
		for (const entry of this.#keys.values()) entry.key.fill(0);
		this.#keys.clear();
		this.#missingNonces.clear();
	}

	private canProcessNonce(fullNonce: bigint): boolean {
		return (
			this.#newestProcessedNonce === undefined ||
			fullNonce > this.#newestProcessedNonce ||
			this.#missingNonces.has(fullNonce)
		);
	}

	private getKey(generation: number): Uint8Array | undefined {
		this.cleanupExpiredKeys();
		if (generation < this.#oldestGeneration || generation > this.#newestGeneration + MAX_GENERATION_GAP) {
			return undefined;
		}
		const lifetimeSeconds = Math.max(0, Math.floor((this.#now() - this.#createdAt) / 1_000));
		const maxLifetimeGeneration = Math.floor((MAX_FRAMES_PER_SECOND * lifetimeSeconds) / 2 ** 24);
		if (generation > maxLifetimeGeneration) return undefined;
		while (this.#nextGeneration <= generation) {
			const currentGeneration = this.#nextGeneration;
			const key = deriveTreeSecret(this.#provider, this.#nextSecret, 'key', currentGeneration, KEY_SIZE);
			const nextSecret = deriveTreeSecret(this.#provider, this.#nextSecret, 'secret', currentGeneration, SECRET_SIZE);
			this.#nextSecret.fill(0);
			this.#nextSecret = nextSecret;
			this.#nextGeneration++;
			this.#keys.set(
				currentGeneration,
				currentGeneration < this.#newestGeneration
					? { key, expiresAt: this.#now() + OLD_GENERATION_RETENTION_MS }
					: { key },
			);
		}
		this.scheduleExpiry();
		return this.#keys.get(generation)?.key;
	}

	private reportSuccess(generation: number, fullNonce: bigint): void {
		const newest = this.#newestProcessedNonce;
		if (newest === undefined) {
			this.#newestProcessedNonce = fullNonce;
		} else if (fullNonce > newest) {
			const missingCount = Number(
				fullNonce - newest - 1n > BigInt(MAX_MISSING_NONCES) ? BigInt(MAX_MISSING_NONCES) : fullNonce - newest - 1n,
			);
			while (this.#missingNonces.size + missingCount > MAX_MISSING_NONCES) {
				const oldest = this.#missingNonces.values().next().value;
				if (oldest === undefined) break;
				this.#missingNonces.delete(oldest);
			}
			for (let nonce = fullNonce - BigInt(missingCount); nonce < fullNonce; nonce++) {
				this.#missingNonces.add(nonce);
			}
			this.#newestProcessedNonce = fullNonce;
		} else {
			this.#missingNonces.delete(fullNonce);
		}

		if (generation <= this.#newestGeneration || !this.#keys.has(generation)) return;
		this.#newestGeneration = generation;
		const expiresAt = this.#now() + OLD_GENERATION_RETENTION_MS;
		for (const [keyGeneration, entry] of this.#keys) {
			if (keyGeneration >= generation) continue;
			entry.expiresAt = Math.min(entry.expiresAt ?? Number.POSITIVE_INFINITY, expiresAt);
		}
		this.scheduleExpiry();
	}

	private cleanupExpiredKeys(): void {
		const now = this.#now();
		for (const [generation, entry] of this.#keys) {
			if (entry.expiresAt === undefined || entry.expiresAt > now) continue;
			entry.key.fill(0);
			this.#keys.delete(generation);
		}
		while (this.#oldestGeneration < this.#newestGeneration && !this.#keys.has(this.#oldestGeneration)) {
			this.#oldestGeneration++;
		}
	}

	private scheduleExpiry(): void {
		if (this.#expiryTimer) clearTimeout(this.#expiryTimer);
		let nextExpiry = Number.POSITIVE_INFINITY;
		for (const entry of this.#keys.values()) {
			if (entry.expiresAt !== undefined) nextExpiry = Math.min(nextExpiry, entry.expiresAt);
		}
		if (!Number.isFinite(nextExpiry)) {
			this.#expiryTimer = undefined;
			return;
		}
		this.#expiryTimer = setTimeout(
			() => {
				this.#expiryTimer = undefined;
				this.cleanupExpiredKeys();
				this.scheduleExpiry();
			},
			Math.max(0, nextExpiry - this.#now()),
		);
		unrefTimer(this.#expiryTimer);
	}

	private assertOpen(): void {
		if (!this.#closed) return;
		throw new Error('The DAVE audio decryptor is closed.');
	}
}

/** @internal */
export function parseDaveAudioFrame(frame: Uint8Array): DaveParsedAudioFrame | undefined {
	if (frame.byteLength < SUPPLEMENTAL_FIXED_SIZE + 1) return undefined;
	if (frame[frame.byteLength - 2] !== 0xfa || frame[frame.byteLength - 1] !== 0xfa) return undefined;
	const supplementalSize = frame[frame.byteLength - 3] as number;
	if (supplementalSize < SUPPLEMENTAL_FIXED_SIZE + 1 || supplementalSize >= frame.byteLength) return undefined;
	const supplementalOffset = frame.byteLength - supplementalSize;
	const nonceOffset = supplementalOffset + TAG_SIZE;
	const nonceEnd = frame.byteLength - 3;
	const truncatedNonce = decodeUleb128(frame, nonceOffset, nonceEnd);
	if (truncatedNonce === undefined) return undefined;
	return {
		sealed: concatenateBytes(frame.subarray(0, supplementalOffset), frame.subarray(supplementalOffset, nonceOffset)),
		truncatedNonce,
	};
}

/** @internal */
export function resolveDaveNonce(frameCounter: bigint): {
	readonly generation: number;
	readonly truncatedNonce: number;
} {
	if (frameCounter <= 0n) throw new RangeError('A DAVE sender frame counter must be positive.');
	const generation = Number(frameCounter >> 24n);
	if (generation > 0xffff_ffff) throw new RangeError('The DAVE sender ratchet generation is exhausted.');
	return { generation, truncatedNonce: Number(frameCounter & 0xffff_ffffn) };
}

function encodeUleb128(value: number): Uint8Array {
	const bytes: number[] = [];
	let remaining = value >>> 0;
	do {
		let byte = remaining & 0x7f;
		remaining >>>= 7;
		if (remaining !== 0) byte |= 0x80;
		bytes.push(byte);
	} while (remaining !== 0);
	return Uint8Array.from(bytes);
}

function decodeUleb128(bytes: Uint8Array, offset: number, end: number): number | undefined {
	if (offset >= end || end - offset > 5) return undefined;
	let value = 0;
	let shift = 0;
	for (let index = offset; index < end; index++) {
		const byte = bytes[index] as number;
		const payload = byte & 0x7f;
		if (shift === 28 && payload > 0x0f) return undefined;
		value += payload * 2 ** shift;
		if ((byte & 0x80) === 0) return index + 1 === end ? value >>> 0 : undefined;
		shift += 7;
	}
	return undefined;
}

function resolveWrappedGeneration(oldest: number, announced: number): number {
	const remainder = oldest % GENERATION_WRAP;
	const factor = Math.floor(oldest / GENERATION_WRAP) + (announced < remainder ? 1 : 0);
	return factor * GENERATION_WRAP + announced;
}
