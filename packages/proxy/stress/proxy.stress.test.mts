import { performance } from 'node:perf_hooks';
import { ApiHandler } from 'seyfert';
import { afterEach, assert, describe, test, vi } from 'vitest';
import { createProxy, createServiceCredential, type GateOptions, ProxyApiHandler } from '../src';
import { deferred, request, response } from '../test/helpers.mts';

interface StressProxyOptions {
	maxAdmittedRequests?: number;
	queueTimeout?: number;
	maxBufferedBytes?: number;
	globalLimit?: Partial<GateOptions>;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.restoreAllMocks();
});

async function startWorkerPool(token: string, serviceCount: number, options: StressProxyOptions = {}) {
	const services = Array.from({ length: serviceCount }, (_, index) =>
		createServiceCredential(`stress-service-${index}`),
	);
	const rest = new ApiHandler({ token, workerProxy: false });
	const proxy = await createProxy({
		rest,
		credentials: services.map(service => service.hash),
		port: 0,
		...options,
	});
	const workers = services.map(
		service =>
			new ProxyApiHandler({
				url: proxy.url,
				credential: service.credential,
				requestTimeout: 60_000,
			}),
	);
	return {
		proxy,
		rest,
		services,
		workers,
		async close() {
			await proxy.close({ drainTimeout: 30_000 });
		},
	};
}

async function runConcurrently<T>(
	count: number,
	concurrency: number,
	task: (index: number) => Promise<T>,
): Promise<T[]> {
	const results = new Array<T>(count);
	let nextIndex = 0;
	await Promise.all(
		Array.from({ length: Math.min(count, concurrency) }, async () => {
			while (nextIndex < count) {
				const index = nextIndex++;
				results[index] = await task(index);
			}
		}),
	);
	return results;
}

function requestBody(requestId: string, url: `/${string}`): string {
	return JSON.stringify({
		method: 'GET',
		url,
		requestId,
	});
}

