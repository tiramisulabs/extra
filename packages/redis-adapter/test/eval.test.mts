import { assert, describe, test } from 'vitest';
import { RedisAdapter } from '../src';

describe('RedisAdapter eval escape hatch', () => {
	test('forwards scripts with namespaced keys and arguments', async () => {
		const calls: unknown[] = [];
		const client = {
			eval(script: string, options: unknown) {
				calls.push({ script, options });
				return Promise.resolve(['ok']);
			},
		};
		const adapter = new RedisAdapter({ client: client as never, namespace: 'custom' });

		const result = await adapter.eval('return KEYS[1]', ['cooldowns.ping:user:u1', 'cooldowns'], ['arg1']);

		assert.deepEqual(result, ['ok']);
		assert.deepEqual(calls, [
			{
				script: 'return KEYS[1]',
				options: {
					keys: ['custom:cooldowns.ping:user:u1', 'custom:cooldowns'],
					arguments: ['arg1'],
				},
			},
		]);
	});
});
