import { createClient } from '@redis/client';
import { ExpirableRedisAdapter, RedisAdapter } from '@slipher/redis-adapter';
import type { Adapter } from 'seyfert';
import { Client } from 'seyfert';
import { assert, describe, expect, test, vi } from 'vitest';
import { cacheIntegrity } from '../src';
import { ReconciledAdapter } from '../src/adapter';
import { AdapterReconciliationController } from '../src/adapter-controller';
import {
	bindCoordinator,
	type CoordinatedMutationRequest,
	type CoordinatedReadRequest,
	type CoordinatedStorage,
	type CoordinatorBindInput,
	type CoordinatorBinding,
	type ReconciliationCoordinator,
} from '../src/coordinator';
import { redisCoordinator } from '../src/coordinators/redis';
import { GLOBAL_VISIBILITY_SCOPE, ReconciliationState } from '../src/reconciliation-state';
import { type AdapterDataMethod, adapterDataCalls, adapterReadMethods } from './adapter-data-methods';
import { deferred } from './deferred';

class RedisBindingClient extends Client {}

function mutationEntries(request: CoordinatedMutationRequest): number {
	switch (request.kind) {
		case 'claimed-delete':
		case 'flush':
			return 1;
		default:
			return request.entries.length;
	}
}

function readResult(request: CoordinatedReadRequest): unknown {
	switch (request.kind) {
		case 'get':
			return null;
		case 'contains':
			return false;
		case 'count':
			return 0;
		default:
			return [];
	}
}

function asyncInner(): Adapter & Record<AdapterDataMethod | 'start', ReturnType<typeof vi.fn>> {
	const forbidden = () => Promise.reject(new Error('inner data method must not be called'));
	return {
		isAsync: true,
		start: vi.fn(async () => undefined),
		scan: vi.fn(forbidden),
		bulkGet: vi.fn(forbidden),
		get: vi.fn(forbidden),
		bulkSet: vi.fn(forbidden),
		set: vi.fn(forbidden),
		bulkPatch: vi.fn(forbidden),
		patch: vi.fn(forbidden),
		values: vi.fn(forbidden),
		keys: vi.fn(forbidden),
		count: vi.fn(forbidden),
		bulkRemove: vi.fn(forbidden),
		remove: vi.fn(forbidden),
		flush: vi.fn(forbidden),
		contains: vi.fn(forbidden),
		getToRelationship: vi.fn(forbidden),
		bulkAddToRelationShip: vi.fn(forbidden),
		addToRelationship: vi.fn(forbidden),
		removeToRelationship: vi.fn(forbidden),
		removeRelationship: vi.fn(forbidden),
	};
}

function ownershipHarness(closeGate = deferred()) {
	const inner = asyncInner();
	const state = new ReconciliationState();
	state.activate();
	const controller = new AdapterReconciliationController(state, {
		resolveScope: () => GLOBAL_VISIBILITY_SCOPE,
	});
	const storage: CoordinatedStorage = {
		async read(request) {
			return readResult(request);
		},
		async mutate(request) {
			return { admitted: Array.from({ length: mutationEntries(request) }, () => true) };
		},
	};
	const coordinator: ReconciliationCoordinator = {
		kind: 'storage-owner-test',
		async close() {
			await closeGate.promise;
		},
		start() {},
	};
	const binding: CoordinatorBinding = { storage };
	const adapter = new ReconciledAdapter(
		inner,
		coordinator,
		{
			beforeStart() {},
			onFailed(error) {
				throw error;
			},
			onStarted() {},
		},
		controller,
		binding,
	);
	return { adapter, closeGate, inner, storage };
}

function assertNoInnerDataCalls(inner: ReturnType<typeof asyncInner>): void {
	for (const method of Object.keys(adapterDataCalls) as AdapterDataMethod[]) {
		expect(inner[method]).not.toHaveBeenCalled();
	}
}

function bindInput(adapter: Adapter): CoordinatorBindInput {
	const state = new ReconciliationState();
	state.activate();
	return {
		adapter,
		controller: new AdapterReconciliationController(state, {
			resolveScope: () => GLOBAL_VISIBILITY_SCOPE,
		}),
		onTerminal() {},
		state,
	};
}

