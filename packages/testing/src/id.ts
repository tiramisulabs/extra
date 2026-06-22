import { type DurationInput, parseDuration } from '@slipher/internal';

const DISCORD_EPOCH = 1420070400000n;
const BASE_MS = 1577836800000n;
const STEP_MS = 1n;
const defaultStart = 0n;

let sequence = defaultStart;
// Time-pinned ids (`mockId({ at | age })`) get their own counter so plain mockId()
// output stays byte-identical and reproducible — the package's whole point.
let pinnedSequence = 0n;

function snowflake(seq: bigint): bigint {
	const ms = BASE_MS + seq * STEP_MS;
	return ((ms - DISCORD_EPOCH) << 22n) | (seq % 4096n);
}

function snowflakeAt(ms: bigint): bigint {
	const id = ((ms - DISCORD_EPOCH) << 22n) | (pinnedSequence % 4096n);
	pinnedSequence += 1n;
	return id;
}

/** Created-at instant for `mockId({ at })`: a Date, epoch milliseconds, or a parseable date string. */
export interface MockIdAtOptions {
	at: Date | number | string;
}

/** Relative age for `mockId({ age })`: created this long before now, e.g. `'13d'`, `'90m'` (no weeks). */
export interface MockIdAgeOptions {
	age: DurationInput;
}

export type MockIdOptions = MockIdAtOptions | MockIdAgeOptions;

export function mockId(): string;
export function mockId(options: MockIdOptions): string;
export function mockId(options?: MockIdOptions): string {
	if (!options) {
		const id = snowflake(sequence);
		sequence += 1n;
		return id.toString();
	}
	const ms = 'at' in options ? toEpochMs(options.at) : Date.now() - parseDuration(options.age);
	return snowflakeAt(BigInt(Math.trunc(ms))).toString();
}

/** Absolute creation time (epoch ms) encoded in a snowflake id. */
export function timestampFrom(id: string | bigint): number {
	return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}

/** Milliseconds elapsed since the id's encoded creation time — reads as the assertion you write. */
export function idAge(id: string | bigint): number {
	return Date.now() - timestampFrom(id);
}

function toEpochMs(at: Date | number | string): number {
	if (at instanceof Date) return at.getTime();
	if (typeof at === 'number') return at;
	const ms = Date.parse(at);
	if (Number.isNaN(ms)) {
		throw new TypeError('mockId: { at } must be a Date, epoch milliseconds, or a parseable date string');
	}
	return ms;
}

export function mockTimestamp(): string {
	return new Date(Number(BASE_MS + sequence * STEP_MS)).toISOString();
}

export function resetMockIds(start: bigint | string | number = defaultStart) {
	sequence = parseMockIdStart(start);
	pinnedSequence = 0n;
}

function parseMockIdStart(start: bigint | string | number): bigint {
	if (typeof start === 'bigint') return start;
	if (typeof start === 'number') {
		if (Number.isInteger(start)) return BigInt(start);
		throw new TypeError('resetMockIds start must be an integer number');
	}

	const trimmed = start.trim();
	if (/^-?\d+$/.test(trimmed)) return BigInt(trimmed);
	throw new TypeError('resetMockIds start must be an integer string');
}
