import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient } from '@redis/client';
import { RedisAdapter, toDb } from '@slipher/redis-adapter';
import { assert, describe, expect, test, vi } from 'vitest';
import { ReconciledAdapter } from '../src/adapter';
import { type AdapterMutationTarget, AdapterReconciliationController } from '../src/adapter-controller';
import { bindCoordinator, type CoordinatorBinding } from '../src/coordinator';
import { type RedisCoordinator, redisCoordinator } from '../src/coordinators/redis';
import {
	type CausalPosition,
	type DeleteClaim,
	type GatewayMutationContext,
	GLOBAL_VISIBILITY_SCOPE,
	ReconciliationState,
	type ShardGeneration,
	type VisibilityScope,
} from '../src/reconciliation-state';
import { deferred } from './deferred';

const redisUrl = process.env.SLIPHER_CACHE_INTEGRITY_REDIS_URL;
const redisTest = redisUrl ? test : test.skip;

type RedisClient = RedisAdapter['client'];
type ScopeResolver = (
	target: AdapterMutationTarget,
	position: CausalPosition | undefined,
) => VisibilityScope | undefined;

interface RedisHarness {
	adapter: ReconciledAdapter;
	binding: CoordinatorBinding;
	cacheNamespace: string;
	client: RedisClient;
	controlNamespace: string;
	controller: AdapterReconciliationController;
	coordinator: RedisCoordinator;
	inner: RedisAdapter;
	state: ReconciliationState;
	terminal: { code: string; error: unknown }[];
}

function namespaces() {
	const id = randomUUID();
	return {
		cacheNamespace: `slipher-cache-integrity-cache-${id}`,
		controlNamespace: `slipher-cache-integrity-control-${id}`,
	};
}

async function createHarness(
	options: {
		cacheNamespace?: string;
		controlNamespace?: string;
		isManagedRelationship?: (to: string) => boolean;
		isManagedValue?: (key: string) => boolean;
		leaseTtlMs?: number;
		resolveScope?: ScopeResolver;
	} = {},
): Promise<RedisHarness> {
	const generated = namespaces();
	const cacheNamespace = options.cacheNamespace ?? generated.cacheNamespace;
	const controlNamespace = options.controlNamespace ?? generated.controlNamespace;
	const client = createClient({ url: redisUrl! }) as RedisClient;
	client.on('error', () => undefined);
	const inner = new RedisAdapter({ client, namespace: cacheNamespace });
	const state = new ReconciliationState();
	state.activate();
	const controller = new AdapterReconciliationController(state, {
		isManagedRelationship: options.isManagedRelationship,
		isManagedValue: options.isManagedValue,
		resolveScope: options.resolveScope ?? (() => GLOBAL_VISIBILITY_SCOPE),
	});
	const terminal: RedisHarness['terminal'] = [];
	const coordinator = redisCoordinator({
		cacheNamespace,
		client,
		leaseTtlMs: options.leaseTtlMs,
		namespace: controlNamespace,
	});
	const binding = bindCoordinator(coordinator, {
		adapter: inner,
		controller,
		onTerminal(code, error) {
			terminal.push({ code, error });
			state.fail();
		},
		state,
	});
	if (!binding) throw new Error('Redis coordinator did not provide a storage binding.');
	const adapter = new ReconciledAdapter(
		inner,
		coordinator,
		{
			beforeStart() {},
			onFailed(error) {
				terminal.push({ code: 'start-failed', error });
			},
			onStarted() {},
		},
		controller,
		binding,
	);
	try {
		await adapter.start();
	} catch (error) {
		if (client.isOpen) await client.quit().catch(() => undefined);
		throw error;
	}
	return {
		adapter,
		binding,
		cacheNamespace,
		client,
		controlNamespace,
		controller,
		coordinator,
		inner,
		state,
		terminal,
	};
}

async function deletePrefix(client: RedisClient, prefix: string): Promise<void> {
	for await (const batch of client.scanIterator({ MATCH: `${prefix}:*` })) {
		if (batch.length > 0) await client.del(batch);
	}
}

async function dispose(...harnesses: RedisHarness[]): Promise<void> {
	await Promise.all(harnesses.map(harness => harness.adapter.close().catch(() => undefined)));
	for (const harness of harnesses) {
		if (!harness.client.isOpen) continue;
		await deletePrefix(harness.client, harness.cacheNamespace);
		await deletePrefix(harness.client, harness.controlNamespace);
		await harness.client.quit();
	}
}

function stageGeneration(
	harness: RedisHarness,
	shardId: number,
	sessionId = `session-${shardId}-${randomUUID()}`,
): ShardGeneration {
	const generation = harness.state.openGeneration({
		expectedGuildIds: [],
		sequence: 1,
		sessionId,
		shardId,
	});
	harness.binding.stageReady?.(generation);
	harness.state.markGuildsReady(generation);
	return generation;
}

async function commitGeneration(harness: RedisHarness, generation: ShardGeneration): Promise<void> {
	await harness.binding.commitGeneration?.(generation);
}

function nextPosition(harness: RedisHarness, generation: ShardGeneration, sequence: number): CausalPosition {
	return harness.state.observePacket(generation, sequence);
}

function staleContext(claim: DeleteClaim): GatewayMutationContext {
	return {
		deleteClaim: claim,
		event: 'GUILDS_READY',
		guildId: claim.cut.guildId,
		mode: 'stale-guild-cascade',
		position: claim.cut,
		shardId: claim.generation.shardId,
	};
}

async function rawState(harness: RedisHarness, stateKey: string): Promise<Record<string, unknown> | undefined> {
	const encoded = await harness.client.hGet(`${harness.controlNamespace}:state`, stateKey);
	return encoded ? (JSON.parse(encoded) as Record<string, unknown>) : undefined;
}

