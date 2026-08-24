export class SlidingWindow {
	private readonly entries: number[] = [];
	private start = 0;
	private blockedUntil = 0;

	constructor(
		readonly limit: number,
		readonly perMs: number,
	) {}

	private prune(now: number): void {
		const threshold = now - this.perMs;
		while (this.start < this.entries.length && this.entries[this.start] <= threshold) this.start++;
		this.compact();
	}

	private compact(): void {
		if (this.start === 0 || (this.start < 1_024 && this.start * 2 < this.entries.length)) return;
		this.entries.splice(0, this.start);
		this.start = 0;
	}

	occupancy(now: number): number {
		this.prune(now);
		return this.entries.length - this.start;
	}

	record(now: number): void {
		this.prune(now);
		this.entries.push(now);
	}

	blockFor(delay: number, now = Date.now()): void {
		if (!Number.isFinite(delay) || delay <= 0) return;
		this.blockedUntil = Math.max(this.blockedUntil, now + delay);
	}

	remaining(now: number): number {
		return Math.max(0, this.limit - this.occupancy(now));
	}

	blockedFor(now: number): number {
		this.prune(now);
		const manualBlock = Math.max(0, this.blockedUntil - now);
		const size = this.entries.length - this.start;
		if (size < this.limit) return manualBlock;
		const releaseIndex = this.start + size - this.limit;
		return Math.max(manualBlock, 1, this.entries[releaseIndex] + this.perMs - now);
	}
}
