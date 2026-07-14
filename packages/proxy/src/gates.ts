export class SlidingWindow {
	private readonly entries: number[] = [];
	private start = 0;

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

	delay(now: number): number {
		return this.blockedFor(now);
	}

	record(now: number): void {
		this.prune(now);
		this.entries.push(now);
	}

	remaining(now: number): number {
		return Math.max(0, this.limit - this.occupancy(now));
	}

	blockedFor(now: number): number {
		this.prune(now);
		const size = this.entries.length - this.start;
		if (size < this.limit) return 0;
		const releaseIndex = this.start + size - this.limit;
		return Math.max(1, this.entries[releaseIndex] + this.perMs - now);
	}
}

export { SlidingWindow as InvalidRequestBudget };

export function isInteractionCallback(url: string): boolean {
	return /^\/interactions\/[^/]+\/[^/]+\/callback$/.test(url);
}