describe('Redis storage ownership', () => {
	test.each(
		Object.entries(adapterDataCalls),
	)('%s is owned by coordinated storage and never delegates', async (_method, invoke) => {
		const { adapter, closeGate, inner } = ownershipHarness();

		await Promise.resolve(invoke(adapter));

		assertNoInnerDataCalls(inner);
		closeGate.resolve();
		await adapter.close();
	});

	test.each(adapterReadMethods)('%s stays coordinator-owned inside the unfiltered scope', async method => {
		const { adapter, closeGate, inner } = ownershipHarness();

		await Promise.resolve(adapter.runUnfiltered(() => adapterDataCalls[method](adapter)));

		assertNoInnerDataCalls(inner);
		closeGate.resolve();
		await adapter.close();
	});

	test.each(
		Object.entries(adapterDataCalls),
	)('%s never delegates through a retained closing wrapper', async (_method, invoke) => {
		const { adapter, closeGate, inner } = ownershipHarness();
		const closing = adapter.close();

		await Promise.resolve(invoke(adapter));

		assertNoInnerDataCalls(inner);
		closeGate.resolve();
		await closing;
	});

	test('delegates only lifecycle start while coordinated storage owns data', async () => {
		const { adapter, closeGate, inner } = ownershipHarness();

		await adapter.start();
		await adapter.set('item.one', { id: 'one' });

		expect(inner.start).toHaveBeenCalledTimes(1);
		assertNoInnerDataCalls(inner);
		closeGate.resolve();
		await adapter.close();
	});
});

describe('redisCoordinator validation and binding', () => {
	test.each([
		['empty', ''],
		['trailing separator', 'cache:'],
		['asterisk', 'cache*'],
		['question mark', 'cache?'],
		['opening bracket', 'cache['],
		['closing bracket', 'cache]'],
		['escape', 'cache\\'],
	] as const)('rejects a %s namespace', (_label, namespace) => {
		const client = createClient();
		expect(() => redisCoordinator({ cacheNamespace: 'cache', client, namespace })).toThrow(/namespace|glob/i);
	});

	test.each([Number.NaN, 0, 299, 300.5, 2_147_483_648])('rejects invalid lease TTL %s', leaseTtlMs => {
		const client = createClient();
		expect(() => redisCoordinator({ cacheNamespace: 'cache', client, leaseTtlMs, namespace: 'control' })).toThrow(
			/leaseTtlMs/,
		);
	});

	test.each([
		['cache', 'cache'],
		['cache', 'cache:control'],
		['cache:values', 'cache'],
	] as const)('rejects overlapping keyspaces %s and %s', (cacheNamespace, namespace) => {
		const client = createClient();
		expect(() => redisCoordinator({ cacheNamespace, client, namespace })).toThrow(/disjoint/);
	});

	test('rejects a node-redis keyPrefix', () => {
		const client = createClient({ keyPrefix: 'prefix:' });
		expect(() => redisCoordinator({ cacheNamespace: 'cache', client, namespace: 'control' })).toThrow(/keyPrefix/);
	});

	test('binds only the exact RedisAdapter with the same client and cache namespace', () => {
		const client = createClient();
		const adapter = new RedisAdapter({ client, namespace: 'cache' });
		const coordinator = redisCoordinator({ cacheNamespace: 'cache', client, namespace: 'control' });

		assert.isDefined(bindCoordinator(coordinator, bindInput(adapter))?.storage);
		expect(() => bindCoordinator(coordinator, bindInput(adapter))).toThrow(/only be bound once/);
	});

	test('rejects ExpirableRedisAdapter and subclasses before plugin adapter replacement', () => {
		class RedisAdapterSubclass extends RedisAdapter {}

		for (const adapter of [
			new ExpirableRedisAdapter({ client: createClient(), namespace: 'cache' }),
			new RedisAdapterSubclass({ client: createClient(), namespace: 'cache' }),
		]) {
			const coordinator = redisCoordinator({
				cacheNamespace: 'cache',
				client: adapter.client,
				namespace: 'control',
			});
			const plugin = cacheIntegrity({ coordinator });
			const client = new RedisBindingClient({ logger: { active: false }, plugins: [plugin] as never });
			client.setServices({ cache: { adapter } });

			expect(() => plugin.setup?.(client as never)).toThrow(/ExpirableRedisAdapter|exact .*RedisAdapter/);
			assert.equal(client.cache.adapter, adapter);
		}
	});

	test('rejects a different adapter client or namespace', () => {
		const client = createClient();
		const otherClient = createClient();

		expect(() =>
			bindCoordinator(
				redisCoordinator({ cacheNamespace: 'cache', client, namespace: 'control' }),
				bindInput(new RedisAdapter({ client: otherClient, namespace: 'cache' })),
			),
		).toThrow(/same client/);
		expect(() =>
			bindCoordinator(
				redisCoordinator({ cacheNamespace: 'cache', client, namespace: 'control' }),
				bindInput(new RedisAdapter({ client, namespace: 'other-cache' })),
			),
		).toThrow(/cacheNamespace/);
	});
});
