export type Awaitable<T> = T | Promise<T>;

export interface LockStoreResult {
	acquired: boolean;
	expiresAt: number;
}

export interface LockStore {
	acquire(key: string, token: string, ttl: number, now: number): Awaitable<LockStoreResult>;
	release(key: string, token: string): Awaitable<boolean>;
	extend(key: string, token: string, ttl: number, now: number): Awaitable<boolean>;
}

interface MemoryLockEntry {
	token: string;
	expiresAt: number;
}

export class MemoryLockStore implements LockStore {
	private readonly entries = new Map<string, MemoryLockEntry>();

	get size(): number {
		return this.entries.size;
	}

	acquire(key: string, token: string, ttl: number, now: number): LockStoreResult {
		const entry = this.entries.get(key);
		if (entry && entry.expiresAt > now) return { acquired: false, expiresAt: entry.expiresAt };

		const expiresAt = now + ttl;
		this.entries.set(key, { token, expiresAt });
		return { acquired: true, expiresAt };
	}

	release(key: string, token: string): boolean {
		const entry = this.entries.get(key);
		if (!entry || entry.token !== token) return false;

		this.entries.delete(key);
		return true;
	}

	extend(key: string, token: string, ttl: number, now: number): boolean {
		const entry = this.entries.get(key);
		if (!entry || entry.token !== token || entry.expiresAt <= now) return false;

		entry.expiresAt = now + ttl;
		return true;
	}

	clear(): void {
		this.entries.clear();
	}

	cleanup(now = Date.now()): number {
		let deleted = 0;

		for (const [key, entry] of this.entries) {
			if (entry.expiresAt > now) continue;
			this.entries.delete(key);
			deleted++;
		}

		return deleted;
	}
}
