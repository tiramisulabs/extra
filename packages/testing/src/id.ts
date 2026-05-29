const defaultStart = 100000000000000000n;
let nextId = defaultStart;

export function mockId() {
	const id = nextId;
	nextId += 1n;
	return id.toString();
}

export function resetMockIds(start: bigint | string | number = defaultStart) {
	nextId = parseMockIdStart(start);
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
