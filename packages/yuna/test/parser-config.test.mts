import { assert, describe, test } from 'vitest';
import { createConfig, createRegexes } from '../src/utils/parser/createConfig';

describe('parser config', () => {
	test('filters sparse parser syntax entries before creating regexes', () => {
		const config = createConfig({
			syntax: {
				longTextTags: ['"', undefined, '`'],
				namedOptions: ['-', undefined, ':'],
			},
		});

		assert.deepEqual(config.syntax?.longTextTags, ['"', '`']);
		assert.deepEqual(config.syntax?.namedOptions, ['-', ':']);
	});

	test('normalizes every escaped token with the All escape mode', () => {
		const regexes = createRegexes(createConfig({}));

		assert.equal(regexes.escapeModes.All?.global, true);
	});
});