describe('proxy stress', () => {
	test('coordinates sustained concurrent load from many worker copies', async () => {
		const requestCount = 4_000;
		const workerCount = 16;
		let upstreamInFlight = 0;
		let maxUpstreamInFlight = 0;
		globalThis.fetch = vi.fn<typeof fetch>(async () => {
			upstreamInFlight++;
			maxUpstreamInFlight = Math.max(maxUpstreamInFlight, upstreamInFlight);
			try {
				await new Promise(resolve => setTimeout(resolve, 1));
				return response(
					200,
					{ ok: true },
					{
						'x-ratelimit-limit': '10000',
						'x-ratelimit-remaining': '9999',
						'x-ratelimit-reset-after': '0.001',
					},
				);
			} finally {
				upstreamInFlight--;
			}
		});
		const fixture = await startWorkerPool('local-stress-token', workerCount, {
			maxAdmittedRequests: 512,
			queueTimeout: 30_000,
			maxBufferedBytes: 4 * 1024 * 1024,
			globalLimit: { max: 256, perMs: 10 },
		});
		const completedByService = new Map<string, number>();
		const dispose = fixture.proxy.observe(observation => {
			if (observation.type !== 'request' || observation.outcome !== 'completed' || !observation.serviceId) return;
			completedByService.set(observation.serviceId, (completedByService.get(observation.serviceId) ?? 0) + 1);
		});

		try {
			const startedAt = performance.now();
			const results = await runConcurrently(requestCount, 256, index => {
				const channelId = String(100_000_000_000_000_000n + BigInt(index % 64));
				return fixture.workers[index % workerCount].request<{ ok: boolean }>('GET', `/channels/${channelId}`);
			});
			const elapsedMs = performance.now() - startedAt;
			const stats = fixture.proxy.getStats();

			assert.equal(
				results.every(result => result.ok),
				true,
			);
			assert.equal(vi.mocked(globalThis.fetch).mock.calls.length, requestCount);
			assert.isAbove(maxUpstreamInFlight, 1);
			assert.isAtMost(maxUpstreamInFlight, 256);
			for (let index = 0; index < workerCount; index++) {
				assert.equal(completedByService.get(`stress-service-${index}`), requestCount / workerCount);
			}
			assert.deepInclude(stats, {
				state: 'ready',
				pendingRequests: 0,
				inFlightRequests: 0,
				admittedRequests: 0,
				bufferedBytes: 0,
				tokenContexts: 1,
				deduplicationEntries: requestCount,
				outcomes: { not_dispatched: 0, completed: requestCount, unknown: 0 },
			});
			console.info(
				`[proxy stress/local] requests=${requestCount} workers=${workerCount} elapsedMs=${elapsedMs.toFixed(0)} maxUpstreamInFlight=${maxUpstreamInFlight}`,
			);
		} finally {
			dispose();
			await fixture.close();
		}
	}, 30_000);

	test('coalesces a large in-flight duplicate burst into one upstream request', async () => {
		const duplicateCount = 300;
		globalThis.fetch = vi.fn<typeof fetch>(async () => {
			await new Promise(resolve => setTimeout(resolve, 10));
			return response(200, { ok: true });
		});
		const fixture = await startWorkerPool('local-deduplication-token', 1, {
			maxAdmittedRequests: 512,
			queueTimeout: 10_000,
		});
		const requestId = 'stress-duplicate';
		const body = requestBody(requestId, '/gateway/bot');

		try {
			const results = await Promise.all(
				Array.from({ length: duplicateCount }, () =>
					request(fixture.proxy.url, {
						path: '/v1/requests',
						method: 'POST',
						credential: fixture.services[0].credential,
						contentType: 'application/json',
						requestId,
						body,
					}),
				),
			);
			const stats = fixture.proxy.getStats();

			assert.equal(
				results.every(result => result.status === 200),
				true,
			);
			assert.equal(
				results.every(result => (JSON.parse(result.body) as { kind?: unknown }).kind === 'success'),
				true,
			);
			assert.equal(vi.mocked(globalThis.fetch).mock.calls.length, 1);
			assert.deepInclude(stats, {
				admittedRequests: 0,
				bufferedBytes: 0,
				deduplicationEntries: 1,
				outcomes: { not_dispatched: 0, completed: duplicateCount, unknown: 0 },
			});
		} finally {
			await fixture.close();
		}
	}, 20_000);

	test('enforces the hard admission bound while upstream work is stalled', async () => {
		const admittedLimit = 32;
		const requestCount = 96;
		const releaseUpstream = deferred<void>();
		globalThis.fetch = vi.fn<typeof fetch>(async () => {
			await releaseUpstream.promise;
			return response(200, { ok: true });
		});
		const fixture = await startWorkerPool('local-backpressure-token', 1, {
			maxAdmittedRequests: admittedLimit,
			queueTimeout: 10_000,
			globalLimit: { max: 1_000, perMs: 1 },
		});
		let overloaded = 0;

		try {
			const pending = Array.from({ length: requestCount }, (_, index) => {
				const requestId = `stress-backpressure-${index}`;
				return request(fixture.proxy.url, {
					path: '/v1/requests',
					method: 'POST',
					credential: fixture.services[0].credential,
					contentType: 'application/json',
					requestId,
					body: requestBody(requestId, `/channels/${100_000_000_000_000_000n + BigInt(index)}`),
				}).then(result => {
					if (result.status === 503 && (JSON.parse(result.body) as { code?: unknown }).code === 'PROXY_OVERLOADED') {
						overloaded++;
					}
					return result;
				});
			});

			await vi.waitUntil(
				() =>
					overloaded === requestCount - admittedLimit && fixture.proxy.getStats().admittedRequests === admittedLimit,
				{ interval: 1, timeout: 10_000 },
			);
			assert.equal(fixture.proxy.getStats().admittedRequests, admittedLimit);
			releaseUpstream.resolve();
			const results = await Promise.all(pending);
			const stats = fixture.proxy.getStats();

			assert.equal(results.filter(result => result.status === 200).length, admittedLimit);
			assert.equal(overloaded, requestCount - admittedLimit);
			assert.equal(vi.mocked(globalThis.fetch).mock.calls.length, admittedLimit);
			assert.deepInclude(stats, {
				pendingRequests: 0,
				inFlightRequests: 0,
				admittedRequests: 0,
				bufferedBytes: 0,
				outcomes: {
					not_dispatched: requestCount - admittedLimit,
					completed: admittedLimit,
					unknown: 0,
				},
			});
		} finally {
			releaseUpstream.resolve();
			await fixture.close();
		}
	}, 30_000);

	const liveToken = process.env.DISCORD_TOKEN;
	test.runIf(liveToken !== undefined)(
		'coordinates bounded read-only load against live Discord REST',
		async () => {
			if (!liveToken) throw new Error('DISCORD_TOKEN must not be empty.');
			const requestCount = 120;
			const workerCount = 8;
			const fixture = await startWorkerPool(liveToken, workerCount, {
				maxAdmittedRequests: 128,
				queueTimeout: 60_000,
				globalLimit: { max: 40, perMs: 1_000 },
			});
			let invalidFailures = 0;
			let rateLimitEvents = 0;
			const disposeRestObserver = fixture.rest.observe({
				onFail({ statusCode }) {
					if (statusCode === 401 || statusCode === 403) invalidFailures++;
				},
				onRatelimit() {
					rateLimitEvents++;
				},
			});

			try {
				// Fail before the load if the token is unusable, limiting that case to one invalid Discord request.
				const warmup = await fixture.workers[0].request<{ id: string; bot?: boolean }>('GET', '/users/@me');
				assert.isString(warmup.id);
				assert.equal(warmup.bot, true);

				let peakAdmitted = 0;
				let peakPending = 0;
				let peakInFlight = 0;
				const sampler = setInterval(() => {
					const stats = fixture.proxy.getStats();
					peakAdmitted = Math.max(peakAdmitted, stats.admittedRequests);
					peakPending = Math.max(peakPending, stats.pendingRequests);
					peakInFlight = Math.max(peakInFlight, stats.inFlightRequests);
				}, 5);
				const startedAt = performance.now();
				let results: { id: string; bot?: boolean }[];
				try {
					results = await runConcurrently(requestCount, 64, index =>
						fixture.workers[index % workerCount].request('GET', '/users/@me'),
					);
				} finally {
					clearInterval(sampler);
				}
				const elapsedMs = performance.now() - startedAt;
				const stats = fixture.proxy.getStats();

				assert.equal(
					results.every(result => result.id === warmup.id && result.bot === true),
					true,
				);
				assert.isAtLeast(elapsedMs, 1_800);
				assert.equal(invalidFailures, 0);
				assert.deepInclude(stats, {
					state: 'ready',
					pendingRequests: 0,
					inFlightRequests: 0,
					admittedRequests: 0,
					bufferedBytes: 0,
					outcomes: { not_dispatched: 0, completed: requestCount + 1, unknown: 0 },
				});
				assert.isAtLeast(stats.invalidBudgetRemaining, 9_900);
				console.info(
					`[proxy stress/live] requests=${requestCount + 1} workers=${workerCount} elapsedMs=${elapsedMs.toFixed(0)} peakAdmitted=${peakAdmitted} peakPending=${peakPending} peakInFlight=${peakInFlight} rateLimitEvents=${rateLimitEvents}`,
				);
			} finally {
				disposeRestObserver();
				await fixture.close();
			}
		},
		120_000,
	);
});
