const defaultStart = 100000000000000000n;
let nextId = defaultStart;

export function mockId() {
	const id = nextId;
	nextId += 1n;
	return id.toString();
}

export function resetMockIds(start: bigint | string | number = defaultStart) {
	nextId = BigInt(start);
}
