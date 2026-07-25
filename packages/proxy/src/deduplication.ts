import { createHash, type Hash } from 'node:crypto';
import type { RawFile } from 'seyfert';
import { isRecord } from './internal';
import type { WireApiRequest } from './protocol';

interface DeduplicationEntry<T> {
	readonly fingerprint: string;
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
	completedAt?: number;
}

export type DeduplicationClaim<T> =
	| {
			readonly kind: 'owner';
			complete(value: T): void;
			abort(value: T): void;
	  }
	| { readonly kind: 'duplicate'; readonly result: Promise<T> }
	| { readonly kind: 'conflict'; readonly message: string }
	| { readonly kind: 'capacity'; readonly message: string };

function stableJson(value: Record<string, unknown>): string {
	const serialized = JSON.stringify(value, (_key, nested) => {
		if (!isRecord(nested)) return nested;
		return Object.fromEntries(
			Object.keys(nested)
				.sort()
				.map(key => [key, nested[key]]),
		);
	});
	if (serialized === undefined) throw new TypeError('Fingerprint input must be JSON-serializable.');
	return serialized;
}

function fileBuffer(data: RawFile['data']): Buffer {
	if (typeof data === 'boolean' || typeof data === 'number' || typeof data === 'string') {
		return Buffer.from(String(data));
	}
	if (data instanceof ArrayBuffer) return Buffer.from(data);
	if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	return Buffer.from(data);
}

function updateFramed(hash: Hash, value: string | Buffer): void {
	const bytes = typeof value === 'string' ? Buffer.from(value) : value;
	hash.update(`${bytes.byteLength}:`);
	hash.update(bytes);
}

export function requestFingerprint(
	request: WireApiRequest,
	files: readonly RawFile[] | undefined,
	authorizationIdentity: string,
): string {
	const hash = createHash('sha256');
	updateFramed(hash, 'request');
	updateFramed(
		hash,
		stableJson({
			method: request.method,
			url: request.url,
			query: request.query,
			body: request.body,
			auth: request.auth !== false,
			reason: request.reason,
			appendToFormData: request.appendToFormData,
			authorizationIdentity,
		}),
	);
	for (const file of files ?? []) {
		updateFramed(hash, 'file');
		updateFramed(hash, stableJson({ key: file.key, filename: file.filename, contentType: file.contentType }));
		updateFramed(hash, fileBuffer(file.data));
	}
	return hash.digest('base64url');
}

export class RequestDeduplicator<T> {
	private readonly entries = new Map<string, DeduplicationEntry<T>>();

	constructor(
		private readonly ttl: number,
		private readonly maxEntries: number,
	) {}

	claim(serviceId: string, requestId: string, fingerprint: string, now = Date.now()): DeduplicationClaim<T> {
		this.prune(now);
		// Prefixing the first tuple member keeps concatenation injective without exposing delimiter constraints.
		const key = `${serviceId.length}:${serviceId}${requestId}`;
		const existing = this.entries.get(key);
		if (existing) {
			if (existing.fingerprint !== fingerprint) {
				return {
					kind: 'conflict',
					message: 'requestId was already used with a different request fingerprint.',
				};
			}
			return { kind: 'duplicate', result: existing.promise };
		}
		this.makeRoom();
		if (this.entries.size >= this.maxEntries) {
			return {
				kind: 'capacity',
				message: 'The deduplication registry is full of active requests.',
			};
		}

		let resolve!: (value: T) => void;
		const promise = new Promise<T>(done => {
			resolve = done;
		});
		const entry: DeduplicationEntry<T> = {
			fingerprint,
			promise,
			resolve,
		};
		this.entries.set(key, entry);
		let settled = false;
		return {
			kind: 'owner',
			complete: value => {
				if (settled) return;
				settled = true;
				entry.completedAt = Date.now();
				entry.resolve(value);
			},
			abort: value => {
				if (settled) return;
				settled = true;
				this.entries.delete(key);
				entry.resolve(value);
			},
		};
	}

	private prune(now: number): void {
		for (const [key, entry] of this.entries) {
			if (entry.completedAt !== undefined && entry.completedAt + this.ttl <= now) this.entries.delete(key);
		}
	}

	private makeRoom(): void {
		if (this.entries.size < this.maxEntries) return;
		let candidate: { key: string; completedAt: number } | undefined;
		for (const [key, entry] of this.entries) {
			if (entry.completedAt === undefined) continue;
			if (!candidate || entry.completedAt < candidate.completedAt) candidate = { key, completedAt: entry.completedAt };
		}
		if (candidate) this.entries.delete(candidate.key);
	}

	get size(): number {
		this.prune(Date.now());
		return this.entries.size;
	}
}
