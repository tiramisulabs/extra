import { assert, describe, test, vi } from 'vitest';
import { ProxyError } from '../src';
import { isInteractionCallback, SlidingWindow } from '../src/gates';
import { RequestScheduler } from '../src/scheduler';

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
			const scheduler = new RequestScheduler(1, 10, gate, new SlidingWindow(10, 1_000), () => {});
			let dispatched = false;
			const queued = scheduler
				.submitReserved(scheduler.reserve('queued'), {
					requestId: 'queued',
					exempt: false,
					run: async () => {
						dispatched = true;
					},
				})
				.catch(error => error);
			let overloadError: unknown;
			try {
				scheduler.reserve('overloaded');
			} catch (error) {
				overloadError = error;
			}
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

	test('dispatches exempt interaction callbacks past a gate-limited queue head', async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(1_000);
			const gate = new SlidingWindow(1, 1_000);
			gate.record(Date.now());
			const scheduler = new RequestScheduler(2, 2_000, gate, new SlidingWindow(10, 1_000), () => {});
			const dispatched: string[] = [];
			const limited = scheduler.submitReserved(scheduler.reserve('limited'), {
				requestId: 'limited',
				exempt: false,
				run: async () => dispatched.push('limited'),
			});
			const exempt = scheduler.submitReserved(scheduler.reserve('exempt'), {
				requestId: 'exempt',
				exempt: true,
				run: async () => dispatched.push('exempt'),
			});

			await exempt;
			assert.deepEqual(dispatched, ['exempt']);
			await vi.advanceTimersByTimeAsync(1_000);
			await limited;
			assert.deepEqual(dispatched, ['exempt', 'limited']);
		} finally {
			vi.useRealTimers();
		}
	});

	test('tracks concurrent operations independently when request IDs repeat', async () => {
		let releaseFirst!: () => void;
		let releaseSecond!: () => void;
		const firstGate = new Promise<void>(resolve => {
			releaseFirst = resolve;
		});
		const secondGate = new Promise<void>(resolve => {
			releaseSecond = resolve;
		});
		const scheduler = new RequestScheduler(
			2,
			1_000,
			new SlidingWindow(1, 1_000),
			new SlidingWindow(10, 1_000),
			() => {},
		);
		const first = scheduler.submitReserved(scheduler.reserve('duplicate'), {
			requestId: 'duplicate',
			exempt: true,
			run: () => firstGate,
		});
		const second = scheduler.submitReserved(scheduler.reserve('duplicate'), {
			requestId: 'duplicate',
			exempt: true,
			run: () => secondGate,
		});

		assert.equal(scheduler.inFlightCount, 2);
		assert.deepEqual(
			scheduler.inFlight.map(request => request.requestId),
			['duplicate', 'duplicate'],
		);
		releaseFirst();
		await first;
		await Promise.resolve();
		assert.equal(scheduler.inFlightCount, 1);
		releaseSecond();
		await second;
	});
});
