export interface CronParts {
	minutes: Set<number>;
	hours: Set<number>;
	daysOfMonth: Set<number>;
	months: Set<number>;
	daysOfWeek: Set<number>;
}

const cronRanges = [
	[0, 59],
	[0, 23],
	[1, 31],
	[1, 12],
	[0, 6],
] as const;

export class CronExpression {
	readonly parts: CronParts;

	constructor(readonly expression: string) {
		const fields = expression.trim().split(/\s+/);
		if (fields.length !== 5) throw new RangeError('Cron expression must have 5 fields.');

		this.parts = {
			minutes: parseCronField(fields[0], cronRanges[0][0], cronRanges[0][1]),
			hours: parseCronField(fields[1], cronRanges[1][0], cronRanges[1][1]),
			daysOfMonth: parseCronField(fields[2], cronRanges[2][0], cronRanges[2][1]),
			months: parseCronField(fields[3], cronRanges[3][0], cronRanges[3][1]),
			daysOfWeek: parseCronField(fields[4], 0, 7, value => (value === 7 ? 0 : value)),
		};
	}

	matches(date: Date): boolean {
		return (
			this.parts.minutes.has(date.getUTCMinutes()) &&
			this.parts.hours.has(date.getUTCHours()) &&
			this.parts.daysOfMonth.has(date.getUTCDate()) &&
			this.parts.months.has(date.getUTCMonth() + 1) &&
			this.parts.daysOfWeek.has(date.getUTCDay())
		);
	}

	next(after = new Date()): Date {
		const next = new Date(after.getTime());
		next.setUTCSeconds(0, 0);
		next.setUTCMinutes(next.getUTCMinutes() + 1);

		const maxIterations = 60 * 24 * 366 * 5;
		for (let index = 0; index < maxIterations; index++) {
			if (this.matches(next)) return next;
			next.setUTCMinutes(next.getUTCMinutes() + 1);
		}

		throw new RangeError(`Unable to find next date for cron expression: ${this.expression}`);
	}
}

export function parseCronField(
	field: string,
	min: number,
	max: number,
	normalize: (value: number) => number = value => value,
): Set<number> {
	const values = new Set<number>();
	for (const part of field.split(',')) {
		if (!part) throw new RangeError(`Invalid cron field: ${field}`);
		addCronPart(values, part, min, max, normalize);
	}

	return values;
}

function addCronPart(
	values: Set<number>,
	part: string,
	min: number,
	max: number,
	normalize: (value: number) => number,
): void {
	const [rangePart, stepPart] = part.split('/');
	const step = stepPart ? Number(stepPart) : 1;
	if (!Number.isInteger(step) || step <= 0) throw new RangeError(`Invalid cron step: ${part}`);

	const [start, end] = parseCronRange(rangePart, min, max);
	for (let value = start; value <= end; value += step) {
		const normalized = normalize(value);
		if (normalized < min || normalized > max) throw new RangeError(`Cron value out of range: ${value}`);
		values.add(normalized);
	}
}

function parseCronRange(part: string, min: number, max: number): [number, number] {
	if (part === '*') return [min, max];

	const [start, end] = part.split('-');
	const parsedStart = Number(start);
	const parsedEnd = typeof end === 'undefined' ? parsedStart : Number(end);

	if (!Number.isInteger(parsedStart) || !Number.isInteger(parsedEnd))
		throw new RangeError(`Invalid cron range: ${part}`);
	if (parsedStart < min || parsedEnd > max || parsedStart > parsedEnd)
		throw new RangeError(`Cron range out of bounds: ${part}`);

	return [parsedStart, parsedEnd];
}
