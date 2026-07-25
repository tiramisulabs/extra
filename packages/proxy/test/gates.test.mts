import { ApiHandler } from 'seyfert';
import { assert, describe, test, vi } from 'vitest';
import type { RestContext } from '../src/contexts';
import { SlidingWindow } from '../src/gates';
import { ProxyError } from '../src/protocol';
import { RequestScheduler } from '../src/scheduler';
import { deferred } from './helpers.mts';

function context(key: string, gate = new SlidingWindow(50, 1_000)): RestContext {
	return {
		key,
		gate,
		rest: new ApiHandler({ token: key, workerProxy: false }),
		override: false,
		token: key,
		activeRequests: 0,
		lastUsedAt: Date.now(),
	};
}

function thrown(callback: () => unknown): unknown {
	try {
		callback();
	} catch (error) {
		return error;
	}
	throw new Error('Expected callback to throw.');
}

describe('proactive gates', () => {
	test('uses a deterministic sliding window without boundary bursts', () => {
		const gate = new SlidingWindow(2, 1_000);
		gate.record(0);
		gate.record(1);

		assert.equal(gate.occupancy(999), 2);
		assert.equal(gate.blockedFor(999), 1);
		assert.equal(gate.blockedFor(1_000), 0);
		assert.equal(gate.occupancy(1_000), 1);
	});

	test('honors an explicit Discord global retry delay', () => {
		const gate = new SlidingWindow(50, 1_000);
		gate.blockFor(250, 1_000);
		assert.equal(gate.blockedFor(1_100), 150);
		assert.equal(gate.blockedFor(1_250), 0);
	});

	test('releases invalid request capacity as entries expire', () => {
		const budget = new SlidingWindow(2, 10_000);
		budget.record(100);
		budget.record(200);
		budget.record(300);

		assert.equal(budget.remaining(200), 0);
		assert.equal(budget.blockedFor(300), 9_900);
		assert.equal(budget.remaining(10_100), 0);
		assert.equal(budget.blockedFor(10_100), 100);
		assert.equal(budget.remaining(10_200), 1);
	});

	test('times out admission and rejects work beyond total admitted capacity', async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(1_000);
			const blocked = new SlidingWindow(1, 1_000);
			blocked.record(Date.now());
			const scheduler = new RequestScheduler(1, 10, new SlidingWindow(10, 1_000), () => {});
			const queued = scheduler
				.submitReserved(scheduler.reserve('queued'), {
					requestId: 'queued',
					context: context('blocked', blocked),
					run: async () => undefined,
				})
				.catch(error => error);

			const overload = thrown(() => scheduler.reserve('overloaded'));
			assert.instanceOf(overload, ProxyError);
			assert.equal(overload.code, 'PROXY_OVERLOADED');
			await vi.advanceTimersByTimeAsync(10);
			const timeout = await queued;
			assert.instanceOf(timeout, ProxyError);
			assert.equal(timeout.code, 'PROXY_QUEUE_TIMEOUT');
		} finally {
			vi.useRealTimers();
		}
	});

	test('allows another token context to pass a gate-blocked FIFO head', async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(1_000);
			const blockedGate = new SlidingWindow(1, 1_000);
			blockedGate.record(Date.now());
			const scheduler = new RequestScheduler(2, 2_000, new SlidingWindow(10, 1_000), () => {});
			const dispatched: string[] = [];
			const blocked = scheduler.submitReserved(scheduler.reserve('blocked'), {
				requestId: 'blocked',
				context: context('first', blockedGate),
				run: async () => dispatched.push('blocked'),
			});
			const independent = scheduler.submitReserved(scheduler.reserve('independent'), {
				requestId: 'independent',
				context: context('second'),
				run: async () => dispatched.push('independent'),
			});

			await independent;
			assert.deepEqual(dispatched, ['independent']);
			await vi.advanceTimersByTimeAsync(1_000);
			await blocked;
			assert.deepEqual(dispatched, ['independent', 'blocked']);
		} finally {
			vi.useRealTimers();
		}
	});

	test('counts requests already handed to ApiHandler against admission capacity', async () => {
		const held = deferred<void>();
		const scheduler = new RequestScheduler(1, 1_000, new SlidingWindow(10, 1_000), () => {});
		const first = scheduler.submitReserved(scheduler.reserve('first'), {
			requestId: 'first',
			context: context('token'),
			run: () => held.promise,
		});
		assert.equal(scheduler.inFlightCount, 1);
		assert.equal(scheduler.admittedCount, 1);
		const overload = thrown(() => scheduler.reserve('second'));
		assert.instanceOf(overload, ProxyError);
		assert.equal(overload.code, 'PROXY_OVERLOADED');
		held.resolve();
		await first;
	});

	test('drains admitted queue entries instead of rejecting them immediately', async () => {
		const scheduler = new RequestScheduler(1, 1_000, new SlidingWindow(10, 1_000), () => {});
		const result = scheduler.submitReserved(scheduler.reserve('queued'), {
			requestId: 'queued',
			context: context('token'),
			run: async () => 'done',
		});
		scheduler.startDraining();
		assert.equal(await result, 'done');
		const draining = thrown(() => scheduler.reserve('new'));
		assert.instanceOf(draining, ProxyError);
		assert.equal(draining.code, 'PROXY_DRAINING');
	});
});
