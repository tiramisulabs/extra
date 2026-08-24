import { describe, expect, test } from 'vitest';
import { freezeVoiceState } from '../src/state';

describe('voice state snapshots', () => {
	test('freezes cyclic snapshots while treating ArrayBuffer views as opaque values', () => {
		const received = Uint8Array.of(1);
		const metadata: { received: Uint8Array; self?: unknown } = { received };
		metadata.self = metadata;
		const state = { error: { metadata } };

		expect(() => freezeVoiceState(state)).not.toThrow();
		expect(Object.isFrozen(state)).toBe(true);
		expect(Object.isFrozen(state.error)).toBe(true);
		expect(Object.isFrozen(metadata)).toBe(true);
		expect(Object.isFrozen(received)).toBe(false);
	});
});
