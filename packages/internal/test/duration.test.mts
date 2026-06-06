import { assert, describe, test } from 'vitest';
import {
	InvalidDurationError,
	isAmbiguousQueueAddArgs,
	isJobOptionsLike,
	parseDuration,
	queueAddAmbiguityMessage,
	queueJobOptionKeys,
} from '../src';

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

describe('queue.add overload helpers', () => {
	test('recognizes the shared job option whitelist', () => {
		assert.deepEqual(queueJobOptionKeys, ['id', 'delay', 'attempts', 'priority', 'retryDelay']);
		assert.equal(isJobOptionsLike({ delay: '5s', priority: 1 }), true);
		assert.equal(isJobOptionsLike({ delay: '5s', timeout: 1000 }), false);
		assert.equal(isJobOptionsLike({}), false);
		assert.equal(isJobOptionsLike([]), false);
	});

	test('detects string payload plus options-shaped second argument as ambiguous', () => {
		assert.equal(isAmbiguousQueueAddArgs('send', { delay: '5s' }, undefined), true);
		assert.equal(isAmbiguousQueueAddArgs('send', { message: 'hello' }, undefined), false);
		assert.equal(isAmbiguousQueueAddArgs('send', { delay: '5s' }, { id: 'job-1' }), false);
		assert.match(queueAddAmbiguityMessage, /Ambiguous queue\.add\(\) call/);
	});
});
