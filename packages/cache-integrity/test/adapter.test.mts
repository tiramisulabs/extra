import { MemoryAdapter } from 'seyfert';
import { assert, describe, expect, test } from 'vitest';
import type { ReconciliationCoordinator } from '../src';
import { localCoordinator } from '../src';
import { ReconciledAdapter } from '../src/adapter';
import { deferred } from './deferred';

describe('ReconciledAdapter lifecycle', () => {
	test('starts the inner adapter exactly once and retains synchronous behavior', () => {
		const order: string[] = [];
		let starts = 0;
		let started = 0;
		const inner = new MemoryAdapter();
		inner.start = () => {
			order.push('inner');
			starts++;
		};
		const adapter = new ReconciledAdapter(inner, localCoordinator(), {
			beforeStart: () => order.push('before'),
			onFailed: () => assert.fail('start should not fail'),
			onStarted: () => started++,
		});

		assert.equal(adapter.start(), undefined);
		assert.equal(adapter.start(), undefined);
		assert.equal(starts, 1);
		assert.equal(started, 1);
		assert.deepEqual(order, ['before', 'inner']);
	});

	test('preserves synchronous start failures and never retries the inner adapter', () => {
		const failure = new Error('boom');
		let starts = 0;
		const inner = new MemoryAdapter();
		inner.start = () => {
			starts++;
			throw failure;
		};
		const adapter = new ReconciledAdapter(inner, localCoordinator(), {
			beforeStart() {},
			onFailed() {},
			onStarted: () => assert.fail('start should not succeed'),
		});

		expect(() => adapter.start()).toThrow(failure);
		expect(() => adapter.start()).toThrow(failure);
		assert.equal(starts, 1);
	});

	test('preserves asynchronous start failures and never retries the inner adapter', async () => {
		const failure = new Error('async boom');
		let starts = 0;
		const inner = new MemoryAdapter();
		inner.start = () => {
			starts++;
			return Promise.reject(failure);
		};
		const adapter = new ReconciledAdapter(inner, localCoordinator(), {
			beforeStart() {},
			onFailed() {},
			onStarted: () => assert.fail('start should not succeed'),
		});

		await expect(Promise.resolve(adapter.start())).rejects.toBe(failure);
		let second: void | Promise<void>;
		assert.doesNotThrow(() => {
			second = adapter.start();
		});
		await expect(Promise.resolve(second!)).rejects.toBe(failure);
		assert.equal(starts, 1);
	});

	test('close during inner start prevents a later coordinator start', async () => {
		const gate = deferred();
		let coordinatorCloses = 0;
		let coordinatorStarts = 0;
		let started = 0;
		const inner = new MemoryAdapter();
		inner.start = () => gate.promise;
		const coordinator: ReconciliationCoordinator = {
			kind: 'test',
			start() {
				coordinatorStarts++;
			},
			close() {
				coordinatorCloses++;
			},
		};
		const adapter = new ReconciledAdapter(inner, coordinator, {
			beforeStart() {},
			onFailed: () => assert.fail('start should not fail'),
			onStarted: () => started++,
		});

		const start = Promise.resolve(adapter.start());
		const firstClose = adapter.close();
		const secondClose = adapter.close();
		assert.equal(firstClose, secondClose);
		gate.resolve();
		await Promise.all([start, firstClose]);

		assert.equal(coordinatorStarts, 0);
		assert.equal(coordinatorCloses, 1);
		assert.equal(started, 0);
	});

	test('concurrent close calls close the coordinator once', async () => {
		let closes = 0;
		const coordinator: ReconciliationCoordinator = {
			kind: 'test',
			start() {},
			close() {
				closes++;
			},
		};
		const adapter = new ReconciledAdapter(new MemoryAdapter(), coordinator, {
			beforeStart() {},
			onFailed: () => assert.fail('start should not fail'),
			onStarted() {},
		});
		adapter.start();

		await Promise.all([adapter.close(), adapter.close(), adapter.close()]);
		assert.equal(closes, 1);
		assert.throws(() => adapter.start(), /closed/);
	});
});
