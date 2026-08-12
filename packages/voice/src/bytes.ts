import { bytesToHex, equalBytes } from '@noble/ciphers/utils.js';

export { bytesToHex, equalBytes };

export function concatenateBytes(...values: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
	const output = new Uint8Array(values.reduce((length, value) => length + value.byteLength, 0));
	let offset = 0;
	for (const value of values) {
		output.set(value, offset);
		offset += value.byteLength;
	}
	return output;
}

export function bytesStartWith(value: Uint8Array, prefix: Uint8Array): boolean {
	return value.byteLength >= prefix.byteLength && equalBytes(value.subarray(0, prefix.byteLength), prefix);
}

export function zeroBytes(values: Iterable<Uint8Array>): void {
	for (const value of values) value.fill(0);
}

export function clearByteMap<Key>(values: Map<Key, Uint8Array>): void {
	zeroBytes(values.values());
	values.clear();
}

export function zeroByteRecord(values: object): void {
	zeroBytes(Object.values(values).filter((value): value is Uint8Array => value instanceof Uint8Array));
}
