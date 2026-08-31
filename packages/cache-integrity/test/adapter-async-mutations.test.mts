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

function valueStateKey(key: string): string {
	return JSON.stringify(['value', key]);
}

function relationshipStateKey(to: string, id: string): string {
	return JSON.stringify(['relationship', to, id]);
}

interface AsyncAdapterHarness {
	adapter: Adapter;
	memory: MemoryAdapter<unknown>;
}

function asyncMemoryAdapter(overrides: Partial<Adapter> = {}): AsyncAdapterHarness {
	const memory = new MemoryAdapter<unknown>();
	const adapter = {
		isAsync: true,
		async start() {
			memory.start();
		},
		async scan(query: string, keys?: boolean) {
			return memory.scan(query, keys as true);
		},
		async bulkGet(keys: string[]) {
			return memory.bulkGet(keys);
		},
		async get(key: string) {
			return memory.get(key);
		},
		async bulkSet(entries: [string, any][]) {
			memory.bulkSet(entries);
		},
		async set(key: string, data: any) {
			memory.set(key, data);
		},
		async bulkPatch(entries: [string, any][]) {
			memory.bulkPatch(entries);
		},
		async patch(key: string, data: any) {
			memory.patch(key, data);
		},
		async values(to: string) {
			return memory.values(to);
		},
		async keys(to: string) {
			return memory.keys(to);
		},
		async count(to: string) {
			return memory.count(to);
		},
		async bulkRemove(keys: string[]) {
			memory.bulkRemove(keys);
		},
		async remove(key: string) {
			memory.remove(key);
		},
		async flush() {
			memory.flush();
		},
		async contains(to: string, key: string) {
			return memory.contains(to, key);
		},
		async getToRelationship(to: string) {
			return memory.getToRelationship(to);
		},
		async bulkAddToRelationShip(data: Record<string, string[]>) {
			memory.bulkAddToRelationShip(data);
		},
		async addToRelationship(to: string, keys: string | string[]) {
			memory.addToRelationship(to, keys);
		},
		async removeToRelationship(to: string, keys: string | string[]) {
			memory.removeToRelationship(to, keys);
		},
		async removeRelationship(to: string | string[]) {
			memory.removeRelationship(to);
		},
		...overrides,
	} as Adapter;
	return { adapter, memory };
}

