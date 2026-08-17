import { describe, expect, test } from 'vitest';
import { concatenateBytes as concatenate } from '../src/bytes';
import { encodeVariableLength, MlsReader, MlsWriter } from '../src/mls/codec';

describe('MLS presentation codec', () => {
	test.each([
		[0, '00'],
		[63, '3f'],
		[64, '4040'],
		[16_383, '7fff'],
		[16_384, '80004000'],
	] as const)('encodes and decodes the canonical vector length %s', (length, hex) => {
		const encoded = encodeVariableLength(length);
		expect(Buffer.from(encoded).toString('hex')).toBe(hex);

		const reader = new MlsReader(concatenate(encoded, new Uint8Array(length)));
		expect(reader.vector()).toHaveLength(length);
		reader.assertEnd();
	});

	test('encodes the maximum vector length without allocating its payload', () => {
		expect(Buffer.from(encodeVariableLength(0x3fff_ffff)).toString('hex')).toBe('bfffffff');
	});

	test.each(['4000', '80000000', 'c0'])('rejects invalid variable-length headers', hex => {
		expect(() => new MlsReader(Buffer.from(hex, 'hex')).vector()).toThrow();
	});

	test('rejects truncated, oversized, and trailing input', () => {
		expect(() => new MlsReader(Uint8Array.of(2, 1)).vector()).toThrow('truncated');
		expect(() => new MlsReader(Uint8Array.of(2, 1, 2), 1).vector()).toThrow('configured limit');
		expect(() => new MlsReader(Uint8Array.of(1)).assertEnd()).toThrow('trailing');
	});

	test('round-trips fixed integers, vectors, optionals, and item vectors', () => {
		const bytes = new MlsWriter()
			.uint8(0xab)
			.uint16(0xcdef)
			.uint32(0x1234_5678)
			.uint64(0x1234_5678_9abc_def0n)
			.vector(Uint8Array.of(1, 2, 3))
			.optional('yes', (writer, value) => writer.vector(new TextEncoder().encode(value)))
			.optional(undefined, () => {})
			.vectorWith(writer => writer.uint16(3).uint16(5).uint16(8))
			.finish();
		const reader = new MlsReader(bytes);
		expect(reader.uint8()).toBe(0xab);
		expect(reader.uint16()).toBe(0xcdef);
		expect(reader.uint32()).toBe(0x1234_5678);
		expect(reader.uint64()).toBe(0x1234_5678_9abc_def0n);
		expect(reader.vector()).toEqual(Uint8Array.of(1, 2, 3));
		expect(new TextDecoder().decode(reader.optional(value => value.vector()))).toBe('yes');
		expect(reader.optional(value => value.uint8())).toBeUndefined();
		expect(reader.vectorItems(value => value.uint16())).toEqual([3, 5, 8]);
		reader.assertEnd();
	});

	test('copies written and read byte strings', () => {
		const input = Uint8Array.of(1, 2);
		const encoded = new MlsWriter().bytes(input).finish();
		input[0] = 9;
		const reader = new MlsReader(encoded);
		const decoded = reader.bytes(2);
		decoded[1] = 9;
		expect(encoded).toEqual(Uint8Array.of(1, 2));
	});

	test('copies decoded byte strings from Node buffers', () => {
		const input = Buffer.from([1, 2, 3]);
		const decoded = new MlsReader(input).bytes(3);
		input[0] = 9;
		expect(decoded).toEqual(Uint8Array.of(1, 2, 3));
	});

	test('rejects malformed optionals and non-consuming item decoders', () => {
		expect(() => new MlsReader(Uint8Array.of(2)).optional(value => value.uint8())).toThrow('presence marker');
		expect(() => new MlsReader(Uint8Array.of(1, 0)).vectorItems(() => 1)).toThrow('did not consume');
	});
});
