const MAXIMUM_VECTOR_LENGTH = 0x3fff_ffff;

export class MlsWriter {
	readonly #chunks: Uint8Array[] = [];
	#length = 0;

	uint8(value: number): this {
		assertUnsignedInteger(value, 0xff, 'uint8');
		return this.bytes(Uint8Array.of(value));
	}

	uint16(value: number): this {
		assertUnsignedInteger(value, 0xffff, 'uint16');
		const output = new Uint8Array(2);
		new DataView(output.buffer).setUint16(0, value);
		return this.bytes(output);
	}

	uint32(value: number): this {
		assertUnsignedInteger(value, 0xffff_ffff, 'uint32');
		const output = new Uint8Array(4);
		new DataView(output.buffer).setUint32(0, value);
		return this.bytes(output);
	}

	uint64(value: bigint): this {
		if (value < 0n || value > 0xffff_ffff_ffff_ffffn) throw new RangeError('uint64 is out of range.');
		const output = new Uint8Array(8);
		new DataView(output.buffer).setBigUint64(0, value);
		return this.bytes(output);
	}

	bytes(value: Uint8Array): this {
		if (value.byteLength === 0) return this;
		const copy = value.slice();
		this.#chunks.push(copy);
		this.#length += copy.byteLength;
		return this;
	}

	vector(value: Uint8Array): this {
		return this.bytes(encodeVariableLength(value.byteLength)).bytes(value);
	}

	vectorWith(write: (writer: MlsWriter) => void): this {
		const child = new MlsWriter();
		write(child);
		return this.vector(child.finish());
	}

	optional<T>(value: T | undefined, write: (writer: MlsWriter, value: T) => void): this {
		if (value === undefined) return this.uint8(0);
		this.uint8(1);
		write(this, value);
		return this;
	}

	finish(): Uint8Array<ArrayBuffer> {
		const output = new Uint8Array(this.#length);
		let offset = 0;
		for (const chunk of this.#chunks) {
			output.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return output;
	}
}

export class MlsReader {
	readonly #data: Uint8Array;
	readonly #maximumVectorLength: number;
	#offset = 0;

	constructor(data: Uint8Array, maximumVectorLength = MAXIMUM_VECTOR_LENGTH) {
		assertUnsignedInteger(maximumVectorLength, MAXIMUM_VECTOR_LENGTH, 'maximumVectorLength');
		this.#data = data;
		this.#maximumVectorLength = maximumVectorLength;
	}

	get remaining(): number {
		return this.#data.byteLength - this.#offset;
	}

	uint8(): number {
		return this.bytes(1)[0] as number;
	}

	uint16(): number {
		const bytes = this.bytes(2);
		return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(0);
	}

	uint32(): number {
		const bytes = this.bytes(4);
		return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
	}

	uint64(): bigint {
		const bytes = this.bytes(8);
		return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0);
	}

	bytes(length: number): Uint8Array<ArrayBuffer> {
		assertUnsignedInteger(length, Number.MAX_SAFE_INTEGER, 'length');
		if (length > this.remaining) throw new RangeError('MLS payload is truncated.');
		const start = this.#offset;
		this.#offset += length;
		const output = new Uint8Array(length);
		output.set(this.#data.subarray(start, this.#offset));
		return output;
	}

	vector(): Uint8Array<ArrayBuffer> {
		const length = this.variableLength();
		if (length > this.#maximumVectorLength) throw new RangeError('MLS vector exceeds the configured limit.');
		return this.bytes(length);
	}

	vectorReader(): MlsReader {
		return new MlsReader(this.vector(), this.#maximumVectorLength);
	}

	vectorItems<T>(read: (reader: MlsReader) => T): T[] {
		const reader = this.vectorReader();
		const values: T[] = [];
		while (reader.remaining > 0) {
			const before = reader.remaining;
			values.push(read(reader));
			if (reader.remaining >= before) throw new TypeError('MLS vector item decoder did not consume input.');
		}
		return values;
	}

	optional<T>(read: (reader: MlsReader) => T): T | undefined {
		switch (this.uint8()) {
			case 0:
				return undefined;
			case 1:
				return read(this);
			default:
				throw new TypeError('MLS optional value has an invalid presence marker.');
		}
	}

	assertEnd(): void {
		if (this.remaining !== 0) throw new TypeError('MLS payload contains trailing data.');
	}

	private variableLength(): number {
		const first = this.uint8();
		const prefix = first >>> 6;
		if (prefix === 3) throw new TypeError('MLS vector uses the reserved variable-length prefix.');
		const lengthBytes = 1 << prefix;
		let value = first & 0x3f;
		for (let index = 1; index < lengthBytes; index++) value = value * 0x100 + this.uint8();
		const minimum = prefix === 0 ? 0 : 1 << (8 * (lengthBytes / 2) - 2);
		if (value < minimum) throw new TypeError('MLS vector length is not minimally encoded.');
		return value;
	}
}

export function encodeVariableLength(value: number): Uint8Array<ArrayBuffer> {
	assertUnsignedInteger(value, MAXIMUM_VECTOR_LENGTH, 'MLS vector length');
	if (value < 0x40) return Uint8Array.of(value);
	if (value < 0x4000) {
		const output = new Uint8Array(2);
		new DataView(output.buffer).setUint16(0, value | 0x4000);
		return output;
	}
	const output = new Uint8Array(4);
	new DataView(output.buffer).setUint32(0, value | 0x8000_0000);
	return output;
}

/** @internal */
export function assertUnsignedInteger(value: number, maximum: number, name: string): void {
	if (Number.isSafeInteger(value) && value >= 0 && value <= maximum) return;
	throw new RangeError(`${name} is out of range.`);
}
