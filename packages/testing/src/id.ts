const DISCORD_EPOCH = 1420070400000n;
const BASE_MS = 1577836800000n;
const STEP_MS = 1n;
const defaultStart = 0n;

let sequence = defaultStart;

function snowflake(seq: bigint): bigint {
	const ms = BASE_MS + seq * STEP_MS;
	return ((ms - DISCORD_EPOCH) << 22n) | (seq % 4096n);
}

export function mockId() {
	const id = snowflake(sequence);
	sequence += 1n;
	return id.toString();
}

export function mockTimestamp(): string {
	return new Date(Number(BASE_MS + sequence * STEP_MS)).toISOString();
}

export function resetMockIds(start: bigint | string | number = defaultStart) {
	sequence = parseMockIdStart(start);
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