async function rawStateText(harness: RedisHarness, stateKey: string): Promise<string | undefined> {
	return (await harness.client.hGet(`${harness.controlNamespace}:state`, stateKey)) ?? undefined;
}

async function eventually(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
	const expires = Date.now() + timeoutMs;
	while (!(await predicate())) {
		if (Date.now() >= expires) throw new Error('Timed out waiting for Redis coordinator state.');
		await delay(20);
	}
}

async function leaseKey(harness: RedisHarness, shardId: number): Promise<string> {
	const keys: string[] = [];
	for await (const batch of harness.client.scanIterator({
		MATCH: `${harness.controlNamespace}:lease:${shardId}`,
	})) {
		keys.push(...batch);
	}
	assert.lengthOf(keys, 1);
	return keys[0]!;
}

describe('redisCoordinator real Redis integration', () => {
	redisTest('matches RedisAdapter value and relationship layout without taking client ownership', async () => {
		const harness = await createHarness();
		try {
			const value = { active: true, id: 'one', nested: { ok: true }, score: 7 };
			await harness.adapter.set('item.one', value);
			await harness.adapter.addToRelationship('item', 'one');

			assert.deepEqual(await harness.client.hGetAll(`${harness.cacheNamespace}:item.one`), toDb(value));
			assert.sameMembers(await harness.client.sMembers(`${harness.cacheNamespace}:item:set`), ['one']);
			assert.deepEqual(await harness.adapter.get('item.one'), value);
			assert.deepEqual(await harness.adapter.bulkGet(['item.one', 'item.missing']), [value]);
			assert.deepEqual(await harness.adapter.scan('item.*', true), [`${harness.cacheNamespace}:item.one`]);
			assert.deepEqual(await harness.adapter.keys('item'), [`${harness.cacheNamespace}:item.one`]);
			assert.deepEqual(await harness.adapter.values('item'), [value]);
			assert.equal(await harness.adapter.count('item'), 1);
			assert.isTrue(await harness.adapter.contains('item', 'one'));

			await harness.adapter.patch('item.one', [{ id: 'array' }]);
			assert.deepEqual(await harness.adapter.get('item.one'), [{ id: 'array' }]);

			await harness.adapter.close();
			assert.isTrue(harness.client.isOpen);
		} finally {
			await dispose(harness);
		}
	});

	redisTest('bounds large Redis command fanout while preserving bulk and paged relationship results', async () => {
		const harness = await createHarness();
		try {
			const entries = Array.from(
				{ length: 205 },
				(_, index) => [`item.${index}`, { id: String(index) }] as [string, { id: string }],
			);
			const originalEvalSha = harness.client.evalSha.bind(harness.client);
			let active = 0;
			let maximumActive = 0;
			vi.spyOn(harness.client, 'evalSha').mockImplementation((async (
				...args: Parameters<typeof harness.client.evalSha>
			) => {
				active++;
				maximumActive = Math.max(maximumActive, active);
				try {
					await delay(1);
					return await originalEvalSha(...args);
				} finally {
					active--;
				}
			}) as typeof harness.client.evalSha);

			await harness.adapter.bulkSet(entries);
			assert.isAbove(maximumActive, 1);
			assert.isAtMost(maximumActive, 100);

			maximumActive = 0;
			assert.lengthOf(await harness.adapter.bulkGet(entries.map(([key]) => key)), entries.length);
			assert.isAbove(maximumActive, 1);
			assert.isAtMost(maximumActive, 100);

			await harness.adapter.bulkAddToRelationShip({ item: entries.map(([, value]) => value.id) });
			assert.equal(await harness.adapter.count('item'), entries.length);
			assert.isTrue(await harness.adapter.contains('item', '204'));
			assert.sameMembers(
				await harness.adapter.getToRelationship('item'),
				entries.map(([, value]) => value.id),
			);
		} finally {
			await dispose(harness);
		}
	});

	redisTest('deduplicates relationship members repeated by SSCAN', async () => {
		const harness = await createHarness();
		try {
			await harness.adapter.set('item.one', { id: 'one' });
			await harness.adapter.addToRelationship('item', 'one');
			vi.spyOn(harness.client, 'sScanIterator').mockImplementation(async function* () {
				yield ['one'];
				yield ['one'];
			} as typeof harness.client.sScanIterator);

			assert.deepEqual(await harness.adapter.getToRelationship('item'), ['one']);
			assert.equal(await harness.adapter.count('item'), 1);
		} finally {
			await dispose(harness);
		}
	});

	redisTest('coalesces concurrent NOSCRIPT reloads without sending raw Lua through EVAL', async () => {
		const harness = await createHarness();
		try {
			const entries = Array.from(
				{ length: 105 },
				(_, index) => [`item.${index}`, { id: String(index) }] as [string, { id: string }],
			);
			await harness.client.scriptFlush();
			const evalSpy = vi.spyOn(harness.client, 'eval');
			const originalScriptLoad = harness.client.scriptLoad.bind(harness.client);
			const scriptLoadSpy = vi.spyOn(harness.client, 'scriptLoad').mockImplementation(async script => {
				await delay(10);
				return originalScriptLoad(script);
			});

			await harness.adapter.bulkSet(entries);

			assert.equal(scriptLoadSpy.mock.calls.length, 1);
			assert.equal(evalSpy.mock.calls.length, 0);
		} finally {
			await dispose(harness);
		}
	});

	redisTest('matches RedisAdapter serialization failures without failing later Redis operations', async () => {
		const harness = await createHarness();
		try {
			const cyclic: Record<string, unknown> = { id: 'cyclic' };
			cyclic.self = cyclic;

			await expect(harness.adapter.set('item.cyclic', cyclic)).rejects.toThrow();
			await expect(harness.adapter.set('item.empty', {})).rejects.toThrow();
			await expect(harness.adapter.set('item.undefined', { optional: undefined })).rejects.toThrow();
			assert.deepEqual(await harness.client.hGetAll(`${harness.cacheNamespace}:item.empty`), {});
			assert.deepEqual(await harness.client.hGetAll(`${harness.cacheNamespace}:item.undefined`), {});

			await harness.adapter.set('item.patch', { id: 'patch', retained: true });
			await expect(harness.adapter.patch('item.patch', {})).rejects.toThrow();
			await expect(harness.adapter.patch('item.patch', { optional: undefined })).rejects.toThrow();
			assert.deepEqual(await harness.adapter.get('item.patch'), { id: 'patch', retained: true });
			assert.equal(harness.state.lifecycle, 'active');
			assert.deepEqual(harness.terminal, []);

			await harness.adapter.set('item.valid', { id: 'valid' });
			assert.deepEqual(await harness.adapter.get('item.valid'), { id: 'valid' });
			assert.equal(harness.state.lifecycle, 'active');
			assert.deepEqual(harness.terminal, []);
		} finally {
			await dispose(harness);
		}
	});

	redisTest('keeps the cache namespace paired with one coordinator namespace after shutdown', async () => {
		const shared = namespaces();
		const first = await createHarness(shared);
		try {
			await first.adapter.close();
			await expect(
				createHarness({
					cacheNamespace: shared.cacheNamespace,
					controlNamespace: `${shared.controlNamespace}-other`,
				}),
			).rejects.toThrow(/already paired with a different coordinator namespace/);
			assert.equal(
				await first.client.get(`${shared.cacheNamespace}:__slipher_cache_integrity_control`),
				shared.controlNamespace,
			);
		} finally {
			await dispose(first);
		}
	});

	redisTest(
		'uses visible-version rather than relationship evidence high-water and preserves causal intent',
		async () => {
			const harness = await createHarness();
			try {
				await harness.adapter.set('item.causal', { id: 'causal', version: 'old' });
				await harness.adapter.set('item.standalone', { id: 'standalone' });
				await harness.adapter.addToRelationship('item', 'standalone');
				assert.deepEqual(await harness.adapter.getToRelationship('item'), ['standalone']);

				const generation = stageGeneration(harness, 0);
				await commitGeneration(harness, generation);
				const position = nextPosition(harness, generation, 2);
				await harness.controller.runWithCause(position, () => harness.adapter.addToRelationship('item', 'causal'));

				assert.sameMembers(await harness.client.sMembers(`${harness.cacheNamespace}:item:set`), [
					'causal',
					'standalone',
				]);
				assert.deepEqual(await harness.adapter.getToRelationship('item'), ['standalone']);
				assert.deepEqual(await harness.adapter.keys('item'), [`${harness.cacheNamespace}:item.standalone`]);
				assert.deepEqual(await harness.adapter.values('item'), [{ id: 'standalone' }]);
				assert.equal(await harness.adapter.count('item'), 1);
				assert.isFalse(await harness.adapter.contains('item', 'causal'));

				const evidence = await rawState(harness, JSON.stringify(['value', 'item.causal']));
				assert.isAbove(Number(evidence?.he), Number(evidence?.ve));
				assert.equal(evidence?.visibility, 'visible');

				await harness.controller.runWithCause(position, () =>
					harness.adapter.set('item.causal', { id: 'causal', version: 'current' }),
				);
				assert.sameMembers(await harness.adapter.getToRelationship('item'), ['standalone', 'causal']);
			} finally {
				await dispose(harness);
			}
		},
	);

	redisTest('orders global relationship clear and add by arrival across coordinator epochs', async () => {
		const shared = namespaces();
		const low = await createHarness(shared);
		const high = await createHarness(shared);
		try {
			await low.adapter.set('item.one', { id: 'one' });
			await high.adapter.removeRelationship('item');
			await low.adapter.addToRelationship('item', 'one');
			assert.deepEqual(await high.adapter.getToRelationship('item'), ['one']);

			await low.adapter.addToRelationship('item', 'one');
			await high.adapter.removeRelationship('item');
			assert.deepEqual(await low.adapter.getToRelationship('item'), []);
		} finally {
			await dispose(high, low);
		}
	});

	redisTest('fences the old owner but lets a successor inspect old shard records unfiltered', async () => {
		const shared = namespaces();
		let oldScope: ShardGeneration | undefined;
		const old = await createHarness({
			...shared,
			resolveScope: (_target, position) => position?.generation ?? oldScope,
		});
		let successorScope: ShardGeneration | undefined;
		const successor = await createHarness({
			...shared,
			resolveScope: (_target, position) => position?.generation ?? successorScope,
		});
		try {
			oldScope = stageGeneration(old, 0, 'old-session');
			await commitGeneration(old, oldScope);
			const oldPosition = nextPosition(old, oldScope, 2);
			await old.controller.runWithCause(oldPosition, () => old.adapter.set('guild.old', { id: 'old' }));

			await old.client.del(await leaseKey(old, 0));
			successorScope = stageGeneration(successor, 0, 'successor-session');
			await commitGeneration(successor, successorScope);

			assert.equal(await old.adapter.runUnfiltered(() => old.adapter.get('guild.old')), null);
			assert.equal(await successor.adapter.get('guild.old'), null);
			assert.deepEqual(await successor.adapter.runUnfiltered(() => successor.adapter.get('guild.old')), { id: 'old' });
		} finally {
			await dispose(successor, old);
		}
	});

	redisTest('materializes the first guarded root claim and restores previous metadata when it is aborted', async () => {
		let scope: ShardGeneration | undefined;
		const harness = await createHarness({
			leaseTtlMs: 300,
			resolveScope: (_target, position) => position?.generation ?? scope,
		});
		try {
			scope = stageGeneration(harness, 0);
			await commitGeneration(harness, scope);
			const rootPosition = nextPosition(harness, scope, 2);
			await harness.controller.runWithCause(rootPosition, () =>
				harness.adapter.set('guild.root', { id: 'root', name: 'before' }),
			);
			await harness.client.hSet(`${harness.cacheNamespace}:child.one`, toDb({ id: 'one' }));
			const rootStateKey = JSON.stringify(['value', 'guild.root']);
			const previous = await rawStateText(harness, rootStateKey);
			assert.isDefined(previous);

			const cut = harness.state.beginSnapshot(scope, 3, {
				completeness: 'authoritative',
				guildId: 'root',
				resource: 'guild',
			});
			const claim = harness.controller.claimValueDelete('guild.root', cut);
			assert.isDefined(claim);
			const context = staleContext(claim!);
			assert.deepEqual(
				await harness.controller.runWithContext(context, () =>
					harness.adapter.runUnfiltered(() => harness.adapter.get('child.one')),
				),
				{ id: 'one' },
			);
			const claimed = await rawState(harness, rootStateKey);
			assert.isString(claimed?.claim);
			assert.equal(claimed?.previous, previous);
			assert.equal(await harness.adapter.get('guild.root'), null);
			await delay(450);
			assert.isString((await rawState(harness, rootStateKey))?.claim);

			harness.state.beginSnapshot(scope, 4, {
				completeness: 'partial',
				guildId: 'root',
				resource: 'guild',
			});
			assert.equal(
				await harness.controller.runWithContext(context, () =>
					harness.adapter.runUnfiltered(() => harness.adapter.get('child.one')),
				),
				null,
			);
			assert.equal(await rawStateText(harness, rootStateKey), previous);
			assert.deepEqual(await harness.adapter.get('guild.root'), { id: 'root', name: 'before' });
		} finally {
			await dispose(harness);
		}
	});

	redisTest('revalidates a guarded delete after deferred lease acquisition and a newer partial cut', async () => {
		let scope: ShardGeneration | undefined;
		const harness = await createHarness({ resolveScope: (_target, position) => position?.generation ?? scope });
		try {
			scope = stageGeneration(harness, 0);
			await harness.client.hSet(`${harness.cacheNamespace}:child.deferred`, toDb({ id: 'deferred' }));
			const cut = harness.state.beginSnapshot(scope, 2, {
				completeness: 'authoritative',
				guildId: 'root',
				resource: 'guild',
			});
			const claim = harness.controller.claimValueDelete('guild.root', cut);
			assert.isDefined(claim);

			const acquired = deferred();
			const release = deferred();
			const originalEvalSha = harness.client.evalSha.bind(harness.client);
			const evalSpy = vi.spyOn(harness.client, 'evalSha');
			evalSpy.mockImplementationOnce(async (script, options) => {
				acquired.resolve();
				await release.promise;
				return originalEvalSha(script, options);
			});
			const pending = harness.controller.runWithContext(staleContext(claim!), () =>
				harness.adapter.runUnfiltered(() => harness.adapter.get('child.deferred')),
			);
			await acquired.promise;
			harness.state.beginSnapshot(scope, 3, {
				completeness: 'partial',
				guildId: 'root',
				resource: 'guild',
			});
			release.resolve();

			assert.equal(await pending, null);
			assert.equal(await harness.client.exists(`${harness.cacheNamespace}:child.deferred`), 1);
			assert.isUndefined(await rawState(harness, JSON.stringify(['value', 'guild.root'])));
		} finally {
			await dispose(harness);
		}
	});

	redisTest.each(['fence', 'transport'] as const)(
		'fails get closed on a Redis %s error without rejecting',
		async mode => {
			const harness = await createHarness();
			const unhandled: unknown[] = [];
			const onUnhandled = (error: unknown) => unhandled.push(error);
			process.on('unhandledRejection', onUnhandled);
			try {
				await harness.adapter.set('item.visible', { id: 'visible' });
				const innerGet = vi.spyOn(harness.inner, 'get');
				if (mode === 'fence') {
					for await (const batch of harness.client.scanIterator({ MATCH: `${harness.controlNamespace}:live:*` })) {
						if (batch.length > 0) await harness.client.del(batch);
					}
				} else {
					vi.spyOn(harness.client, 'evalSha').mockRejectedValueOnce(new Error('transport failed'));
				}

				assert.equal(await harness.adapter.get('item.visible'), null);
				assert.equal(harness.state.lifecycle, 'failed');
				assert.lengthOf(harness.terminal, 1);
				assert.equal(await harness.adapter.get('item.visible'), null);
				assert.deepEqual(await harness.adapter.bulkGet(['item.visible']), []);
				assert.deepEqual(await harness.adapter.scan('item.*', true), []);
				assert.deepEqual(await harness.adapter.getToRelationship('item'), []);
				assert.equal(await harness.adapter.count('item'), 0);
				assert.isFalse(await harness.adapter.contains('item', 'visible'));
				assert.equal(await harness.adapter.runUnfiltered(() => harness.adapter.get('item.visible')), null);
				expect(innerGet).not.toHaveBeenCalled();
				await delay(0);
				assert.deepEqual(unhandled, []);
			} finally {
				process.off('unhandledRejection', onUnhandled);
				await dispose(harness);
			}
		},
	);

	redisTest('compacts tombstones after every older live coordinator has advanced or stopped', async () => {
		let scope: ShardGeneration | undefined;
		const shared = namespaces();
		const blocker = await createHarness({ ...shared, leaseTtlMs: 300 });
		const harness = await createHarness({
			...shared,
			leaseTtlMs: 300,
			resolveScope: (_target, position) => position?.generation ?? scope,
		});
		try {
			scope = stageGeneration(harness, 0);
			await commitGeneration(harness, scope);
			const write = nextPosition(harness, scope, 2);
			await harness.controller.runWithCause(write, () => harness.adapter.set('item.one', { id: 'one' }));
			await harness.controller.runWithCause(write, () => harness.adapter.addToRelationship('item', 'one'));
			await harness.controller.runWithCause(write, () => harness.adapter.set('item.visible', { id: 'visible' }));
			const cut = harness.state.beginSnapshot(scope, 3, {
				completeness: 'authoritative',
				guildId: 'guild',
				resource: 'item',
			});
			const claim = harness.controller.claimValueDelete('item.one', cut);
			assert.isDefined(claim);
			await harness.adapter.reconcileDelete('item.one', claim!, { id: 'one', to: 'item' });

			assert.equal((await rawState(harness, JSON.stringify(['value', 'item.one'])))?.visibility, 'hidden');
			assert.equal((await rawState(harness, JSON.stringify(['relationship', 'item', 'one'])))?.visibility, 'hidden');

			const later = nextPosition(harness, scope, 4);
			await harness.controller.runWithCause(later, () => harness.adapter.set('item.two', { id: 'two' }));
			await harness.controller.runWithCause(later, () => harness.adapter.addToRelationship('item', 'two'));
			await harness.controller.runWithCause(nextPosition(harness, scope, 5), () =>
				harness.adapter.removeToRelationship('item', 'two'),
			);
			assert.equal((await rawState(harness, JSON.stringify(['relationship', 'item', 'two'])))?.visibility, 'hidden');
			await harness.controller.runWithCause(nextPosition(harness, scope, 6), () =>
				harness.adapter.removeRelationship('item'),
			);
			assert.equal((await rawState(harness, JSON.stringify(['relationship-clear', 'item'])))?.visibility, 'hidden');

			const tombstones = [
				JSON.stringify(['value', 'item.one']),
				JSON.stringify(['relationship', 'item', 'one']),
				JSON.stringify(['relationship', 'item', 'two']),
				JSON.stringify(['relationship-clear', 'item']),
			];
			await harness.client.zAdd(`${harness.controlNamespace}:live-epochs`, {
				score: 0,
				value: 'stale-incarnation',
			});
			await eventually(
				async () =>
					(await harness.client.zScore(`${harness.controlNamespace}:live-epochs`, 'stale-incarnation')) === null,
			);
			for (const stateKey of tombstones) assert.isDefined(await rawState(harness, stateKey));

			await blocker.adapter.close();
			await eventually(async () => {
				const records = await Promise.all(tombstones.map(stateKey => rawState(harness, stateKey)));
				return records.every(record => record === undefined);
			});
			assert.equal((await rawState(harness, JSON.stringify(['value', 'item.visible'])))?.visibility, 'visible');
			assert.deepEqual(await harness.client.hGetAll(`${harness.cacheNamespace}:item.visible`), toDb({ id: 'visible' }));
		} finally {
			await dispose(harness, blocker);
		}
	});

	redisTest('lets a later distributed write beat an older claimed delete in either arrival order', async () => {
		const shared = namespaces();
		let deletingScope: ShardGeneration | undefined;
		const deleting = await createHarness({
			...shared,
			resolveScope: (_target, position) => position?.generation ?? deletingScope,
		});
		let writing: RedisHarness | undefined;
		try {
			deletingScope = stageGeneration(deleting, 0, 'deleting');
			await commitGeneration(deleting, deletingScope);
			const initial = nextPosition(deleting, deletingScope, 2);
			await deleting.controller.runWithCause(initial, () =>
				deleting.adapter.bulkSet([
					['item.delete-first', { id: 'delete-first', source: 'initial' }],
					['item.write-first', { id: 'write-first', source: 'initial' }],
				]),
			);
			writing = await createHarness({ ...shared, resolveScope: () => GLOBAL_VISIBILITY_SCOPE });

			const deleteFirstCut = deleting.state.beginSnapshot(deletingScope, 3, {
				completeness: 'authoritative',
				guildId: 'delete-first',
				resource: 'item',
			});
			const deleteFirstClaim = deleting.controller.claimValueDelete('item.delete-first', deleteFirstCut);
			assert.isDefined(deleteFirstClaim);
			await deleting.adapter.reconcileDelete('item.delete-first', deleteFirstClaim!);
			assert.equal(await deleting.client.exists(`${deleting.cacheNamespace}:item.delete-first`), 0);
			await writing.adapter.set('item.delete-first', { id: 'delete-first', source: 'later-write' });

			const writeFirstCut = deleting.state.beginSnapshot(deletingScope, 4, {
				completeness: 'authoritative',
				guildId: 'write-first',
				resource: 'item',
			});
			const writeFirstClaim = deleting.controller.claimValueDelete('item.write-first', writeFirstCut);
			assert.isDefined(writeFirstClaim);
			await writing.adapter.set('item.write-first', { id: 'write-first', source: 'later-write' });
			await deleting.adapter.reconcileDelete('item.write-first', writeFirstClaim!);

			for (const key of ['item.delete-first', 'item.write-first']) {
				const expected = { id: key.slice('item.'.length), source: 'later-write' };
				assert.deepEqual(await deleting.client.hGetAll(`${deleting.cacheNamespace}:${key}`), toDb(expected));
				assert.deepEqual(await deleting.adapter.get(key), expected);
				assert.deepEqual(await writing.adapter.get(key), expected);
				assert.deepInclude(await rawState(deleting, JSON.stringify(['value', key])), {
					scope: 'global',
					visibility: 'visible',
				});
			}
		} finally {
			await dispose(...(writing ? [writing, deleting] : [deleting]));
		}
	});

	redisTest('settles a remotely stale and admitted value batch entry independently', async () => {
		const shared = namespaces();
		let shardScope: ShardGeneration | undefined;
		const shard = await createHarness({
			...shared,
			resolveScope: (_target, position) => position?.generation ?? shardScope,
		});
		let global: RedisHarness | undefined;
		try {
			shardScope = stageGeneration(shard, 0, 'batch-shard');
			await commitGeneration(shard, shardScope);
			const position = nextPosition(shard, shardScope, 2);
			global = await createHarness({ ...shared, resolveScope: () => GLOBAL_VISIBILITY_SCOPE });
			await global.adapter.set('item.stale', { id: 'stale', source: 'newer-global' });

			await shard.controller.runWithCause(position, () =>
				shard.adapter.bulkSet([
					['item.stale', { id: 'stale', source: 'older-shard' }],
					['item.admitted', { id: 'admitted', source: 'older-shard' }],
				]),
			);

			assert.deepEqual(await shard.adapter.get('item.stale'), { id: 'stale', source: 'newer-global' });
			assert.deepEqual(await shard.adapter.get('item.admitted'), {
				id: 'admitted',
				source: 'older-shard',
			});
			assert.deepEqual(
				await shard.client.hGetAll(`${shard.cacheNamespace}:item.stale`),
				toDb({ id: 'stale', source: 'newer-global' }),
			);
			assert.deepEqual(
				await shard.client.hGetAll(`${shard.cacheNamespace}:item.admitted`),
				toDb({ id: 'admitted', source: 'older-shard' }),
			);
			assert.isUndefined(shard.state.ownedVisibilityOf(JSON.stringify(['value', 'item.stale'])));
			assert.equal(shard.state.ownedVisibilityOf(JSON.stringify(['value', 'item.admitted']))?.state, 'visible');
			assert.equal(shard.state.pendingWork, 0);
		} finally {
			await dispose(...(global ? [global, shard] : [shard]));
		}
	});

	redisTest('keeps managed shard state private from a replacement that only receives RESUMED', async () => {
		const shared = namespaces();
		let oldScope: ShardGeneration | undefined;
		const old = await createHarness({
			...shared,
			resolveScope: (_target, position) => position?.generation ?? oldScope,
		});
		let replacement: RedisHarness | undefined;
		try {
			oldScope = stageGeneration(old, 0, 'old-ready');
			await commitGeneration(old, oldScope);
			const position = nextPosition(old, oldScope, 2);
			await old.controller.runWithCause(position, () => old.adapter.set('guild.one', { id: 'one', source: 'old' }));
			await old.controller.runWithCause(position, () => old.adapter.addToRelationship('guild', 'one'));
			const valueStateKey = JSON.stringify(['value', 'guild.one']);
			const relationshipStateKey = JSON.stringify(['relationship', 'guild', 'one']);
			const previousValueState = await rawStateText(old, valueStateKey);
			const previousRelationshipState = await rawStateText(old, relationshipStateKey);
			await old.adapter.close();

			replacement = await createHarness({
				...shared,
				resolveScope: (_target, position) => position?.generation,
			});
			const resumed = replacement.state.resume(0, 3);
			assert.isUndefined(resumed);
			replacement.binding.stageResumed?.(resumed);

			await replacement.adapter.set('guild.one', { id: 'one', source: 'replacement' });
			await replacement.adapter.remove('guild.one');
			await replacement.adapter.addToRelationship('guild', 'two');

			assert.equal(await replacement.adapter.get('guild.one'), null);
			assert.deepEqual(await replacement.adapter.getToRelationship('guild'), []);
			assert.deepEqual(
				await replacement.client.hGetAll(`${replacement.cacheNamespace}:guild.one`),
				toDb({ id: 'one', source: 'old' }),
			);
			assert.sameMembers(await replacement.client.sMembers(`${replacement.cacheNamespace}:guild:set`), ['one']);
			assert.equal(await rawStateText(replacement, valueStateKey), previousValueState);
			assert.equal(await rawStateText(replacement, relationshipStateKey), previousRelationshipState);
			assert.deepEqual(replacement.terminal, []);
		} finally {
			await dispose(...(replacement ? [replacement, old] : [old]));
		}
	});

	redisTest('hides an incomplete uncommitted generation after a successor takes the shard', async () => {
		const shared = namespaces();
		let oldScope: ShardGeneration | undefined;
		const old = await createHarness({
			...shared,
			resolveScope: (_target, position) => position?.generation ?? oldScope,
		});
		let successor: RedisHarness | undefined;
		try {
			oldScope = old.state.openGeneration({
				expectedGuildIds: ['pending'],
				sequence: 1,
				sessionId: 'incomplete',
				shardId: 0,
			});
			old.binding.stageReady?.(oldScope);
			const position = nextPosition(old, oldScope, 2);
			await old.controller.runWithCause(position, () =>
				old.adapter.set('guild.incomplete', { id: 'incomplete', source: 'old' }),
			);
			assert.equal((await old.client.hGetAll(`${old.controlNamespace}:generation:0`)).committed, '0');
			assert.deepEqual(
				await old.client.hGetAll(`${old.cacheNamespace}:guild.incomplete`),
				toDb({ id: 'incomplete', source: 'old' }),
			);
			await old.adapter.close();

			let successorScope: ShardGeneration | undefined;
			successor = await createHarness({
				...shared,
				resolveScope: (_target, next) => next?.generation ?? successorScope,
			});
			successorScope = stageGeneration(successor, 0, 'successor-ready');
			await commitGeneration(successor, successorScope);

			assert.equal(await successor.adapter.get('guild.incomplete'), null);
			assert.deepEqual(await successor.adapter.runUnfiltered(() => successor!.adapter.get('guild.incomplete')), {
				id: 'incomplete',
				source: 'old',
			});
			assert.deepEqual(
				await successor.client.hGetAll(`${successor.cacheNamespace}:guild.incomplete`),
				toDb({ id: 'incomplete', source: 'old' }),
			);
		} finally {
			await dispose(...(successor ? [successor, old] : [old]));
		}
	});

	redisTest('lets both active shards publish globally owned values regardless of lease acquisition order', async () => {
		const shared = namespaces();
		const shardZeroHarness = await createHarness(shared);
		const shardOneHarness = await createHarness(shared);
		try {
			const shardZero = stageGeneration(shardZeroHarness, 0);
			await commitGeneration(shardZeroHarness, shardZero);
			const shardOne = stageGeneration(shardOneHarness, 1);
			await commitGeneration(shardOneHarness, shardOne);
			const zeroPosition = nextPosition(shardZeroHarness, shardZero, 2);
			const onePosition = nextPosition(shardOneHarness, shardOne, 2);

			await shardOneHarness.controller.runWithCause(onePosition, () =>
				shardOneHarness.adapter.set('user.shared', { id: 'shared', source: 'one-first' }),
			);
			await shardZeroHarness.controller.runWithCause(zeroPosition, () =>
				shardZeroHarness.adapter.set('user.shared', { id: 'shared', source: 'zero-later' }),
			);
			assert.deepEqual(await shardOneHarness.adapter.get('user.shared'), {
				id: 'shared',
				source: 'zero-later',
			});

			const zeroLater = nextPosition(shardZeroHarness, shardZero, 3);
			const oneLater = nextPosition(shardOneHarness, shardOne, 3);
			await shardZeroHarness.controller.runWithCause(zeroLater, () =>
				shardZeroHarness.adapter.set('user.shared', { id: 'shared', source: 'zero-first' }),
			);
			await shardOneHarness.controller.runWithCause(oneLater, () =>
				shardOneHarness.adapter.set('user.shared', { id: 'shared', source: 'one-later' }),
			);
			assert.deepEqual(await shardZeroHarness.adapter.get('user.shared'), {
				id: 'shared',
				source: 'one-later',
			});
		} finally {
			await dispose(shardOneHarness, shardZeroHarness);
		}
	});

	redisTest('preserves writes admitted after a concurrent flush cut, including unmanaged metadata', async () => {
		const shared = namespaces();
		const resolver: ScopeResolver = target =>
			target.kind === 'value' && target.key.startsWith('raw.') ? undefined : GLOBAL_VISIBILITY_SCOPE;
		const managed = (key: string) => !key.startsWith('raw.');
		const flushing = await createHarness({ ...shared, isManagedValue: managed, resolveScope: resolver });
		const writer = await createHarness({ ...shared, isManagedValue: managed, resolveScope: resolver });
		const unrelatedKey = `outside-${randomUUID()}`;
		try {
			await flushing.adapter.set('item.old', { id: 'old' });
			await flushing.adapter.set('raw.old', { id: 'raw-old' });
			await flushing.adapter.set('item.member.member-old', { id: 'member-old' });
			await flushing.adapter.addToRelationship('item.member', 'member-old');
			await flushing.client.hSet(unrelatedKey, toDb({ id: 'outside' }));
			assert.equal((await rawState(flushing, JSON.stringify(['value', 'raw.old'])))?.scope, 'unmanaged');

			const scanStarted = deferred();
			const releaseScan = deferred();
			const originalScan = flushing.client.scanIterator.bind(flushing.client);
			let block = true;
			vi.spyOn(flushing.client, 'scanIterator').mockImplementation(options => {
				const iterator = originalScan(options);
				return (async function* () {
					if (block) {
						block = false;
						scanStarted.resolve();
						await releaseScan.promise;
					}
					yield* iterator;
				})();
			});
			const flush = Promise.resolve(flushing.adapter.flush());
			await scanStarted.promise;
			await writer.adapter.set('item.old', { id: 'new' });
			await writer.adapter.set('raw.new', { id: 'raw-new' });
			await writer.adapter.set('item.member.member-new', { id: 'member-new' });
			await writer.adapter.addToRelationship('item.member', 'member-new');
			releaseScan.resolve();
			await flush;

			assert.deepEqual(await writer.adapter.get('item.old'), { id: 'new' });
			assert.equal(await writer.adapter.get('raw.old'), null);
			assert.deepEqual(await writer.adapter.get('raw.new'), { id: 'raw-new' });
			assert.deepEqual(await writer.adapter.getToRelationship('item.member'), ['member-new']);
			assert.equal((await rawState(writer, JSON.stringify(['value', 'raw.new'])))?.scope, 'unmanaged');
			assert.equal(await writer.client.exists(unrelatedKey), 1);
		} finally {
			if (writer.client.isOpen) await writer.client.del(unrelatedKey);
			await dispose(writer, flushing);
		}
	});

	redisTest('serializes concurrent flush barriers across coordinators', async () => {
		const shared = namespaces();
		const first = await createHarness({ ...shared, leaseTtlMs: 300 });
		const second = await createHarness({ ...shared, leaseTtlMs: 300 });
		try {
			const scanStarted = deferred();
			const releaseScan = deferred();
			const originalScan = first.client.scanIterator.bind(first.client);
			let block = true;
			vi.spyOn(first.client, 'scanIterator').mockImplementation(options => {
				const iterator = originalScan(options);
				return (async function* () {
					if (block) {
						block = false;
						scanStarted.resolve();
						await releaseScan.promise;
					}
					yield* iterator;
				})();
			});
			const firstFlush = Promise.resolve(first.adapter.flush());
			await scanStarted.promise;
			let secondSettled = false;
			const secondFlush = Promise.resolve(second.adapter.flush()).then(() => {
				secondSettled = true;
			});
			await delay(80);
			assert.isFalse(secondSettled);
			releaseScan.resolve();
			await Promise.all([firstFlush, secondFlush]);
			assert.isTrue(secondSettled);
		} finally {
			await dispose(second, first);
		}
	});

	redisTest('terminal-fails and releases ownership when generation commit transport fails', async () => {
		let scope: ShardGeneration | undefined;
		const harness = await createHarness({
			leaseTtlMs: 300,
			resolveScope: (_target, position) => position?.generation ?? scope,
		});
		try {
			scope = stageGeneration(harness, 0);
			const position = nextPosition(harness, scope, 2);
			await harness.controller.runWithCause(position, () => harness.adapter.set('guild.pending', { id: 'pending' }));
			const key = await leaseKey(harness, 0);
			vi.spyOn(harness.client, 'evalSha').mockRejectedValueOnce(new Error('commit transport failed'));

			await expect(commitGeneration(harness, scope)).rejects.toThrow('commit transport failed');
			assert.equal(harness.state.lifecycle, 'failed');
			assert.deepEqual(
				harness.terminal.map(entry => entry.code),
				['redis-generation-commit-failed'],
			);
			await eventually(async () => (await harness.client.exists(key)) === 0);
		} finally {
			await dispose(harness);
		}
	});

	redisTest('deactivates immediately and releases live ownership for a successor before TTL expiry', async () => {
		const shared = namespaces();
		let oldScope: ShardGeneration | undefined;
		const old = await createHarness({
			...shared,
			leaseTtlMs: 1_500,
			resolveScope: (_target, position) => position?.generation ?? oldScope,
		});
		let successor: RedisHarness | undefined;
		try {
			oldScope = stageGeneration(old, 0, 'old-owner');
			await commitGeneration(old, oldScope);
			const position = nextPosition(old, oldScope, 2);
			await old.controller.runWithCause(position, () => old.adapter.set('guild.old', { id: 'old' }));
			const oldLeaseKey = await leaseKey(old, 0);

			const release = old.binding.deactivate?.();
			assert.equal(await old.adapter.get('guild.old'), null);
			await release;
			assert.equal(await old.client.exists(oldLeaseKey), 0);
			assert.equal(await old.client.zCard(`${old.controlNamespace}:live-epochs`), 0);
			const liveKeys: string[] = [];
			for await (const batch of old.client.scanIterator({ MATCH: `${old.controlNamespace}:live:*` })) {
				liveKeys.push(...batch);
			}
			assert.deepEqual(liveKeys, []);

			let successorScope: ShardGeneration | undefined;
			successor = await createHarness({
				...shared,
				leaseTtlMs: 1_500,
				resolveScope: (_target, next) => next?.generation ?? successorScope,
			});
			successorScope = stageGeneration(successor, 0, 'successor-owner');
			await commitGeneration(successor, successorScope);
			assert.isAbove(await successor.client.pTTL(await leaseKey(successor, 0)), 0);
			assert.deepEqual(successor.terminal, []);
		} finally {
			await dispose(...(successor ? [successor, old] : [old]));
		}
	});

	redisTest('renews an active shard lease beyond two TTL windows', async () => {
		let scope: ShardGeneration | undefined;
		const harness = await createHarness({
			leaseTtlMs: 300,
			resolveScope: (_target, position) => position?.generation ?? scope,
		});
		try {
			scope = stageGeneration(harness, 0);
			await commitGeneration(harness, scope);
			const key = await leaseKey(harness, 0);
			await delay(750);
			assert.isAbove(await harness.client.pTTL(key), 0);
			const position = nextPosition(harness, scope, 2);
			await harness.controller.runWithCause(position, () => harness.adapter.set('guild.alive', { id: 'alive' }));
			assert.deepEqual(await harness.adapter.get('guild.alive'), { id: 'alive' });
			assert.deepEqual(harness.terminal, []);
		} finally {
			await dispose(harness);
		}
	});

	redisTest('fails renewal once without an unhandled rejection and cannot release a successor lease', async () => {
		const shared = namespaces();
		let oldScope: ShardGeneration | undefined;
		const old = await createHarness({
			...shared,
			leaseTtlMs: 300,
			resolveScope: (_target, position) => position?.generation ?? oldScope,
		});
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown) => unhandled.push(error);
		process.on('unhandledRejection', onUnhandled);
		let successor: RedisHarness | undefined;
		try {
			oldScope = stageGeneration(old, 0, 'old');
			await commitGeneration(old, oldScope);
			await old.client.del(await leaseKey(old, 0));
			await eventually(() => old.terminal.length === 1);
			assert.equal(old.state.lifecycle, 'failed');

			let successorScope: ShardGeneration | undefined;
			successor = await createHarness({
				...shared,
				leaseTtlMs: 300,
				resolveScope: (_target, position) => position?.generation ?? successorScope,
			});
			successorScope = stageGeneration(successor, 0, 'successor');
			await commitGeneration(successor, successorScope);
			await old.adapter.close();
			assert.equal(await successor.client.exists(await leaseKey(successor, 0)), 1);
			await delay(0);
			assert.deepEqual(unhandled, []);
			assert.lengthOf(old.terminal, 1);
		} finally {
			process.off('unhandledRejection', onUnhandled);
			await dispose(...(successor ? [successor, old] : [old]));
		}
	});
});
