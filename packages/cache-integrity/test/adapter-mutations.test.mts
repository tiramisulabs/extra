import type { Adapter } from 'seyfert';
import { MemoryAdapter } from 'seyfert';
import { assert, describe, expect, test, vi } from 'vitest';
import { localCoordinator } from '../src';
import { ReconciledAdapter } from '../src/adapter';
import { AdapterReconciliationController } from '../src/adapter-controller';
import { GLOBAL_VISIBILITY_SCOPE, ReconciliationState } from '../src/reconciliation-state';

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

function valueStateKey(key: string): string {
	return JSON.stringify(['value', key]);
}

function relationshipStateKey(to: string, id: string): string {
	return JSON.stringify(['relationship', to, id]);
}

function relationshipClearStateKey(to: string): string {
	return JSON.stringify(['relationship-clear', to]);
}

class RecordingRelationshipAdapter extends MemoryAdapter<unknown> {
	bulkAdds: Record<string, string[]>[] = [];
	memberRemoves: { keys: string | string[]; to: string }[] = [];
	relationshipRemoves: (string | string[])[] = [];

	bulkAddToRelationShip(data: Record<string, string[]>): void {
		this.bulkAdds.push(Object.fromEntries(Object.entries(data).map(([to, ids]) => [to, [...ids]])));
		return super.bulkAddToRelationShip(data);
	}

	removeToRelationship(to: string, keys: string | string[]): void {
		this.memberRemoves.push({ keys: Array.isArray(keys) ? [...keys] : keys, to });
		return super.removeToRelationship(to, keys);
	}

	removeRelationship(to: string | string[]): void {
		this.relationshipRemoves.push(Array.isArray(to) ? [...to] : to);
		return super.removeRelationship(to);
	}

	resetCalls(): void {
		this.bulkAdds = [];
		this.memberRemoves = [];
		this.relationshipRemoves = [];
	}
}