describe('ReconciledAdapter async mutation boundary', () => {
	test('returns promises for async fast misses', async () => {
		const { adapter: inner } = asyncMemoryAdapter();
		const adapter = reconciled(inner, globalController().controller);
		const missing = adapter.get('item.missing');
		const absentRelationship = adapter.contains('item', 'missing');
		expect(missing).toBeInstanceOf(Promise);
		expect(absentRelationship).toBeInstanceOf(Promise);
		await expect(missing).resolves.toBeNull();
		await expect(absentRelationship).resolves.toBe(false);
	});

	test('snapshots caller collections before async operations enter the boundary', async () => {
		const valueGate = deferred();
		const valueStarted = deferred();
		const relationshipGate = deferred();
		const relationshipStarted = deferred();
		let valueBlocked = false;
		let relationshipBlocked = false;
		const { adapter: inner, memory } = asyncMemoryAdapter({
			async set(key, data) {
				if (key === 'item.block' && !valueBlocked) {
					valueBlocked = true;
					valueStarted.resolve();
					await valueGate.promise;
				}
				memory.set(key, data);
			},
			async addToRelationship(to, keys) {
				const ids = Array.isArray(keys) ? keys : [keys];
				if (to === 'item' && ids.includes('seed') && !relationshipBlocked) {
					relationshipBlocked = true;
					relationshipStarted.resolve();
					await relationshipGate.promise;
				}
				memory.addToRelationship(to, keys);
			},
		});
		const { controller, state } = globalController();
		const adapter = reconciled(inner, controller);
		const blockingValue = adapter.set('item.block', { value: 0 });
		await valueStarted.promise;
		const payload = { value: 1 };
		const entries: [string, any][] = [['item.block', payload]];
		const queuedValue = adapter.bulkSet(entries);
		entries[0]![0] = 'item.changed';
		entries.push(['item.extra', { value: 3 }]);
		payload.value = 2;
		valueGate.resolve();
		await Promise.all([blockingValue, queuedValue]);

		assert.deepEqual(memory.get('item.block'), { value: 2 });
		assert.equal(memory.get('item.changed'), null);
		assert.equal(memory.get('item.extra'), null);
		assert.equal(state.ownedVisibilityOf(valueStateKey('item.changed')), undefined);
		assert.equal(state.ownedVisibilityOf(valueStateKey('item.extra')), undefined);

		await adapter.bulkSet([
			['item.seed', { id: 'seed' }],
			['item.a', { id: 'a' }],
			['item.b', { id: 'b' }],
			['item.c', { id: 'c' }],
			['other.x', { id: 'x' }],
		]);
		const blockingRelationship = adapter.addToRelationship('item', 'seed');
		await relationshipStarted.promise;
		const data: Record<string, string[]> = { item: ['a'] };
		const queuedRelationship = adapter.bulkAddToRelationShip(data);
		data.item![0] = 'b';
		data.item!.push('c');
		data.other = ['x'];
		relationshipGate.resolve();
		await Promise.all([blockingRelationship, queuedRelationship]);

		assert.deepEqual(memory.getToRelationship('item'), ['seed', 'a']);
		assert.deepEqual(memory.getToRelationship('other'), []);
		assert.equal(state.ownedVisibilityOf(relationshipStateKey('item', 'a'))?.state, 'visible');
		assert.equal(state.ownedVisibilityOf(relationshipStateKey('item', 'b')), undefined);
		assert.equal(state.ownedVisibilityOf(relationshipStateKey('item', 'c')), undefined);
		assert.equal(state.ownedVisibilityOf(relationshipStateKey('other', 'x')), undefined);
		assert.equal(state.pendingWork, 0);
		await Promise.all([state.waitForIdle(), adapter.waitForIdle()]);
	});

	test('serializes the same key while allowing different keys to run concurrently', async () => {
		const first = deferred();
		const firstStarted = deferred();
		const started: string[] = [];
		const { adapter: inner, memory } = asyncMemoryAdapter({
			async set(key, data) {
				started.push(key);
				if (key === 'item.a' && started.filter(value => value === key).length === 1) {
					firstStarted.resolve();
					await first.promise;
				}
				memory.set(key, data);
			},
		});
		const { controller } = globalController();
		const adapter = reconciled(inner, controller);

		const one = adapter.set('item.a', { value: 1 });
		await firstStarted.promise;
		const two = adapter.set('item.a', { value: 2 });
		const other = adapter.set('item.b', { value: 3 });
		await Promise.resolve();
		await Promise.resolve();
		assert.deepEqual(started, ['item.a', 'item.b']);
		first.resolve();
		await Promise.all([one, two, other]);
		assert.deepEqual(started, ['item.a', 'item.b', 'item.a']);
		assert.deepEqual(await adapter.get('item.a'), { value: 2 });
	});

	test('atomically reserves overlapping multi-key batches independent of lock order', async () => {
		const first = deferred();
		const firstStarted = deferred();
		const started: string[][] = [];
		const { adapter: inner, memory } = asyncMemoryAdapter({
			async bulkSet(entries) {
				started.push(entries.map(([key]) => key));
				if (started.length === 1) {
					firstStarted.resolve();
					await first.promise;
				}
				memory.bulkSet(entries);
			},
		});
		const adapter = reconciled(inner, globalController().controller);
		const one = adapter.bulkSet([
			['item.a', 1],
			['item.b', 1],
		]);
		await firstStarted.promise;
		const two = adapter.bulkSet([
			['item.b', 2],
			['item.a', 2],
		]);
		await Promise.resolve();
		await Promise.resolve();
		assert.deepEqual(started, [['item.a', 'item.b']]);
		first.resolve();
		await Promise.all([one, two]);
		assert.deepEqual(started, [
			['item.a', 'item.b'],
			['item.b', 'item.a'],
		]);
	});

	test('stages visibility before queueing and skips a superseded queued delete', async () => {
		let removes = 0;
		const { adapter: inner } = asyncMemoryAdapter({
			async remove() {
				removes++;
			},
		});
		const adapter = reconciled(inner, globalController().controller);
		await adapter.set('item.a', { value: 1 });

		const removing = adapter.remove('item.a');
		assert.equal(await adapter.get('item.a'), null);
		const writing = adapter.set('item.a', { value: 2 });
		await Promise.all([removing, writing]);
		assert.equal(removes, 0);
		assert.deepEqual(await adapter.get('item.a'), { value: 2 });
	});

	test('begins a snapshot physical delete inside the key lock immediately before storage', async () => {
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
			resolveScope: () => generation,
		});
		let claim: ReturnType<AdapterReconciliationController['claimValueDelete']>;
		let physicalCalls = 0;
		const { adapter: inner, memory } = asyncMemoryAdapter({
			async remove(key) {
				physicalCalls++;
				assert.isFalse(state.beginPhysicalDelete(claim!));
				memory.remove(key);
			},
		});
		const adapter = reconciled(inner, controller);
		controller.runWithCause(state.observePacket(generation, 2), () => adapter.set('item.a', { value: 1 }));
		await adapter.waitForIdle();
		claim = controller.claimValueDelete(
			'item.a',
			state.beginSnapshot(generation, 3, {
				completeness: 'authoritative',
				guildId: 'guild',
				resource: 'item',
			}),
		);
		assert.isDefined(claim);
		await adapter.reconcileDelete('item.a', claim!);
		assert.equal(physicalCalls, 1);
		assert.equal(await adapter.get('item.a'), null);
	});

	test('revalidates a stale-guild cascade claim after waiting for a child key lock', async () => {
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
			resolveScope: () => generation,
		});
		const writeGate = deferred();
		const writeStarted = deferred();
		let physicalRemoves = 0;
		const { adapter: inner, memory } = asyncMemoryAdapter({
			async remove(key) {
				physicalRemoves++;
				memory.remove(key);
			},
			async set(key, data) {
				if (key === 'role.child') {
					writeStarted.resolve();
					await writeGate.promise;
				}
				memory.set(key, data);
			},
		});
		const adapter = reconciled(inner, controller);
		const initialPosition = state.observePacket(generation, 2);
		const writing = controller.runWithCause(initialPosition, () => adapter.set('role.child', { id: 'child' }));
		await writeStarted.promise;
		const snapshotPosition = state.observePacket(generation, 3);
		const rootClaim = controller.claimValueDelete(
			'guild.stale',
			state.recordSnapshot(snapshotPosition, {
				completeness: 'authoritative',
				guildId: 'stale',
				resource: 'guild',
			}),
		);
		assert.isDefined(rootClaim);
		const removing = controller.runWithContext(
			{
				deleteClaim: rootClaim,
				event: 'GUILDS_READY',
				guildId: 'stale',
				mode: 'stale-guild-cascade',
				position: snapshotPosition,
				shardId: 0,
			},
			() => adapter.remove('role.child'),
		);
		assert.isTrue(controller.supersedeValueDelete('guild.stale', state.observePacket(generation, 4)));

		writeGate.resolve();
		await Promise.all([writing, removing]);
		assert.equal(physicalRemoves, 0);
		expect(memory.get('role.child')).toMatchObject({ id: 'child' });
		await Promise.all([adapter.waitForIdle(), state.waitForIdle()]);
		assert.equal(state.pendingWork, 0);
	});

	test('lets an already executing delete finish before a later write wins', async () => {
		const removeGate = deferred();
		const removeStarted = deferred();
		const { adapter: inner, memory } = asyncMemoryAdapter({
			async remove(key) {
				removeStarted.resolve();
				await removeGate.promise;
				memory.remove(key);
			},
		});
		const adapter = reconciled(inner, globalController().controller);
		await adapter.set('item.a', { value: 1 });
		const removing = adapter.remove('item.a');
		await removeStarted.promise;
		const writing = adapter.set('item.a', { value: 2 });
		removeGate.resolve();
		await Promise.all([removing, writing]);
		assert.deepEqual(await adapter.get('item.a'), { value: 2 });
	});

	test('serializes relationship buckets and releases failed tails', async () => {
		const gate = deferred();
		const relationshipStarted = deferred();
		const calls: string[] = [];
		let failFirstSet = true;
		const { adapter: inner, memory } = asyncMemoryAdapter({
			async addToRelationship(to, keys) {
				calls.push(`add:${to}`);
				if (calls.filter(call => call.startsWith('add:')).length === 1) {
					relationshipStarted.resolve();
					await gate.promise;
				}
				memory.addToRelationship(to, keys);
			},
			async set(key, data) {
				calls.push(`set:${key}`);
				if (key === 'item.failure' && failFirstSet) {
					failFirstSet = false;
					throw new Error('first failed');
				}
				memory.set(key, data);
			},
		});
		const adapter = reconciled(inner, globalController().controller);
		await Promise.all([adapter.set('item.a', {}), adapter.set('item.b', {})]);
		const one = adapter.addToRelationship('item', 'a');
		await relationshipStarted.promise;
		const two = adapter.removeToRelationship('item', 'a');
		await Promise.resolve();
		await Promise.resolve();
		assert.deepEqual(
			calls.filter(call => call.startsWith('add:')),
			['add:item'],
		);
		gate.resolve();
		await Promise.all([one, two]);

		await expect(adapter.set('item.failure', {})).rejects.toThrow(/first failed/);
		await expect(adapter.set('item.failure', { ok: true })).resolves.toBeUndefined();
	});

	test('flush is an exclusive FIFO barrier for mutations before and after it', async () => {
		const setGate = deferred();
		const setStarted = deferred();
		const flushGate = deferred();
		const flushStarted = deferred();
		const order: string[] = [];
		let setCount = 0;
		const { adapter: inner, memory } = asyncMemoryAdapter({
			async set(key, data) {
				setCount++;
				order.push(`set:${key}:start`);
				if (setCount === 1) {
					setStarted.resolve();
					await setGate.promise;
				}
				memory.set(key, data);
				order.push(`set:${key}:end`);
			},
			async flush() {
				order.push('flush:start');
				flushStarted.resolve();
				await flushGate.promise;
				memory.flush();
				order.push('flush:end');
			},
		});
		const adapter = reconciled(inner, globalController().controller);
		const before = adapter.set('item.before', {});
		await setStarted.promise;
		const flushing = adapter.flush();
		const after = adapter.set('item.after', {});
		await Promise.resolve();
		await Promise.resolve();
		assert.deepEqual(order, ['set:item.before:start']);
		setGate.resolve();
		await before;
		await flushStarted.promise;
		assert.include(order, 'flush:start');
		assert.notInclude(order, 'set:item.after:start');
		flushGate.resolve();
		await Promise.all([before, flushing, after]);
		assert.deepEqual(order, [
			'set:item.before:start',
			'set:item.before:end',
			'flush:start',
			'flush:end',
			'set:item.after:start',
			'set:item.after:end',
		]);
	});

	test('waitForIdle observes physical work and async reentrancy fails fast without poisoning tails', async () => {
		const gate = deferred();
		let adapter!: ReconciledAdapter;
		let recurse = true;
		const { adapter: inner, memory } = asyncMemoryAdapter({
			async set(key, data) {
				if (key === 'item.wait') await gate.promise;
				if (recurse && key === 'item.reentrant') {
					recurse = false;
					adapter.set(key, data);
				}
				memory.set(key, data);
			},
		});
		const { controller, state } = globalController();
		adapter = reconciled(inner, controller);
		const pending = adapter.set('item.wait', {});
		let idle = false;
		const waiting = adapter.waitForIdle().then(() => {
			idle = true;
		});
		await Promise.resolve();
		assert.isFalse(idle);
		gate.resolve();
		await Promise.all([pending, waiting]);
		assert.isTrue(idle);

		await expect(adapter.set('item.reentrant', {})).rejects.toThrow(/Reentrant/);
		await adapter.waitForIdle();
		assert.equal(state.pendingWork, 0);
		await expect(adapter.set('item.reentrant', { recovered: true })).resolves.toBeUndefined();
	});

	test('waitForIdle follows work admitted by a completion callback while it is draining', async () => {
		const firstGate = deferred();
		const followGate = deferred();
		const { adapter: inner, memory } = asyncMemoryAdapter({
			async set(key, data) {
				if (key === 'item.first') await firstGate.promise;
				if (key === 'item.follow') await followGate.promise;
				memory.set(key, data);
			},
		});
		const adapter = reconciled(inner, globalController().controller);
		const first = adapter.set('item.first', {});
		let follow!: ReturnType<Adapter['set']>;
		void Promise.resolve(first).then(() => {
			follow = adapter.set('item.follow', {});
		});
		let idle = false;
		const waiting = adapter.waitForIdle().then(() => {
			idle = true;
		});
		firstGate.resolve();
		await Promise.resolve(first);
		await Promise.resolve();
		assert.isFalse(idle);
		followGate.resolve();
		await Promise.all([Promise.resolve(follow), waiting]);
		assert.isTrue(idle);
	});

	test('close drains admitted physical mutations before closing the coordinator', async () => {
		const gate = deferred();
		const mutationStarted = deferred();
		const events: string[] = [];
		const { adapter: inner, memory } = asyncMemoryAdapter({
			async set(key, data) {
				events.push('mutation:start');
				mutationStarted.resolve();
				await gate.promise;
				memory.set(key, data);
				events.push('mutation:end');
			},
		});
		const coordinator = {
			kind: 'test',
			start() {},
			close() {
				events.push('coordinator:close');
			},
		};
		const adapter = new ReconciledAdapter(inner, coordinator, hooks(), globalController().controller);
		const pending = adapter.set('item.a', {});
		await mutationStarted.promise;
		const closing = adapter.close();
		await Promise.resolve();
		assert.deepEqual(events, ['mutation:start']);

		gate.resolve();
		await Promise.all([pending, closing]);
		assert.deepEqual(events, ['mutation:start', 'mutation:end', 'coordinator:close']);
	});

	test('close seals reconciliation admission while leaving later adapter mutations transparent', async () => {
		const coordinatorCloseStarted = deferred();
		const coordinatorCloseGate = deferred();
		const { adapter: inner, memory } = asyncMemoryAdapter();
		const { controller, state } = globalController();
		const adapter = new ReconciledAdapter(
			inner,
			{
				kind: 'test',
				start() {},
				async close() {
					coordinatorCloseStarted.resolve();
					await coordinatorCloseGate.promise;
				},
			},
			hooks(),
			controller,
		);
		const closing = adapter.close();
		await coordinatorCloseStarted.promise;

		await adapter.set('item.after-close', { id: 'after-close' });
		assert.deepEqual(memory.get('item.after-close'), { id: 'after-close' });
		assert.equal(state.pendingWork, 0);

		memory.set('item.ghost', { id: 'ghost' });
		const generation = state.openGeneration({
			expectedGuildIds: [],
			sequence: 1,
			sessionId: 'session',
			shardId: 0,
		});
		state.markGuildsReady(generation);
		const claim = controller.claimValueDelete(
			'item.ghost',
			state.beginSnapshot(generation, 2, {
				completeness: 'authoritative',
				guildId: 'guild',
				resource: 'item',
			}),
		);
		assert.isDefined(claim);
		const remove = vi.spyOn(inner, 'remove');
		await adapter.reconcileDelete('item.ghost', claim!);
		expect(remove).not.toHaveBeenCalled();
		assert.deepEqual(memory.get('item.ghost'), { id: 'ghost' });
		state.fail();
		assert.equal(state.pendingWork, 0);

		coordinatorCloseGate.resolve();
		await closing;
	});
});
