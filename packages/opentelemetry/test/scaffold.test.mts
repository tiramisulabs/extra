import { assert, describe, test } from 'vitest';
import { opentelemetry } from '../src';

describe('scaffold', () => {
	test('plugin name is stable', () => {
		const plugin = opentelemetry();
		assert.equal(plugin.name, '@slipher/opentelemetry');
	});
});
