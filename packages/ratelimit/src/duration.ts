const durationPattern =
	/(-?\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|days?|w|weeks?)/gi;

const durationUnits = new Map<string, number>([
	['ms', 1],
	['millisecond', 1],
	['milliseconds', 1],
	['s', 1000],
	['sec', 1000],
	['second', 1000],
	['seconds', 1000],
	['m', 60_000],
	['min', 60_000],
	['minute', 60_000],
	['minutes', 60_000],
	['h', 3_600_000],
	['hr', 3_600_000],
	['hour', 3_600_000],
	['hours', 3_600_000],
	['d', 86_400_000],
	['day', 86_400_000],
	['days', 86_400_000],
	['w', 604_800_000],
	['week', 604_800_000],
	['weeks', 604_800_000],
]);

export type DurationInput = number | string;

export function parseDuration(value: DurationInput): number {
	if (typeof value === 'number') {
		if (!Number.isFinite(value) || value <= 0) throw new RangeError('Duration must be a positive finite number.');
		return value;
	}

	const normalized = value.trim();
	if (!normalized) throw new RangeError('Duration string cannot be empty.');

	const numeric = Number(normalized);
	if (Number.isFinite(numeric) && numeric > 0) return numeric;

	let total = 0;
	let lastIndex = 0;
	let matched = false;

	for (const match of normalized.matchAll(durationPattern)) {
		const gap = normalized.slice(lastIndex, match.index);
		if (gap.trim()) throw new RangeError(`Invalid duration segment: ${gap.trim()}`);

		matched = true;
		lastIndex = match.index + match[0].length;

		const amount = Number(match[1]);
		const unit = durationUnits.get(match[2].toLowerCase());

		if (!Number.isFinite(amount) || amount <= 0 || !unit) throw new RangeError(`Invalid duration segment: ${match[0]}`);

		total += amount * unit;
	}

	const tail = normalized.slice(lastIndex);
	if (tail.trim()) throw new RangeError(`Invalid duration segment: ${tail.trim()}`);
	if (!matched || total <= 0) throw new RangeError(`Invalid duration: ${value}`);

	return total;
}
