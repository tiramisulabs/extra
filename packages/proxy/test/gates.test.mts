import { assert, describe, test, vi } from 'vitest';
import { ProxyError } from '../src';
import { InvalidRequestBudget, isInteractionCallback, SlidingWindow } from '../src/gates';
import { RequestScheduler } from '../src/scheduler';

describe('proactive gates', () => {
	test('uses a deterministic sliding window without boundary bursts', () => {
		const gate = new SlidingWindow(2, 1_000);
		gate.record(0);
		gate.record(1);

		assert.equal(gate.occupancy(999), 2);
		assert.equal(gate.delay(999), 1);
		assert.equal(gate.delay(1_000), 0);
		assert.equal(gate.occupancy(1_000), 1);
	});

	test('releases invalid request capacity as entries expire', () => {
		const budget = new InvalidRequestBudget(2, 10_000);
		budget.record(100);
		budget.record(200);
		budget.record(300);

		assert.equal(budget.remaining(200), 0);
		assert.equal(budget.blockedFor(300), 9_900);
		assert.equal(budget.remaining(10_100), 0);
		assert.equal(budget.blockedFor(10_100), 100);
		assert.equal(budget.remaining(10_200), 1);
		assert.equal(budget.blockedFor(10_200), 0);
	});

	test('exempts only the identifiable interaction callback route', () => {
		assert.equal(isInteractionCallback('/interactions/1/token/callback'), true);
		assert.equal(isInteractionCallback('/webhooks/1/token'), false);
		assert.equal(isInteractionCallback('/channels/1/messages'), false);
	});

	test('times out the admission queue and rejects excess pending work', async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(1_000);
			const gate = new SlidingWindow(1, 1_000);
			gate.record(Date.now());
			const scheduler = new RequestScheduler(1, 10, gate, new InvalidRequestBudget(10, 1_000), () => {});
			let dispatched = false;
			const queued = scheduler
				.submit({
					requestId: 'queued',
					exempt: false,
					run: async () => {
						dispatched = true;
					},
				})
				.catch(error => error);
			const overloaded = scheduler
				.submit({
					requestId: 'overloaded',
					exempt: false,
					run: async () => {},
				})
				.catch(error => error);

			const overloadError = await overloaded;
			assert.instanceOf(overloadError, ProxyError);
			assert.equal(overloadError.code, 'PROXY_OVERLOADED');
			await vi.advanceTimersByTimeAsync(10);
			const timeoutError = await queued;
			assert.instanceOf(timeoutError, ProxyError);
			assert.equal(timeoutError.code, 'PROXY_QUEUE_TIMEOUT');
			assert.equal(dispatched, false);
		} finally {
			vi.useRealTimers();
		}
	});
});
