import { assert, describe, test } from 'vitest';
import { InvalidDurationError, parseDuration } from '../src';

describe('parseDuration', () => {
	test('parses numeric and human duration inputs', () => {
		assert.equal(parseDuration(0), 0);
		assert.equal(parseDuration('0s'), 0);
		assert.equal(parseDuration('500ms'), 500);
		assert.equal(parseDuration('1.5s'), 1500);
		assert.equal(parseDuration('1s 5ms'), 1005);
		assert.equal(parseDuration('2h'), 7_200_000);
	});

	test('rejects invalid durations with a shared error type', () => {
		assert.throws(() => parseDuration('soon'), InvalidDurationError);
		assert.throws(() => parseDuration(Number.NaN), InvalidDurationError);
		assert.throws(() => parseDuration(-1), InvalidDurationError);
	});
});