describe('ReconciledAdapter mutations and failure semantics', () => {
	test('commits set, bulkSet, patch, and bulkPatch only after successful storage mutation', () => {
		const inner = new MemoryAdapter();
		const { controller } = globalController();
		const adapter = reconciled(inner, controller);
		adapter.set('item.a', { id: 'a', value: 1 });
		adapter.bulkSet([
			['item.b', { id: 'b', value: 1 }],
			['item.c', { id: 'c', value: 1 }],
		]);
		adapter.patch('item.a', { value: 2 });
		adapter.bulkPatch([
			['item.b', { value: 2 }],
			['item.c', { value: 3 }],
		]);
		assert.deepEqual(adapter.scan('item.*'), [
			{ id: 'a', value: 2 },
			{ id: 'b', value: 2 },
			{ id: 'c', value: 3 },
		]);

		const original = inner.set;
		inner.set = () => {
			throw new Error('write failed');
		};
		expect(() => adapter.set('item.new', { id: 'new' })).toThrow(/write failed/);
		inner.set = original;
		assert.equal(adapter.get('item.new'), null);
		assert.deepEqual(adapter.get('item.a'), { id: 'a', value: 2 });
	});

	test('hides bytes when storage mutates before reporting a failed write', () => {
		const inner = new MemoryAdapter();
		const { controller, state } = globalController();
		const adapter = reconciled(inner, controller);
		adapter.set('item.ambiguous', { id: 'ambiguous', value: 'before' });
		const originalSet = inner.set.bind(inner);
		inner.set = (key, value) => {
			originalSet(key, value);
			throw new Error('write failed after mutation');
		};

		expect(() => adapter.set('item.ambiguous', { id: 'ambiguous', value: 'after' })).toThrow(
			/write failed after mutation/,
		);

		assert.deepEqual(inner.get('item.ambiguous'), { id: 'ambiguous', value: 'after' });
		assert.equal(adapter.get('item.ambiguous'), null);
		assert.equal(state.ownedVisibilityOf(valueStateKey('item.ambiguous'))?.state, 'unknown-preserved');
	});

	test('filters stale entries without reordering partial value and relationship batches', () => {
		const inner = new MemoryAdapter();
		const { controller, state } = globalController();
		const generation = state.openGeneration({
			expectedGuildIds: [],
			sequence: 1,
			sessionId: 'session',
			shardId: 0,
		});
		state.markGuildsReady(generation);
		const adapter = reconciled(inner, controller);
		adapter.bulkSet([
			['item.a', { id: 'a', value: 0 }],
			['item.b', { id: 'b', value: 0 }],
		]);
		adapter.bulkAddToRelationShip({ item: ['a', 'b'] });
		const oldPosition = state.observePacket(generation, 2);
		adapter.remove('item.a');
		adapter.removeToRelationship('item', 'a');
		const bulkSet = vi.spyOn(inner, 'bulkSet');
		const bulkPatch = vi.spyOn(inner, 'bulkPatch');
		const bulkRelationship = vi.spyOn(inner, 'bulkAddToRelationShip');

		controller.runWithCause(oldPosition, () =>
			adapter.bulkSet([
				['item.a', { id: 'a', value: 1 }],
				['item.b', { id: 'b', value: 1 }],
			]),
		);
		controller.runWithCause(oldPosition, () =>
			adapter.bulkPatch([
				['item.a', { value: 2 }],
				['item.b', { value: 2 }],
			]),
		);
		controller.runWithCause(oldPosition, () => adapter.bulkAddToRelationShip({ item: ['a', 'b'] }));

		expect(bulkSet).toHaveBeenCalledWith([['item.b', { id: 'b', value: 1 }]]);
		expect(bulkPatch).toHaveBeenCalledWith([['item.b', { value: 2 }]]);
		expect(bulkRelationship).toHaveBeenCalledWith({ item: ['b'] });
		assert.equal(adapter.get('item.a'), null);
		assert.deepEqual(adapter.get('item.b'), { id: 'b', value: 2 });
	});

	test('keeps unresolved write plans aligned between stale and admitted entries', () => {
		const state = new ReconciliationState();
		state.activate();
		const generation = state.openGeneration({
			expectedGuildIds: [],
			sequence: 1,
			sessionId: 'session',
			shardId: 0,
		});
		state.markGuildsReady(generation);
		const controller = new AdapterReconciliationController(state, {
			resolveScope: target =>
				target.kind === 'value' && target.key === 'item.pass' ? undefined : GLOBAL_VISIBILITY_SCOPE,
		});
		const inner = new MemoryAdapter();
		const adapter = reconciled(inner, controller);
		adapter.bulkSet([
			['item.stale', { value: 0 }],
			['item.valid', { value: 0 }],
		]);
		const oldPosition = state.observePacket(generation, 2);
		adapter.remove('item.stale');
		const bulkSet = vi.spyOn(inner, 'bulkSet');

		controller.runWithCause(oldPosition, () =>
			adapter.bulkSet([
				['item.stale', { value: 1 }],
				['item.pass', { value: 2 }],
				['item.valid', { value: 3 }],
			]),
		);

		expect(bulkSet).toHaveBeenCalledWith([
			['item.pass', { value: 2 }],
			['item.valid', { value: 3 }],
		]);
		assert.equal(state.pendingWork, 0);
	});

	test('prevalidates a value write batch against provisional ownership before staging', async () => {
		const state = new ReconciliationState();
		state.activate();
		const generation = state.openGeneration({
			expectedGuildIds: [],
			sequence: 1,
			sessionId: 'session',
			shardId: 0,
		});
		state.markGuildsReady(generation);
		let resolutions = 0;
		const controller = new AdapterReconciliationController(state, {
			canonicalizeKey: () => 'item.same',
			resolveScope(target) {
				resolutions++;
				return target.kind === 'value' && (target.data as { scope: string }).scope === 'global'
					? GLOBAL_VISIBILITY_SCOPE
					: generation;
			},
		});
		const inner = new MemoryAdapter();
		const bulkSet = vi.spyOn(inner, 'bulkSet');
		const adapter = reconciled(inner, controller);

		expect(() =>
			adapter.bulkSet([
				['physical.first', { scope: 'global' }],
				['physical.second', { scope: 'shard' }],
			]),
		).toThrow(/different visibility scope/);

		expect(bulkSet).not.toHaveBeenCalled();
		assert.equal(resolutions, 2);
		assert.equal(state.pendingWork, 0);
		assert.equal(state.ownedVisibilityOf(valueStateKey('item.same')), undefined);
		await Promise.all([state.waitForIdle(), adapter.waitForIdle()]);
		const proof = state.stageWrite(valueStateKey('item.same'), generation);
		assert.isTrue(state.beginWrite(proof));
		assert.equal(state.completeWrite(proof, true), 'committed');
	});

	test('leaves prior value visibility exact when a later bulk remove resolver throws', async () => {
		const failure = new Error('late value scope failure');
		let fail = false;
		const state = new ReconciliationState();
		state.activate();
		const controller = new AdapterReconciliationController(state, {
			resolveScope(target) {
				if (fail && target.kind === 'value' && target.key === 'item.b') throw failure;
				return GLOBAL_VISIBILITY_SCOPE;
			},
		});
		const inner = new MemoryAdapter();
		const adapter = reconciled(inner, controller);
		adapter.bulkSet([
			['item.a', { id: 'a' }],
			['item.b', { id: 'b' }],
		]);
		const beforeA = state.ownedVisibilityOf(valueStateKey('item.a'));
		const beforeB = state.ownedVisibilityOf(valueStateKey('item.b'));
		const bulkRemove = vi.spyOn(inner, 'bulkRemove');
		fail = true;

		expect(() => adapter.bulkRemove(['item.a', 'item.b'])).toThrow(failure);

		expect(bulkRemove).not.toHaveBeenCalled();
		assert.deepEqual(state.ownedVisibilityOf(valueStateKey('item.a')), beforeA);
		assert.deepEqual(state.ownedVisibilityOf(valueStateKey('item.b')), beforeB);
		assert.deepEqual(inner.get('item.a'), { id: 'a' });
		assert.deepEqual(inner.get('item.b'), { id: 'b' });
		assert.equal(state.pendingWork, 0);
		await Promise.all([state.waitForIdle(), adapter.waitForIdle()]);
	});

	test('prevalidates every relationship batch shape before changing visibility', async () => {
		const failure = new Error('late relationship scope failure');
		let shouldFail: ((target: { id?: string; to: string }) => boolean) | undefined;
		const state = new ReconciliationState();
		state.activate();
		const controller = new AdapterReconciliationController(state, {
			resolveScope(target) {
				if (target.kind === 'relationship' && shouldFail?.(target)) throw failure;
				return GLOBAL_VISIBILITY_SCOPE;
			},
		});
		const inner = new MemoryAdapter();
		const adapter = reconciled(inner, controller);
		adapter.bulkSet([
			['item.a', { id: 'a' }],
			['item.b', { id: 'b' }],
			['other.a', { id: 'other-a' }],
		]);
		adapter.bulkAddToRelationShip({ item: ['a', 'b'], other: ['a'] });
		const beforeA = state.ownedVisibilityOf(relationshipStateKey('item', 'a'));
		const beforeB = state.ownedVisibilityOf(relationshipStateKey('item', 'b'));
		const bulkAdd = vi.spyOn(inner, 'bulkAddToRelationShip');
		const removeMembers = vi.spyOn(inner, 'removeToRelationship');
		const removeBuckets = vi.spyOn(inner, 'removeRelationship');

		shouldFail = target => target.id === 'b';
		expect(() => adapter.bulkAddToRelationShip({ item: ['a', 'b'] })).toThrow(failure);
		expect(() => adapter.removeToRelationship('item', ['a', 'b'])).toThrow(failure);
		shouldFail = target => target.to === 'other';
		expect(() => adapter.removeRelationship(['item', 'other'])).toThrow(failure);

		expect(bulkAdd).not.toHaveBeenCalled();
		expect(removeMembers).not.toHaveBeenCalled();
		expect(removeBuckets).not.toHaveBeenCalled();
		assert.deepEqual(state.ownedVisibilityOf(relationshipStateKey('item', 'a')), beforeA);
		assert.deepEqual(state.ownedVisibilityOf(relationshipStateKey('item', 'b')), beforeB);
		assert.equal(state.ownedVisibilityOf(relationshipClearStateKey('item')), undefined);
		assert.equal(state.ownedVisibilityOf(relationshipClearStateKey('other')), undefined);
		assert.deepEqual(inner.getToRelationship('item'), ['a', 'b']);
		assert.deepEqual(inner.getToRelationship('other'), ['a']);
		assert.equal(state.pendingWork, 0);
		await Promise.all([state.waitForIdle(), adapter.waitForIdle()]);
	});

	test('uses canonical metadata without calling the canonicalizer again after staging', async () => {
		const failure = new Error('canonicalizer called twice');
		let calls = 0;
		const state = new ReconciliationState();
		state.activate();
		const controller = new AdapterReconciliationController(state, {
			canonicalizeKey(key) {
				calls++;
				if (calls === 2) throw failure;
				return key;
			},
			resolveScope: () => GLOBAL_VISIBILITY_SCOPE,
		});
		const inner = new MemoryAdapter();
		const adapter = reconciled(inner, controller);

		expect(() => adapter.set('item.a', { id: 'a' })).not.toThrow();

		assert.equal(calls, 1);
		assert.deepEqual(inner.get('item.a'), { id: 'a' });
		assert.equal(state.ownedVisibilityOf(valueStateKey('item.a'))?.state, 'visible');
		assert.equal(state.pendingWork, 0);
		await Promise.all([state.waitForIdle(), adapter.waitForIdle()]);
	});

	test('uses one value tuple snapshot when the resolver mutates the caller batch', async () => {
		const entries: [string, any][] = [['item.a', { id: 'a' }]];
		const state = new ReconciliationState();
		state.activate();
		const controller = new AdapterReconciliationController(state, {
			resolveScope() {
				entries[0]![0] = 'item.c';
				return GLOBAL_VISIBILITY_SCOPE;
			},
		});
		const inner = new MemoryAdapter();
		const adapter = reconciled(inner, controller);

		adapter.bulkSet(entries);

		assert.equal(entries[0]![0], 'item.c');
		assert.deepEqual(inner.get('item.a'), { id: 'a' });
		assert.equal(inner.get('item.c'), null);
		assert.equal(state.ownedVisibilityOf(valueStateKey('item.a'))?.state, 'visible');
		assert.equal(state.ownedVisibilityOf(valueStateKey('item.c')), undefined);
		assert.equal(state.pendingWork, 0);
		await Promise.all([state.waitForIdle(), adapter.waitForIdle()]);
	});

	test('uses one relationship entry list when the resolver appends a caller ID', async () => {
		const data = { item: ['a'] };
		let mutate = false;
		const state = new ReconciliationState();
		state.activate();
		const controller = new AdapterReconciliationController(state, {
			resolveScope(target) {
				if (mutate && target.kind === 'relationship' && !data.item.includes('b')) data.item.push('b');
				return GLOBAL_VISIBILITY_SCOPE;
			},
		});
		const inner = new MemoryAdapter();
		const adapter = reconciled(inner, controller);
		adapter.bulkSet([
			['item.a', { id: 'a' }],
			['item.b', { id: 'b' }],
		]);
		mutate = true;

		adapter.bulkAddToRelationShip(data);

		assert.deepEqual(data.item, ['a', 'b']);
		assert.deepEqual(inner.getToRelationship('item'), ['a']);
		assert.equal(state.ownedVisibilityOf(relationshipStateKey('item', 'a'))?.state, 'visible');
		assert.equal(state.ownedVisibilityOf(relationshipStateKey('item', 'b')), undefined);
		assert.equal(state.pendingWork, 0);
		await Promise.all([state.waitForIdle(), adapter.waitForIdle()]);
	});

	test('snapshots value remove keys before a resolver appends another target', async () => {
		const keys = ['item.a'];
		let mutate = false;
		const state = new ReconciliationState();
		state.activate();
		const controller = new AdapterReconciliationController(state, {
			resolveScope(target) {
				if (mutate && target.kind === 'value' && !keys.includes('item.b')) keys.push('item.b');
				return GLOBAL_VISIBILITY_SCOPE;
			},
		});
		const inner = new MemoryAdapter();
		const adapter = reconciled(inner, controller);
		adapter.bulkSet([
			['item.a', { id: 'a' }],
			['item.b', { id: 'b' }],
		]);
		const beforeB = state.ownedVisibilityOf(valueStateKey('item.b'));
		mutate = true;

		adapter.bulkRemove(keys);

		assert.deepEqual(keys, ['item.a', 'item.b']);
		assert.equal(inner.get('item.a'), null);
		assert.deepEqual(inner.get('item.b'), { id: 'b' });
		assert.deepEqual(state.ownedVisibilityOf(valueStateKey('item.b')), beforeB);
		assert.equal(state.pendingWork, 0);
		await Promise.all([state.waitForIdle(), adapter.waitForIdle()]);
	});

	test('snapshots relationship remove IDs before a resolver appends another member', async () => {
		const ids = ['a'];
		let mutate = false;
		const state = new ReconciliationState();
		state.activate();
		const controller = new AdapterReconciliationController(state, {
			resolveScope(target) {
				if (mutate && target.kind === 'relationship' && !ids.includes('b')) ids.push('b');
				return GLOBAL_VISIBILITY_SCOPE;
			},
		});
		const inner = new MemoryAdapter();
		const adapter = reconciled(inner, controller);
		adapter.bulkSet([
			['item.a', { id: 'a' }],
			['item.b', { id: 'b' }],
		]);
		adapter.addToRelationship('item', ['a', 'b']);
		const beforeB = state.ownedVisibilityOf(relationshipStateKey('item', 'b'));
		mutate = true;

		adapter.removeToRelationship('item', ids);

		assert.deepEqual(ids, ['a', 'b']);
		assert.deepEqual(inner.getToRelationship('item'), ['b']);
		assert.deepEqual(state.ownedVisibilityOf(relationshipStateKey('item', 'b')), beforeB);
		assert.equal(state.pendingWork, 0);
		await Promise.all([state.waitForIdle(), adapter.waitForIdle()]);
	});

	test('snapshots relationship clear targets before a resolver appends another bucket', async () => {
		const relationships = ['item'];
		let mutate = false;
		const state = new ReconciliationState();
		state.activate();
		const controller = new AdapterReconciliationController(state, {
			resolveScope(target) {
				if (mutate && target.kind === 'relationship' && !relationships.includes('other')) {
					relationships.push('other');
				}
				return GLOBAL_VISIBILITY_SCOPE;
			},
		});
		const inner = new MemoryAdapter();
		const adapter = reconciled(inner, controller);
		adapter.bulkSet([
			['item.a', { id: 'a' }],
			['other.b', { id: 'b' }],
		]);
		adapter.bulkAddToRelationShip({ item: ['a'], other: ['b'] });
		const beforeOther = state.ownedVisibilityOf(relationshipStateKey('other', 'b'));
		mutate = true;

		adapter.removeRelationship(relationships);

		assert.deepEqual(relationships, ['item', 'other']);
		assert.deepEqual(inner.getToRelationship('item'), []);
		assert.deepEqual(inner.getToRelationship('other'), ['b']);
		assert.deepEqual(state.ownedVisibilityOf(relationshipStateKey('other', 'b')), beforeOther);
		assert.equal(state.ownedVisibilityOf(relationshipClearStateKey('other')), undefined);
		assert.equal(state.pendingWork, 0);
		await Promise.all([state.waitForIdle(), adapter.waitForIdle()]);
	});

	test('delegates originally empty relationship mutations exactly once with and without a controller', () => {
		for (const controlled of [false, true]) {
			const inner = new RecordingRelationshipAdapter();
			const tracked = controlled ? globalController() : undefined;
			const adapter = reconciled(inner, tracked?.controller);

			adapter.bulkAddToRelationShip({ item: [] });
			adapter.removeToRelationship('item', []);
			adapter.removeRelationship([]);

			assert.deepEqual(inner.bulkAdds, [{ item: [] }]);
			assert.deepEqual(inner.memberRemoves, [{ keys: [], to: 'item' }]);
			assert.deepEqual(inner.relationshipRemoves, [[]]);
			assert.equal(tracked?.state.pendingWork ?? 0, 0);
		}
	});

	test('keeps non-empty stale relationship batches suppressed while preserving mixed empty buckets', async () => {
		const state = new ReconciliationState();
		state.activate();
		const generation = state.openGeneration({
			expectedGuildIds: [],
			sequence: 1,
			sessionId: 'session',
			shardId: 0,
		});
		state.markGuildsReady(generation);
		const controller = new AdapterReconciliationController(state, {
			resolveScope: () => GLOBAL_VISIBILITY_SCOPE,
		});
		const inner = new RecordingRelationshipAdapter();
		const adapter = reconciled(inner, controller);
		adapter.bulkSet([
			['add.a', { id: 'a' }],
			['fresh.b', { id: 'b' }],
			['remove.a', { id: 'a' }],
		]);
		const oldPosition = state.observePacket(generation, 2);
		adapter.removeToRelationship('add', 'a');
		adapter.addToRelationship('remove', 'a');
		adapter.removeRelationship('clear');
		inner.resetCalls();

		controller.runWithCause(oldPosition, () => {
			adapter.bulkAddToRelationShip({ add: ['a'] });
			adapter.removeToRelationship('remove', ['a']);
			adapter.removeRelationship(['clear']);
		});

		assert.deepEqual(inner.bulkAdds, []);
		assert.deepEqual(inner.memberRemoves, []);
		assert.deepEqual(inner.relationshipRemoves, []);

		controller.runWithCause(oldPosition, () => {
			adapter.bulkAddToRelationShip({ empty: [], add: ['a'] });
			adapter.bulkAddToRelationShip({ firstEmpty: [], add: ['a'], fresh: ['b'], lastEmpty: [] });
		});

		assert.deepEqual(inner.bulkAdds, [{ empty: [] }, { firstEmpty: [], fresh: ['b'], lastEmpty: [] }]);
		assert.equal(state.pendingWork, 0);
		await Promise.all([state.waitForIdle(), adapter.waitForIdle()]);
	});

	test('never delegates causal writes fenced by a later remove or flush', () => {
		const inner = new MemoryAdapter();
		const { controller, state } = globalController();
		const generation = state.openGeneration({
			expectedGuildIds: [],
			sequence: 1,
			sessionId: 'session',
			shardId: 0,
		});
		state.markGuildsReady(generation);
		const adapter = reconciled(inner, controller);
		adapter.set('item.removed', { value: 'initial' });
		const beforeRemove = state.observePacket(generation, 2);
		const set = vi.spyOn(inner, 'set');
		adapter.remove('item.removed');
		controller.runWithCause(beforeRemove, () => adapter.set('item.removed', { value: 'stale' }));

		const beforeFlush = state.observePacket(generation, 3);
		adapter.flush();
		controller.runWithCause(beforeFlush, () => adapter.set('item.unknown', { value: 'stale' }));

		expect(set).not.toHaveBeenCalled();
		assert.equal(inner.get('item.removed'), null);
		assert.equal(inner.get('item.unknown'), null);
		assert.equal(state.pendingWork, 0);
	});

	test('hides removals before storage and keeps all candidates hidden after partial failure', () => {
		const inner = new MemoryAdapter();
		const { controller } = globalController();
		const adapter = reconciled(inner, controller);
		adapter.bulkSet([
			['item.a', { id: 'a' }],
			['item.b', { id: 'b' }],
		]);
		const original = inner.bulkRemove;
		inner.bulkRemove = keys => {
			original.call(inner, [keys[0]!]);
			assert.equal(adapter.get(keys[1]!), null);
			throw new Error('partial remove');
		};

		expect(() => adapter.bulkRemove(['item.a', 'item.b'])).toThrow(/partial remove/);
		assert.equal(adapter.get('item.a'), null);
		assert.equal(adapter.get('item.b'), null);
		assert.deepEqual(adapter.scan('item.*', true), []);
	});

	test('keeps standalone relationship removal scoped to the relationship while a later value failure stays hidden', () => {
		const inner = new MemoryAdapter();
		const { controller } = globalController();
		const adapter = reconciled(inner, controller);
		adapter.set('item.a', { id: 'a' });
		adapter.addToRelationship('item', 'a');
		adapter.removeToRelationship('item', 'a');
		assert.deepEqual(inner.get('item.a'), { id: 'a' });
		assert.deepEqual(adapter.get('item.a'), { id: 'a' });
		inner.remove = () => {
			throw new Error('value remove failed');
		};
		expect(() => adapter.remove('item.a')).toThrow(/value remove failed/);

		assert.equal(adapter.get('item.a'), null);
		assert.isFalse(adapter.contains('item', 'a'));
		assert.deepEqual(adapter.getToRelationship('item'), []);
	});

	test('covers every relationship mutation and preserves hidden state on failure', () => {
		const inner = new MemoryAdapter();
		const { controller } = globalController();
		const adapter = reconciled(inner, controller);
		for (const id of ['a', 'b', 'c']) adapter.set(`item.${id}`, { id });
		adapter.addToRelationship('item', 'a');
		adapter.bulkAddToRelationShip({ item: ['b', 'c'] });
		assert.deepEqual(adapter.getToRelationship('item'), ['a', 'b', 'c']);

		const originalRemove = inner.removeToRelationship;
		inner.removeToRelationship = () => {
			throw new Error('relationship remove failed');
		};
		expect(() => adapter.removeToRelationship('item', ['a', 'b'])).toThrow(/relationship remove failed/);
		inner.removeToRelationship = originalRemove;
		assert.deepEqual(adapter.getToRelationship('item'), ['c']);
		assert.deepEqual(adapter.get('item.a'), { id: 'a' });
		assert.deepEqual(adapter.get('item.b'), { id: 'b' });
		assert.deepEqual(adapter.get('item.c'), { id: 'c' });

		adapter.removeRelationship('item');
		assert.deepEqual(adapter.getToRelationship('item'), []);
	});

	test('flush hides values and relationships before a failed physical clear', () => {
		const inner = new MemoryAdapter();
		const { controller } = globalController();
		const adapter = reconciled(inner, controller);
		adapter.set('item.a', { id: 'a' });
		adapter.addToRelationship('item', 'a');
		inner.flush = () => {
			assert.equal(adapter.get('item.a'), null);
			assert.deepEqual(adapter.getToRelationship('item'), []);
			throw new Error('flush failed');
		};

		expect(() => adapter.flush()).toThrow(/flush failed/);
		assert.equal(adapter.get('item.a'), null);
		assert.deepEqual(adapter.keys('item'), []);
	});
});
