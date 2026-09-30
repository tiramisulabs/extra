import { describe, expect, test } from 'vitest';
import { createChildSession } from '../src/child';
import { hasCustomId } from '../src/runtime/messages';

describe('locator and option checks', () => {
	test('a customId is found in section accessories as well as rows', () => {
		const section = {
			type: 9,
			components: [{ type: 10, content: 'Pick one' }],
			accessory: { type: 2, custom_id: 'side', label: 'Side' },
		};
		expect(hasCustomId([section], 'side')).toBe(true);
		expect(hasCustomId([{ type: 1, components: [{ type: 2, custom_id: 'row' }] }], 'row')).toBe(true);
		expect(hasCustomId([section], 'missing')).toBe(false);
	});

	test.each(['startTimeoutMs', 'disposeTimeoutMs', 'rpcTimeoutMs'] as const)('%s must be a positive integer', name => {
		for (const value of [0, -1, 1.5, Number.NaN])
			expect(() =>
				createChildSession({
					projectModule: '/unused.js',
					preset: { scenario: { id: 'x', version: 1 } },
					[name]: value,
				}),
			).toThrow(`${name} must be a positive integer`);
	});
});
