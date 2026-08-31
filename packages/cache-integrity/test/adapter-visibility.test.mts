import type { Adapter } from 'seyfert';
import { MemoryAdapter } from 'seyfert';
import { assert, describe, expect, test, vi } from 'vitest';
import { localCoordinator } from '../src';
import { ReconciledAdapter } from '../src/adapter';
import { AdapterReconciliationController } from '../src/adapter-controller';
import { GLOBAL_VISIBILITY_SCOPE, ReconciliationState } from '../src/reconciliation-state';
import { deferred } from './deferred';

function hooks() {
	return {
		beforeStart() {},
		onFailed(error: unknown) {
			throw error;
		},
		onStarted() {},
	};
}

function globalController(resolve = true) {
	const state = new ReconciliationState();
	state.activate();
	const controller = new AdapterReconciliationController(state, {
		resolveScope: () => (resolve ? GLOBAL_VISIBILITY_SCOPE : undefined),
	});
	return { controller, state };
}

function reconciled(inner: Adapter, controller?: AdapterReconciliationController) {
	return new ReconciledAdapter(inner, localCoordinator(), hooks(), controller);
}

class PrefixedMemoryAdapter extends MemoryAdapter<unknown> {
	scan(query: string, keys?: false): unknown[];
	scan(query: string, keys: true): string[];
	scan(query: string, keys?: boolean): (string | unknown)[] {
		return keys ? super.scan(this.physicalKey(query), true) : super.scan(this.physicalKey(query));
	}

	bulkGet(keys: string[]): unknown[] {
		return super.bulkGet(keys.map(key => this.physicalKey(key)));
	}

	get(key: string): unknown | null {
		return super.get(this.physicalKey(key));
	}

	set(key: string, data: unknown): void {
		super.set(this.physicalKey(key), data);
	}

	keys(to: string): string[] {
		return super.keys(to).map(key => this.physicalKey(key));
	}

	private physicalKey(key: string): string {
		return key.startsWith('ns:') ? key : `ns:${key}`;
	}
}

