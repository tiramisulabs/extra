export type Awaitable<T> = T | Promise<T>;

export interface RateLimitStoreConsumeOptions {
	limit: number;
	window: number;
	cost: number;
	now: number;
}

export interface RateLimitStoreState {
	allowed: boolean;
	count: number;
	limit: number;
	remaining: number;
	resetAt: number;
	retryAfter: number;
}

export interface RateLimitStore {
	consume(key: string, options: RateLimitStoreConsumeOptions): Awaitable<RateLimitStoreState>;
	peek(key: string, options: Omit<RateLimitStoreConsumeOptions, 'cost'>): Awaitable<RateLimitStoreState>;
	reset(key: string): Awaitable<boolean>;
}

interface MemoryEntry {
	count: number;
	resetAt: number;
}

export class MemoryRateLimitStore implements RateLimitStore {
	readonly entries = new Map<string, MemoryEntry>();

	consume(key: string, options: RateLimitStoreConsumeOptions): RateLimitStoreState {
		const entry = this.getActiveEntry(key, options);
		const nextCount = entry.count + options.cost;
		const allowed = nextCount <= options.limit;

		if (allowed) entry.count = nextCount;

		this.entries.set(key, entry);
		return this.toState(entry, options.limit, allowed, options.now);
	}

	peek(key: string, options: Omit<RateLimitStoreConsumeOptions, 'cost'>): RateLimitStoreState {
		const entry = this.getActiveEntry(key, options);
		return this.toState(entry, options.limit, true, options.now);
	}

	reset(key: string): boolean {
		return this.entries.delete(key);
	}

	clear(): void {
		this.entries.clear();
	}

	cleanup(now = Date.now()): number {
		let deleted = 0;

		for (const [key, entry] of this.entries) {
			if (entry.resetAt > now) continue;
			this.entries.delete(key);
			deleted++;
		}

		return deleted;
	}

	private getActiveEntry(key: string, options: Omit<RateLimitStoreConsumeOptions, 'cost'>): MemoryEntry {
		const entry = this.entries.get(key);
		if (entry && entry.resetAt > options.now) return entry;

		return {
			count: 0,
			resetAt: options.now + options.window,
		};
	}

	private toState(entry: MemoryEntry, limit: number, allowed: boolean, now: number): RateLimitStoreState {
		return {
			allowed,
			count: entry.count,
			limit,
			remaining: Math.max(limit - entry.count, 0),
			resetAt: entry.resetAt,
			retryAfter: Math.max(entry.resetAt - now, 0),
		};
	}
}
