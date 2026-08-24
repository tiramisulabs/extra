import { describe, expect, it } from 'vitest';
import { freezeObserved, nonNegativeMs, positiveMs } from '../src/internal';

describe('internal timer validation', () => {
	it('keeps positive and non-negative timer contracts distinct', () => {
		expect(nonNegativeMs(0, 'heartbeatIntervalMs')).toBe(0);
		expect(positiveMs(1.5, 'handshakeTimeoutMs')).toBe(1.5);
		expect(() => positiveMs(0, 'handshakeTimeoutMs')).toThrow('must be a positive number');
		expect(() => nonNegativeMs(-1, 'heartbeatIntervalMs')).toThrow('must be a non-negative number');
	});

	it('rejects the non-finite values env-driven config can produce', () => {
		expect(() => positiveMs(Number.NaN, 'handshakeTimeoutMs')).toThrow('must be a positive number');
		expect(() => nonNegativeMs(Number.NaN, 'heartbeatIntervalMs')).toThrow('must be a non-negative number');
		expect(() => positiveMs(Number.POSITIVE_INFINITY, 'handshakeTimeoutMs')).toThrow('must be a positive number');
	});
});

describe('freezeObserved', () => {
	it('freezes every level so shared references cannot be mutated by consumers', () => {
		const observed = freezeObserved({
			workerId: 0,
			identity: { slot: '0:1', token: 'tok' },
			topology: { shardStart: 0, shardEnd: 1, totalShards: 1 },
			ready: false,
		});

		expect(Object.isFrozen(observed)).toBe(true);
		expect(Object.isFrozen(observed.identity)).toBe(true);
		expect(Object.isFrozen(observed.topology)).toBe(true);
		expect(() => {
			(observed as { ready: boolean }).ready = true;
		}).toThrow(TypeError);
	});
});