describe('ReconciledAdapter visibility projection', () => {
	test('filters visible, unknown, and hidden values across every read family', () => {
		const inner = new MemoryAdapter();
		const { controller } = globalController();
		const adapter = reconciled(inner, controller);
		adapter.set('item.visible', { id: 'visible' });
		adapter.addToRelationship('item', 'visible');

		inner.set('item.unknown', { id: 'unknown' });
		inner.addToRelationship('item', 'unknown');
		assert.isTrue(controller.preserveValueUnknown('item.unknown', GLOBAL_VISIBILITY_SCOPE));

		adapter.set('item.hidden', { id: 'hidden' });
		adapter.addToRelationship('item', 'hidden');
		const originalRemove = inner.remove;
		inner.remove = () => {
			throw new Error('storage stayed stale');
		};
		expect(() => adapter.remove('item.hidden')).toThrow(/storage stayed stale/);
		inner.remove = originalRemove;

		assert.deepEqual(adapter.get('item.visible'), { id: 'visible' });
		assert.equal(adapter.get('item.unknown'), null);
		assert.equal(adapter.get('item.hidden'), null);
		assert.deepEqual(adapter.bulkGet(['item.hidden', 'item.visible', 'item.unknown']), [{ id: 'visible' }]);
		assert.deepEqual(adapter.scan('item.*', true), ['item.visible']);
		assert.deepEqual(adapter.scan('item.*'), [{ id: 'visible' }]);
		assert.deepEqual(adapter.keys('item'), ['item.visible']);
		assert.deepEqual(adapter.values('item'), [{ id: 'visible' }]);
		assert.equal(adapter.count('item'), 1);
		assert.isTrue(adapter.contains('item', 'visible'));
		assert.isFalse(adapter.contains('item', 'unknown'));
		assert.isFalse(adapter.contains('item', 'hidden'));
		assert.deepEqual(adapter.getToRelationship('item'), ['visible']);
	});

	test('resolves Base, GuildBased, and GuildRelated relationship entity keys canonically', () => {
		const inner = new MemoryAdapter();
		const { controller } = globalController();
		const adapter = reconciled(inner, controller);

		adapter.set('user.u', { id: 'u' });
		adapter.addToRelationship('user', 'u');
		adapter.set('member.g.m', { id: 'm' });
		adapter.addToRelationship('member.g', 'm');
		adapter.set('channel.c', { id: 'c' });
		adapter.addToRelationship('channel.g', 'c');

		assert.deepEqual(adapter.keys('user'), ['user.u']);
		assert.deepEqual(adapter.keys('member.g'), ['member.g.m']);
		assert.deepEqual(adapter.keys('channel.g'), ['channel.g.c']);
		assert.deepEqual(adapter.values('channel.g'), [{ id: 'c' }]);
		assert.equal(inner.get('channel.g.c'), null);
		assert.deepEqual(inner.get('channel.c'), { id: 'c' });
	});

	test('filters canonical identities while preserving adapter-owned scan and keys output', () => {
		const inner = new PrefixedMemoryAdapter();
		const state = new ReconciliationState();
		state.activate();
		const controller = new AdapterReconciliationController(state, {
			canonicalizeKey: key => (key.startsWith('ns:') ? key.slice(3) : key),
			resolveScope: () => GLOBAL_VISIBILITY_SCOPE,
		});
		const adapter = reconciled(inner, controller);
		adapter.set('item.a', { id: 'a' });
		adapter.addToRelationship('item', 'a');

		assert.deepEqual(inner.scan('item.*', true), ['ns:item.a']);
		assert.deepEqual(adapter.scan('item.*', true), ['ns:item.a']);
		assert.deepEqual(inner.keys('item'), ['ns:item.a']);
		assert.deepEqual(adapter.keys('item'), ['ns:item.a']);
		assert.deepEqual(adapter.values('item'), [{ id: 'a' }]);
	});

	test('requires a matching value fence for causal relationship writes but permits standalone adds', () => {
		const inner = new MemoryAdapter();
		const { controller, state } = globalController();
		const adapter = reconciled(inner, controller);
		adapter.set('item.standalone', { value: 'old' });
		adapter.addToRelationship('item', 'standalone');
		assert.deepEqual(adapter.getToRelationship('item'), ['standalone']);

		adapter.set('item.causal', { value: 'old' });
		const generation = state.openGeneration({
			expectedGuildIds: [],
			sequence: 1,
			sessionId: 'session',
			shardId: 0,
		});
		state.markGuildsReady(generation);
		const position = state.observePacket(generation, 2);
		controller.runWithCause(position, () => adapter.addToRelationship('item', 'causal'));
		assert.deepEqual(adapter.getToRelationship('item'), ['standalone']);
		controller.runWithCause(position, () => adapter.set('item.causal', { value: 'new' }));
		assert.deepEqual(adapter.getToRelationship('item'), ['standalone', 'causal']);
		assert.deepEqual(adapter.get('item.causal'), { value: 'new' });
	});

	test('invalidates causal context inherited by detached children', async () => {
		const state = new ReconciliationState();
		state.activate();
		const generation = state.openGeneration({
			expectedGuildIds: [],
			sequence: 1,
			sessionId: 'session',
			shardId: 0,
		});
		state.markGuildsReady(generation);
		const position = state.observePacket(generation, 2);
		const controller = new AdapterReconciliationController(state, {
			resolveScope: (_target, current) => (current ? GLOBAL_VISIBILITY_SCOPE : undefined),
		});
		const adapter = reconciled(new MemoryAdapter(), controller);
		controller.runWithCause(position, () => adapter.set('item.a', { id: 'a' }));
		const gate = deferred();
		let detached!: Promise<void>;
		controller.runWithCause(position, () => {
			detached = Promise.resolve().then(async () => {
				await gate.promise;
				await adapter.addToRelationship('item', 'a');
			});
		});
		gate.resolve();
		await detached;
		assert.deepEqual(adapter.getToRelationship('item'), []);
		controller.runWithCause(position, () => adapter.addToRelationship('item', 'a'));
		assert.deepEqual(adapter.getToRelationship('item'), ['a']);
	});

	test('uses independent collision-proof relationship membership and clear tokens', () => {
		const inner = new MemoryAdapter();
		const { controller } = globalController();
		const adapter = reconciled(inner, controller);
		for (const key of ['thing.a.b', 'thing.b', 'thing.["relationship","a","b"]']) {
			adapter.set(key, { id: key });
		}
		adapter.addToRelationship('thing.a', 'b');
		adapter.addToRelationship('thing', 'a.b');
		adapter.addToRelationship('thing', '["relationship","a","b"]');

		adapter.removeToRelationship('thing.a', 'b');
		assert.deepEqual(adapter.getToRelationship('thing.a'), []);
		assert.deepEqual(adapter.getToRelationship('thing'), ['a.b', '["relationship","a","b"]']);

		const original = inner.removeRelationship;
		inner.removeRelationship = () => {
			throw new Error('clear failed');
		};
		expect(() => adapter.removeRelationship('thing')).toThrow(/clear failed/);
		inner.removeRelationship = original;
		assert.deepEqual(adapter.getToRelationship('thing'), []);

		adapter.set('thing.fresh', { id: 'fresh' });
		adapter.addToRelationship('thing', 'fresh');
		assert.deepEqual(adapter.getToRelationship('thing'), ['fresh']);
	});

	test('never positional-filters compact bulkGet results', () => {
		const inner = new MemoryAdapter();
		const { controller } = globalController();
		const adapter = reconciled(inner, controller);
		adapter.set('item.a', { id: 'a' });
		inner.set('item.hidden', { id: 'hidden' });
		adapter.set('item.b', { id: 'b' });
		const spy = vi.spyOn(inner, 'bulkGet');

		assert.deepEqual(adapter.bulkGet(['item.hidden', 'item.a', 'missing', 'item.b']), [{ id: 'a' }, { id: 'b' }]);
		expect(spy).toHaveBeenCalledWith(['item.a', 'item.b']);
	});
});

