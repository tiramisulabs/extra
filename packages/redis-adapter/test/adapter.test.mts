import { afterAll, assert, beforeAll, describe, expect, test } from 'vitest';
import { RedisAdapter } from '../src';

const namespace = `slipher_adapter_${process.pid}`;
const adapter = new RedisAdapter({
	redisOptions: { url: process.env.SLIPHER_REDIS_URL ?? 'redis://127.0.0.1:6379' },
	namespace,
});

function userEntry(id: string, value: Record<string, unknown> = { id }) {
	return [`user.${id}`, value, ['user', id]] as const;
}

function channelEntry(id: string, guildId: string, name = guildId) {
	return [`channel.${id}`, { id, guild_id: guildId, name }, [`channel.${guildId}`, id]] as const;
}

describe('RedisAdapter', () => {
	beforeAll(async () => {
		await adapter.start();
		await adapter.flush();
	});

	afterAll(async () => {
		await adapter.flush();
		adapter.client.close();
	});

	test('supports the complete atomic adapter surface', async () => {
		assert.equal(await adapter.get('user.missing'), undefined);

		await adapter.set(...userEntry('primary', { id: 'primary', stale: true, value: 'old' }));
		await adapter.set(...userEntry('primary', { id: 'primary', value: 'current' }));
		await adapter.bulkSet([
			userEntry('one', { id: 'one', value: 'one' }),
			userEntry('two', { id: 'two', value: 'two' }),
		]);
		await adapter.patch(...userEntry('primary', { patched: true }));
		await adapter.bulkPatch([userEntry('one', { patched: 1 }), userEntry('two', { patched: 2 })]);

		assert.deepEqual(await adapter.get('user.primary'), { id: 'primary', patched: true, value: 'current' });
		assert.deepEqual(await adapter.bulkGet(['user.one', 'user.two']), [
			{ id: 'one', patched: 1, value: 'one' },
			{ id: 'two', patched: 2, value: 'two' },
		]);
		assert.deepEqual((await adapter.keys('user')).sort(), ['user.one', 'user.primary', 'user.two']);
		assert.deepEqual((await adapter.getToRelationship('user')).sort(), ['one', 'primary', 'two']);
		assert.equal(await adapter.count('user'), 3);
		assert.equal(await adapter.contains('user', 'one'), true);
		assert.equal((await adapter.scan('user.*')).length, 3);
	});

	test('replaces object and array representations without retaining stale fields', async () => {
		await adapter.set('user.representation', { stale: true, value: 'object' }, ['user', 'representation']);
		await adapter.patch('user.representation', [{ value: 'array' }], ['user', 'representation']);
		assert.deepEqual(await adapter.get('user.representation'), [{ value: 'array' }]);

		await adapter.patch('user.representation', [], ['user', 'representation']);
		assert.deepEqual(await adapter.get('user.representation'), []);

		await adapter.set('user.representation', { value: 'replacement' }, ['user', 'representation']);
		assert.deepEqual(await adapter.get('user.representation'), { value: 'replacement' });
	});

	test('encodes before mutating value or relationship state', async () => {
		await adapter.set(...channelEntry('encoding', 'guild-old', 'old'));

		await expect(
			adapter.set('channel.encoding', { id: 'encoding', invalid: undefined }, ['channel.guild-old', 'encoding']),
		).rejects.toThrow('cannot encode');

		assert.deepEqual(await adapter.get('channel.encoding'), {
			guild_id: 'guild-old',
			id: 'encoding',
			name: 'old',
		});
		assert.equal(await adapter.contains('channel.guild-old', 'encoding'), true);
	});

	test('patch replaces prior encodings when a field changes type', async () => {
		await adapter.set(...userEntry('typed', { id: 'typed', value: 'string' }));
		await adapter.patch(...userEntry('typed', { value: { nested: true } }));
		assert.deepEqual(await adapter.get('user.typed'), { id: 'typed', value: { nested: true } });

		await adapter.patch(...userEntry('typed', { value: 42 }));
		assert.deepEqual(await adapter.get('user.typed'), { id: 'typed', value: 42 });

		await adapter.patch(...userEntry('typed', { value: false }));
		assert.deepEqual(await adapter.get('user.typed'), { id: 'typed', value: false });

		await adapter.patch(...userEntry('typed', { value: 'final' }));
		assert.deepEqual(await adapter.get('user.typed'), { id: 'typed', value: 'final' });
	});

	test('keeps message storage keys independent from relationship scope', async () => {
		await adapter.set('message.message-1', { id: 'message-1', guild_id: 'guild-1', channel_id: 'channel-1' }, [
			'message.channel-1',
			'message-1',
		]);

		assert.deepEqual(await adapter.keys('message.channel-1'), ['message.message-1']);
		assert.equal(await adapter.contains('message.channel-1', 'message-1'), true);
	});

	test('preflights Redis key types before creating an entry', async () => {
		const invalidRelationship = `${namespace}:relationships:channel.guild-invalid`;
		await adapter.client.set(invalidRelationship, 'wrong type');

		await expect(
			adapter.set('channel.invalid', { id: 'invalid' }, ['channel.guild-invalid', 'invalid']),
		).rejects.toThrow('WRONGTYPE');

		assert.equal(await adapter.get('channel.invalid'), undefined);
		assert.equal(await adapter.client.hExists(`${namespace}:relationships:owners`, 'channel.invalid'), 0);
		await adapter.client.del(invalidRelationship);
	});

	test('bulk writes pre-encode the complete input before sending any entry', async () => {
		await expect(
			adapter.bulkSet([
				userEntry('bulk-one'),
				userEntry('bulk-two', { id: 'bulk-two', invalid: undefined }),
				userEntry('bulk-three'),
			]),
		).rejects.toThrow('cannot encode');

		assert.equal(await adapter.get('user.bulk-one'), undefined);
		assert.equal(await adapter.get('user.bulk-two'), undefined);
		assert.equal(await adapter.get('user.bulk-three'), undefined);
		assert.equal(await adapter.contains('user', 'bulk-one'), false);
		assert.equal(await adapter.contains('user', 'bulk-two'), false);
	});

	test('bulk patches pre-encode the complete input before mutating any entry', async () => {
		await adapter.bulkSet([userEntry('patch-one'), userEntry('patch-two'), userEntry('patch-three')]);

		await expect(
			adapter.bulkPatch([
				userEntry('patch-one', { patched: true }),
				userEntry('patch-two', { invalid: undefined }),
				userEntry('patch-three', { patched: true }),
			]),
		).rejects.toThrow('cannot encode');

		assert.deepEqual(await adapter.get('user.patch-one'), { id: 'patch-one' });
		assert.deepEqual(await adapter.get('user.patch-two'), { id: 'patch-two' });
		assert.deepEqual(await adapter.get('user.patch-three'), { id: 'patch-three' });
	});

	test('bulk writes settle the submitted chunk before rejecting with an atomic subset', async () => {
		const invalidRelationship = `${namespace}:relationships:bulk.invalid`;
		await adapter.client.set(invalidRelationship, 'wrong type');
		const originalEvalSha = adapter.client.evalSha.bind(adapter.client);
		const mutableClient = adapter.client as unknown as { evalSha: typeof adapter.client.evalSha };
		const { promise: releaseLateWrite, resolve: release } = Promise.withResolvers<void>();
		const { promise: lateWriteFinished, resolve: finished } = Promise.withResolvers<void>();
		mutableClient.evalSha = (async (...args: Parameters<typeof adapter.client.evalSha>) => {
			const result = await originalEvalSha(...args);
			if (args[1]?.keys?.includes(`${namespace}:user.bulk-late`)) {
				finished();
				await releaseLateWrite;
			}
			return result;
		}) as typeof adapter.client.evalSha;

		try {
			let settled = false;
			const outcome = adapter
				.bulkSet([
					['user.bulk-first', { id: 'bulk-first' }, ['bulk.valid', 'bulk-first']],
					['user.bulk-invalid', { id: 'bulk-invalid' }, ['bulk.invalid', 'bulk-invalid']],
					['user.bulk-late', { id: 'bulk-late' }, ['bulk.valid', 'bulk-late']],
				])
				.then(
					() => ({ status: 'fulfilled' as const }),
					error => ({ error, status: 'rejected' as const }),
				)
				.finally(() => {
					settled = true;
				});

			await lateWriteFinished;
			assert.equal(settled, false);
			release();
			const result = await outcome;
			assert.equal(result.status, 'rejected');
			if (result.status === 'rejected') {
				expect(result.error).toBeInstanceOf(AggregateError);
				expect((result.error as AggregateError).errors[0]).toHaveProperty(
					'message',
					expect.stringContaining('WRONGTYPE'),
				);
			}

			assert.deepEqual(await adapter.get('user.bulk-first'), { id: 'bulk-first' });
			assert.equal(await adapter.get('user.bulk-invalid'), undefined);
			assert.deepEqual(await adapter.get('user.bulk-late'), { id: 'bulk-late' });
			assert.deepEqual((await adapter.getToRelationship('bulk.valid')).sort(), ['bulk-first', 'bulk-late']);
			assert.equal(await adapter.client.get(invalidRelationship), 'wrong type');
		} finally {
			mutableClient.evalSha = originalEvalSha;
			release();
			await adapter.client.del(invalidRelationship);
		}
	});

	test('bulk writes attempt later chunks and aggregate every entry failure', async () => {
		const invalidRelationships = ['bulk.invalid-first', 'bulk.invalid-second'];
		for (const relationship of invalidRelationships) {
			await adapter.client.set(`${namespace}:relationships:${relationship}`, 'wrong type');
		}
		const entries = Array.from({ length: 202 }, (_, index) => {
			const relationship =
				index === 1 || index === 2 ? invalidRelationships[0] : index === 101 ? invalidRelationships[1] : 'bulk.valid';
			return [
				`user.best-effort-${index}`,
				{ id: `best-effort-${index}` },
				[relationship, `best-effort-${index}`],
			] as const;
		});
		const originalEvalSha = adapter.client.evalSha.bind(adapter.client);
		const mutableClient = adapter.client as unknown as { evalSha: typeof adapter.client.evalSha };
		const { promise: firstChunkReady, resolve: markFirstChunkReady } = Promise.withResolvers<void>();
		const { promise: firstChunkGate, resolve: releaseFirstChunk } = Promise.withResolvers<void>();
		const bulkKeyPrefix = `${namespace}:user.best-effort-`;
		let activeWrites = 0;
		let maxActiveWrites = 0;
		let activeWhenLaterChunkStarted: number | undefined;
		mutableClient.evalSha = (async (...args: Parameters<typeof adapter.client.evalSha>) => {
			const valueKey = args[1]?.keys?.[0];
			if (typeof valueKey !== 'string' || !valueKey.startsWith(bulkKeyPrefix)) return originalEvalSha(...args);
			const index = Number(valueKey.slice(bulkKeyPrefix.length));
			if (index >= 100 && activeWhenLaterChunkStarted === undefined) activeWhenLaterChunkStarted = activeWrites;
			activeWrites++;
			maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
			if (activeWrites === 100) markFirstChunkReady();
			try {
				if (index < 100) await firstChunkGate;
				return await originalEvalSha(...args);
			} finally {
				activeWrites--;
			}
		}) as typeof adapter.client.evalSha;
		let operation: Promise<void> | undefined;

		try {
			operation = adapter.bulkSet(entries);
			await firstChunkReady;
			assert.equal(maxActiveWrites, 100);
			assert.equal(activeWhenLaterChunkStarted, undefined);
			releaseFirstChunk();

			const error = await operation.catch(reason => reason);
			expect(error).toBeInstanceOf(AggregateError);
			expect(error).toHaveProperty('message', 'RedisAdapter bulk operation failed for 3 entries');
			expect((error as AggregateError).errors).toHaveLength(3);
			assert.equal(activeWhenLaterChunkStarted, 0);
			assert.equal(maxActiveWrites, 100);

			assert.equal(await adapter.get('user.best-effort-1'), undefined);
			assert.equal(await adapter.get('user.best-effort-2'), undefined);
			assert.equal(await adapter.get('user.best-effort-101'), undefined);
			assert.deepEqual(await adapter.get('user.best-effort-201'), { id: 'best-effort-201' });
			assert.equal(await adapter.contains('bulk.valid', 'best-effort-201'), true);
		} finally {
			releaseFirstChunk();
			await operation?.catch(() => undefined);
			mutableClient.evalSha = originalEvalSha;
			await adapter.client.del(invalidRelationships.map(relationship => `${namespace}:relationships:${relationship}`));
		}
	});

	test('bulk writes recover each pipelined entry after the script cache is flushed', async () => {
		await adapter.client.scriptFlush();
		await adapter.bulkSet([userEntry('noscript-one'), userEntry('noscript-two'), userEntry('noscript-three')]);

		assert.deepEqual((await adapter.getToRelationship('user')).filter(id => id.startsWith('noscript-')).sort(), [
			'noscript-one',
			'noscript-three',
			'noscript-two',
		]);
	});

	test('returns logical scan keys so scan-driven cleanup removes reverse lookups too', async () => {
		await adapter.set(...userEntry('scan-one'));
		await adapter.set(...userEntry('scan-two'));

		const keys = await adapter.scan('user.scan-*', true);
		assert.deepEqual(keys.sort(), ['user.scan-one', 'user.scan-two']);
		await adapter.bulkRemove(keys);

		assert.equal(await adapter.get('user.scan-one'), undefined);
		assert.equal(await adapter.get('user.scan-two'), undefined);
		assert.equal(await adapter.contains('user', 'scan-one'), false);
		assert.equal(await adapter.contains('user', 'scan-two'), false);
	});

	test('removes values and reverse lookups together from either entry surface', async () => {
		await adapter.set(...userEntry('direct'));
		await adapter.remove('user.direct');
		assert.equal(await adapter.get('user.direct'), undefined);
		assert.equal(await adapter.contains('user', 'direct'), false);

		await adapter.set(...channelEntry('remove', 'guild-remove'));
		await adapter.removeToRelationship('channel.guild-remove', 'remove');
		assert.equal(await adapter.get('channel.remove'), undefined);
		assert.equal(await adapter.contains('channel.guild-remove', 'remove'), false);
	});

	test('removes every value and reverse lookup in a complete relationship', async () => {
		await adapter.set('role.exact-one', { id: 'exact-one' }, ['role.guild-exact', 'exact-one']);
		await adapter.set('role.exact-two', { id: 'exact-two' }, ['role.guild-exact', 'exact-two']);

		await adapter.removeRelationship('role.guild-exact');

		assert.equal(await adapter.get('role.exact-one'), undefined);
		assert.equal(await adapter.get('role.exact-two'), undefined);
		assert.deepEqual(await adapter.getToRelationship('role.guild-exact'), []);
		assert.equal(await adapter.client.hExists(`${namespace}:relationships:owners`, 'role.exact-one'), 0);
		assert.equal(await adapter.client.hExists(`${namespace}:relationships:owners`, 'role.exact-two'), 0);
	});

	test('removes wildcard relationships without affecting neighboring relationship types', async () => {
		await adapter.set('role.one', { id: 'one' }, ['role.guild-one', 'one']);
		await adapter.set('role.two', { id: 'two' }, ['role.guild-two', 'two']);
		await adapter.set('member.one', { id: 'one' }, ['member.guild-one', 'one']);

		await adapter.removeRelationship('role.*');

		assert.equal(await adapter.get('role.one'), undefined);
		assert.equal(await adapter.get('role.two'), undefined);
		assert.deepEqual(await adapter.getToRelationship('role.guild-one'), []);
		assert.deepEqual(await adapter.getToRelationship('role.guild-two'), []);
		assert.equal(await adapter.client.hExists(`${namespace}:relationships:owners`, 'role.one'), 0);
		assert.equal(await adapter.client.hExists(`${namespace}:relationships:owners`, 'role.two'), 0);
		assert.deepEqual(await adapter.get('member.one'), { id: 'one' });
		assert.deepEqual(await adapter.getToRelationship('member.guild-one'), ['one']);
		assert.equal(await adapter.client.hGet(`${namespace}:relationships:owners`, 'member.one'), 'member.guild-one.one');
	});

	test('exposes the documented atomic cooldown script bridge with namespace boundaries', async () => {
		const result = await adapter.eval<string>(
			"redis.call('SET', KEYS[1], ARGV[1]); return KEYS[1]",
			['cooldown'],
			['one'],
		);
		assert.equal(result, `${namespace}:cooldown`);
		assert.equal(await adapter.client.get(`${namespace}:cooldown`), 'one');
		await adapter.client.del(`${namespace}:cooldown`);
	});

	test('does not treat a namespace prefix collision as an already namespaced key', async () => {
		const collidingKey = `${namespace}_other:key`;
		await adapter.set(collidingKey, { value: 'namespaced' }, ['custom', 'key']);
		assert.equal(await adapter.client.exists(collidingKey), 0);
		assert.equal(await adapter.client.exists(`${namespace}:${collidingKey}`), 1);
	});
});
