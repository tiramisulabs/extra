import type { Adapter } from 'seyfert';
import { MemoryAdapter } from 'seyfert';
import { assert, describe, expect, test, vi } from 'vitest';
import { localCoordinator } from '../src';
import { ReconciledAdapter } from '../src/adapter';
import { AdapterReconciliationController } from '../src/adapter-controller';
import { GLOBAL_VISIBILITY_SCOPE, ReconciliationState } from '../src/reconciliation-state';
import { adapterDataCalls } from './adapter-data-methods';

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

describe('ReconciledAdapter complete contract and sync preservation', () => {
	test.each(Object.entries(adapterDataCalls))('%s delegates exactly once and stays synchronous', (method, invoke) => {
		const inner = new MemoryAdapter();
		inner.set('item.one', { id: 'one' });
		inner.addToRelationship('item', 'one');
		const spy = vi.spyOn(inner, method as never);
		const adapter = reconciled(inner);

		const result = invoke(adapter);

		expect(result).not.toBeInstanceOf(Promise);
		expect(spy).toHaveBeenCalledTimes(1);
	});

	test('captures isAsync, preserves this binding, synchronous throws, and rejects illegal thenables synchronously', () => {
		const inner = new MemoryAdapter();
		const originalGet = inner.get;
		inner.get = function (key) {
			expect(this).toBe(inner);
			return originalGet.call(this, key);
		};
		const adapter = reconciled(inner);
		inner.isAsync = true;
		assert.isFalse(adapter.isAsync);
		assert.equal(adapter.get('missing'), null);

		const failure = new Error('sync failure');
		inner.set = () => {
			throw failure;
		};
		expect(() => adapter.set('item.one', {})).toThrow(failure);

		inner.get = (() => Promise.resolve(null)) as unknown as typeof inner.get;
		expect(() => adapter.get('item.one')).toThrow(/returned a thenable/);
		inner.set = (() => Promise.resolve()) as unknown as typeof inner.set;
		expect(() => adapter.set('item.one', {})).toThrow(/returned a thenable/);
	});

	test('keeps the installed plugin pass-through until a reconciliation controller is provided', () => {
		const inner = new MemoryAdapter();
		const transparent = reconciled(inner);
		transparent.set('role.guild.role', { id: 'role' });
		assert.deepEqual(transparent.get('role.guild.role'), { id: 'role' });

		const unresolved = globalController(false).controller;
		const failClosed = reconciled(new MemoryAdapter(), unresolved);
		failClosed.set('role.guild.role', { id: 'role' });
		assert.equal(failClosed.get('role.guild.role'), null);
	});
});