describe('ReconciledAdapter unfiltered read scope', () => {
	test('is task-local, reentrant, await-safe, and restored after errors', async () => {
		const inner = new MemoryAdapter();
		const { controller } = globalController();
		const adapter = reconciled(inner, controller);
		inner.set('item.hidden', { id: 'hidden' });
		assert.isTrue(controller.preserveValueUnknown('item.hidden', GLOBAL_VISIBILITY_SCOPE));
		assert.equal(adapter.get('item.hidden'), null);

		const marker = {};
		assert.equal(
			adapter.runUnfiltered(() => marker),
			marker,
		);
		assert.deepEqual(
			adapter.runUnfiltered(() => adapter.get('item.hidden')),
			{ id: 'hidden' },
		);
		assert.deepEqual(
			adapter.runUnfiltered(() => adapter.runUnfiltered(() => adapter.get('item.hidden'))),
			{ id: 'hidden' },
		);

		const gate = deferred();
		const scoped = adapter.runUnfiltered(async () => {
			await gate.promise;
			return adapter.get('item.hidden');
		});
		assert.equal(
			adapter.runUnfiltered(() => scoped),
			scoped,
		);
		assert.equal(adapter.get('item.hidden'), null);
		gate.resolve();
		assert.deepEqual(await scoped, { id: 'hidden' });
		assert.equal(adapter.get('item.hidden'), null);

		expect(() =>
			adapter.runUnfiltered(() => {
				throw new Error('scope throw');
			}),
		).toThrow(/scope throw/);
		await expect(adapter.runUnfiltered(async () => Promise.reject(new Error('scope reject')))).rejects.toThrow(
			/scope reject/,
		);
		assert.equal(adapter.get('item.hidden'), null);
	});

	test('invalidates the inherited lease of detached children', async () => {
		const inner = new MemoryAdapter();
		const { controller } = globalController();
		const adapter = reconciled(inner, controller);
		inner.set('item.hidden', { id: 'hidden' });
		controller.preserveValueUnknown('item.hidden', GLOBAL_VISIBILITY_SCOPE);
		const gate = deferred();
		let detached!: Promise<unknown>;

		adapter.runUnfiltered(() => {
			detached = Promise.resolve().then(async () => {
				await gate.promise;
				return adapter.get('item.hidden');
			});
		});
		gate.resolve();
		assert.equal(await detached, null);
	});

	test('keeps hidden entries physically discoverable only inside the scope', () => {
		const inner = new MemoryAdapter();
		const { controller } = globalController();
		const adapter = reconciled(inner, controller);
		inner.set('child.hidden', { id: 'hidden' });
		controller.preserveValueUnknown('child.hidden', GLOBAL_VISIBILITY_SCOPE);
		assert.deepEqual(adapter.scan('child.*', true), []);
		assert.deepEqual(
			adapter.runUnfiltered(() => adapter.scan('child.*', true)),
			['child.hidden'],
		);
	});
});
