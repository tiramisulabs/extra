export type DurationInput = number | string;

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
]);

export class InvalidDurationError extends RangeError {
	constructor(input: DurationInput) {
		super(`Invalid duration: ${String(input)}`);
		this.name = 'InvalidDurationError';
	}
}

export function parseDuration(input: DurationInput): number {
	if (typeof input === 'number') {
		if (Number.isFinite(input) && input >= 0) return input;
		throw new InvalidDurationError(input);
	}

	const source = input.trim().toLowerCase();
	if (!source) throw new InvalidDurationError(input);

	const numeric = Number(source);
	if (Number.isFinite(numeric) && numeric >= 0) return numeric;

	let total = 0;
	let consumed = 0;
	const matcher = /\s*(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|sec|s|minutes?|min|m|hours?|hr|h|days?|d)\s*/gy;

	for (let match = matcher.exec(source); match; match = matcher.exec(source)) {
		consumed += match[0].length;
		total += Number(match[1]) * durationUnits.get(match[2]!)!;
	}

	if (consumed !== source.length || total < 0) throw new InvalidDurationError(input);
	return total;
}
