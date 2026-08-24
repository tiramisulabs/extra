import http from 'node:http';
import { SeyfertError } from 'seyfert';
import { afterEach, assert, describe, test, vi } from 'vitest';
import { ProxyError, type ProxyObservation } from '../src';
import { deferred, request, response, startProxy } from './helpers.mts';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('proxy server', () => {
	test('authenticates liveness, readiness, and stats', async () => {
		const fixture = await startProxy(async () => response(200, {}));
		cleanups.push(() => fixture.close());

		assert.equal((await request(fixture.proxy.url, { path: '/health/live' })).status, 401);
		assert.deepEqual(
			await request(fixture.proxy.url, { path: '/health/live', credential: fixture.service.credential }),
			{ status: 200, body: '' },
		);
		assert.equal((await request(fixture.proxy.url, { path: '/health/ready' })).status, 401);
		assert.equal(
			(await request(fixture.proxy.url, { path: '/health/ready', credential: fixture.service.credential })).status,
			200,
		);
		const stats = await request(fixture.proxy.url, { path: '/stats', credential: fixture.service.credential });
		const snapshot = JSON.parse(stats.body);
		assert.equal(stats.status, 200);
		assert.deepInclude(snapshot, {
			instanceId: fixture.proxy.instanceId,
			pendingRequests: 0,
			inFlightRequests: 0,
			admittedRequests: 0,
			bufferedBytes: 0,
			tokenContexts: 1,
			deduplicationEntries: 0,
			invalidBudgetRemaining: 10_000,
			authenticatedGateOccupancy: 0,
			unauthenticatedGateOccupancy: 0,
			outcomes: { not_dispatched: 0, completed: 0, unknown: 0 },
		});
		assert.equal('globalGateOccupancy' in snapshot, false);
		assert.equal(stats.body.includes('discord-token'), false);
		assert.equal(stats.body.includes(fixture.service.credential), false);
	});

	test('reports token contexts and gate occupancy by their actual scope', async () => {
		const fixture = await startProxy(async () => response(200, { ok: true }), {
			globalLimit: { perMs: 60_000 },
			unauthenticatedLimit: { perMs: 60_000 },
		});
		cleanups.push(() => fixture.close());

		await fixture.handler.request('GET', '/channels/1');
		await fixture.handler.request('GET', '/channels/2', { token: 'override-token' });
		await fixture.handler.request('POST', '/interactions/1/token/callback', { auth: false });

		assert.deepInclude(fixture.proxy.getStats(), {
			admittedRequests: 0,
			bufferedBytes: 0,
			tokenContexts: 2,
			deduplicationEntries: 3,
			authenticatedGateOccupancy: 2,
			unauthenticatedGateOccupancy: 1,
		});
	});

	test('fails closed when a custom authentication service is unavailable', async () => {
		const fixture = await startProxy(async () => response(200, {}), {
			authenticate: async () => {
				throw new Error('private upstream failure');
			},
		});
		cleanups.push(() => fixture.close());

		const result = await request(fixture.proxy.url, {
			path: '/health/live',
			credential: fixture.service.credential,
		});
		assert.equal(result.status, 503);
		assert.deepInclude(JSON.parse(result.body), {
			code: 'PROXY_AUTHENTICATION_UNAVAILABLE',
			phase: 'authentication',
		});
		assert.equal(result.body.includes('private upstream failure'), false);
	});

	test('observes sanitized request outcomes and returns detached stats snapshots', async () => {
		const fixture = await startProxy(async () => response(200, { ok: true }));
		cleanups.push(() => fixture.close());
		const observations: ProxyObservation[] = [];
		const dispose = fixture.proxy.observe(observation => observations.push({ ...observation }));

		await fixture.handler.request('GET', '/channels/123/messages');
		const stats = fixture.proxy.getStats();
		stats.outcomes.completed = 999;
		dispose();

		assert.equal(fixture.proxy.getStats().outcomes.completed, 1);
		const completed = observations.find(
			observation => observation.type === 'request' && observation.outcome === 'completed',
		);
		assert.ok(completed);
		assert.deepInclude(completed, { type: 'request', serviceId: 'test-service', outcome: 'completed' });
		assert.equal('url' in completed, false);
	});

	test('returns a protocol envelope for unknown routes', async () => {
		const fixture = await startProxy(async () => response(200, {}));
		cleanups.push(() => fixture.close());

		const result = await request(fixture.proxy.url, {
			path: '/missing',
			credential: fixture.service.credential,
		});
		assert.equal(result.status, 404);
		assert.deepInclude(JSON.parse(result.body), {
			kind: 'proxy_error',
			code: 'PROXY_NOT_FOUND',
			phase: 'routing',
			instanceId: fixture.proxy.instanceId,
		});
	});

	test('reuses completed deduplication results and rejects conflicting request IDs', async () => {
		const fetcher = vi.fn<typeof fetch>(async () => response(200, { ok: true }));
		const fixture = await startProxy(fetcher);
		cleanups.push(() => fixture.close());
		const wire = {
			method: 'POST',
			url: '/channels/1/messages',
			requestId: 'stable-request',
			body: { content: 'same' },
		};
		const send = (body: unknown) =>
			request(fixture.proxy.url, {
				path: '/v1/requests',
				method: 'POST',
				credential: fixture.service.credential,
				contentType: 'application/json',
				body: JSON.stringify(body),
			});

		assert.equal((await send(wire)).status, 200);
		assert.equal((await send(wire)).status, 200);
		assert.equal(fetcher.mock.calls.length, 1);
		const conflict = await send({ ...wire, body: { content: 'different' } });
		assert.equal(conflict.status, 409);
		assert.equal(JSON.parse(conflict.body).code, 'PROXY_REQUEST_ID_CONFLICT');
		const authorizationConflict = await send({ ...wire, token: 'other' });
		assert.equal(authorizationConflict.status, 409);
		assert.equal(JSON.parse(authorizationConflict.body).code, 'PROXY_REQUEST_ID_CONFLICT');
		assert.equal(fetcher.mock.calls.length, 1);
	});

	test('caches queue timeouts but releases other not-dispatched request IDs', async () => {
		const fetcher = vi.fn<typeof fetch>(async () => response(200, { ok: true }));
		const fixture = await startProxy(fetcher, {
			globalLimit: { max: 1, perMs: 10_000 },
			queueTimeout: 1_000,
		});
		cleanups.push(() => fixture.close());
		await fixture.handler.request('GET', '/gateway/bot');

		const timedOutPayload = JSON.stringify({
			method: 'GET',
			url: '/channels/1',
			requestId: 'cached-timeout',
		});
		const sendTimedOut = () =>
			request(fixture.proxy.url, {
				path: '/v1/requests',
				method: 'POST',
				credential: fixture.service.credential,
				contentType: 'application/json',
				requestId: 'cached-timeout',
				body: timedOutPayload,
			});
		const timedOut = await sendTimedOut();
		assert.equal(timedOut.status, 504);
		assert.equal(JSON.parse(timedOut.body).code, 'PROXY_QUEUE_TIMEOUT');
		const cached = await sendTimedOut();
		assert.equal(cached.status, 504);
		assert.equal(fetcher.mock.calls.length, 1);

		const disconnectedToken = 'disconnected-token';
		await fixture.handler.request('GET', '/gateway/bot', { token: disconnectedToken });
		const disconnectedPayload = JSON.stringify({
			method: 'GET',
			url: '/channels/2',
			requestId: 'disconnected-before-dispatch',
			token: disconnectedToken,
		});
		const disconnected = http.request(new URL('/v1/requests', fixture.proxy.url), {
			method: 'POST',
			headers: {
				authorization: `Bearer ${fixture.service.credential}`,
				'content-length': Buffer.byteLength(disconnectedPayload),
				'content-type': 'application/json',
				'x-proxy-request-id': 'disconnected-before-dispatch',
			},
		});
		disconnected.on('error', () => {});
		disconnected.end(disconnectedPayload);
		await vi.waitUntil(() => fixture.proxy.getStats().pendingRequests > 0, { interval: 1, timeout: 5_000 });
		disconnected.destroy();
		await vi.waitUntil(() => fixture.proxy.getStats().pendingRequests === 0, { interval: 1, timeout: 5_000 });

		const retried = await request(fixture.proxy.url, {
			path: '/v1/requests',
			method: 'POST',
			credential: fixture.service.credential,
			contentType: 'application/json',
			requestId: 'disconnected-before-dispatch',
			body: JSON.stringify({
				method: 'GET',
				url: '/channels/2',
				requestId: 'disconnected-before-dispatch',
				token: 'retry-token',
			}),
		});
		assert.equal(retried.status, 200);
		assert.equal(fetcher.mock.calls.length, 3);
	}, 10_000);

	test('counts in-flight duplicates against admission and records their outcomes', async () => {
		const held = deferred<void>();
		const fetcher = vi.fn<typeof fetch>(async () => {
			await held.promise;
			return response(200, { ok: true });
		});
		const fixture = await startProxy(fetcher, { maxAdmittedRequests: 2 });
		cleanups.push(() => fixture.close());
		const payload = JSON.stringify({
			method: 'GET',
			url: '/gateway/bot',
			requestId: 'bounded-duplicate',
		});
		const send = () =>
			request(fixture.proxy.url, {
				path: '/v1/requests',
				method: 'POST',
				credential: fixture.service.credential,
				contentType: 'application/json',
				requestId: 'bounded-duplicate',
				body: payload,
			});
		const first = send();
		const duplicate = send();
		const expectedBufferedBytes = Buffer.byteLength(payload);
		const activeStats = await vi.waitUntil(
			() => {
				const stats = fixture.proxy.getStats();
				return stats.admittedRequests >= 2 &&
					stats.bufferedBytes === expectedBufferedBytes &&
					stats.authenticatedGateOccupancy === 1
					? stats
					: false;
			},
			{ interval: 1 },
		);

		assert.deepInclude(activeStats, {
			admittedRequests: 2,
			bufferedBytes: expectedBufferedBytes,
			tokenContexts: 1,
			deduplicationEntries: 1,
			authenticatedGateOccupancy: 1,
			unauthenticatedGateOccupancy: 0,
		});
		assert.equal(fetcher.mock.calls.length, 1);
		const overloaded = await request(fixture.proxy.url, {
			path: '/v1/requests',
			method: 'POST',
			credential: fixture.service.credential,
			contentType: 'application/json',
			requestId: 'third-request',
			body: JSON.stringify({ method: 'GET', url: '/channels/3', requestId: 'third-request' }),
		});
		assert.equal(overloaded.status, 503);
		assert.equal(JSON.parse(overloaded.body).code, 'PROXY_OVERLOADED');

		held.resolve();
		assert.equal((await first).status, 200);
		assert.equal((await duplicate).status, 200);
		assert.equal(fixture.proxy.getStats().outcomes.completed, 2);
	});

	test('keeps Discord 429 inside the RPC and lets the central ApiHandler retry it', async () => {
		let calls = 0;
		const fetcher = vi.fn<typeof fetch>(async () => {
			if (++calls === 1) {
				return response(
					429,
					{ message: 'rate limited' },
					{
						'x-ratelimit-global': 'true',
						'x-ratelimit-scope': 'global',
						'x-ratelimit-reset-after': '0.1',
					},
				);
			}
			return response(200, { ok: true });
		});
		const fixture = await startProxy(fetcher);
		cleanups.push(() => fixture.close());

		const first = fixture.handler.request('GET', '/gateway/bot');
		await vi.waitUntil(() => calls > 0, { interval: 1 });
		await new Promise(resolve => setImmediate(resolve));
		const second = fixture.handler.request('GET', '/channels/1');
		await vi.waitUntil(() => fixture.proxy.getStats().admittedRequests >= 2, { interval: 1 });
		assert.equal(fixture.proxy.getStats().inFlightRequests, 1);
		assert.equal(fixture.proxy.getStats().pendingRequests, 1);

		assert.deepEqual(await first, { ok: true });
		assert.deepEqual(await second, { ok: true });
		assert.equal(calls, 3);
	});

	test('keeps route buckets centralized with Discord reset headers', async () => {
		let calls = 0;
		const fixture = await startProxy(async () => {
			calls++;
			return response(
				200,
				{ ok: true },
				{ 'x-ratelimit-limit': '1', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '0.02' },
			);
		});
		cleanups.push(() => fixture.close());

		await fixture.handler.request('GET', '/channels/123/messages');
		const started = Date.now();
		await fixture.handler.request('GET', '/channels/123/messages');
		assert.equal(calls, 2);
		assert.ok(Date.now() - started >= 10);
	});

	test('snapshots the default token version before an admission wait', async () => {
		const authorizations: string[] = [];
		const fixture = await startProxy(
			async (_url, init) => {
				authorizations.push((init?.headers as Record<string, string>).Authorization);
				return response(200, { ok: true });
			},
			{ globalLimit: { max: 1, perMs: 25 } },
		);
		cleanups.push(() => fixture.close());

		await fixture.handler.request('GET', '/channels/1');
		const queued = fixture.handler.request('GET', '/channels/2');
		await vi.waitUntil(() => fixture.proxy.getStats().pendingRequests > 0, { interval: 1 });
		fixture.rest.options.token = 'rotated';
		await queued;
		await fixture.handler.request('GET', '/channels/3');

		assert.deepEqual(authorizations, ['Bot discord-token', 'Bot discord-token', 'Bot rotated']);
	});

	test('quarantines only the rejected token fingerprint after an authenticated Discord 401', async () => {
		const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
			const authorization = (init?.headers as Record<string, string>).Authorization;
			return authorization === 'Bot discord-token'
				? response(401, { code: 0, message: '401: Unauthorized' })
				: response(200, { ok: true });
		});
		const fixture = await startProxy(fetcher);
		cleanups.push(() => fixture.close());

		const first = await fixture.handler.request('GET', '/users/@me').catch(value => value);
		assert.instanceOf(first, SeyfertError);
		const second = await fixture.handler.request('GET', '/gateway/bot').catch(value => value);
		assert.instanceOf(second, ProxyError);
		assert.equal(second.code, 'PROXY_TOKEN_REJECTED');
		assert.equal(second.outcome, 'not_dispatched');
		assert.deepEqual(await fixture.handler.request('GET', '/gateway/bot', { token: 'rotated' }), { ok: true });
		assert.equal(fetcher.mock.calls.length, 2);
		const unavailable = await request(fixture.proxy.url, {
			path: '/health/ready',
			credential: fixture.service.credential,
		});
		assert.equal(unavailable.status, 503);
		assert.equal(JSON.parse(unavailable.body).code, 'PROXY_TOKEN_REJECTED');
		assert.equal(fixture.proxy.getStats().state, 'unavailable');
		fixture.rest.options.token = 'rotated';
		assert.equal(
			(await request(fixture.proxy.url, { path: '/health/ready', credential: fixture.service.credential })).status,
			200,
		);
	});

	test('becomes unready when the default token rotates without a context factory', async () => {
		const fixture = await startProxy(async () => response(200, {}), { createRestForToken: undefined });
		cleanups.push(() => fixture.close());
		fixture.rest.options.token = 'rotated';

		const readiness = await request(fixture.proxy.url, {
			path: '/health/ready',
			credential: fixture.service.credential,
		});

		assert.equal(readiness.status, 503);
		assert.equal(JSON.parse(readiness.body).code, 'PROXY_TOKEN_CONTEXT_UNAVAILABLE');
		assert.equal(fixture.proxy.getStats().state, 'unavailable');
	});

	test('temporarily quarantines when the invalid request budget is exhausted', async () => {
		const fetcher = vi.fn<typeof fetch>(async () => response(403, { code: 50013, message: 'Missing Permissions' }));
		const fixture = await startProxy(fetcher, { invalidWindow: { max: 1, perMs: 20 } });
		cleanups.push(() => fixture.close());
		const states: string[] = [];
		const dispose = fixture.proxy.observe(observation => {
			if (observation.type === 'state') states.push(observation.state);
		});

		assert.instanceOf(await fixture.handler.request('GET', '/channels/1').catch(value => value), SeyfertError);
		const blocked = await fixture.handler.request('GET', '/channels/2').catch(value => value);
		assert.instanceOf(blocked, ProxyError);
		assert.equal(blocked.code, 'PROXY_INVALID_REQUEST_BUDGET_EXHAUSTED');
		await vi.waitUntil(() => states.includes('quarantined'), { interval: 1 });
		await vi.waitUntil(() => states.includes('ready'), { interval: 1 });
		dispose();
		assert.instanceOf(await fixture.handler.request('GET', '/channels/3').catch(value => value), SeyfertError);
		assert.equal(fetcher.mock.calls.length, 2);
	});

	test('rejects oversized payloads and accepts raw token overrides through the factory', async () => {
		const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
			assert.equal((init?.headers as Record<string, string>).Authorization, 'Bot other');
			return response(200, {});
		});
		const fixture = await startProxy(fetcher, { maxRequestBytes: 256 });
		cleanups.push(() => fixture.close());

		const oversized = await fixture.handler
			.request('POST', '/channels/1/messages', { body: { content: 'x'.repeat(512) } })
			.catch(value => value);
		assert.instanceOf(oversized, ProxyError);
		assert.equal(oversized.code, 'PROXY_PAYLOAD_TOO_LARGE');

		const requestId = 'raw-token-override';
		const raw = await request(fixture.proxy.url, {
			path: '/v1/requests',
			method: 'POST',
			credential: fixture.service.credential,
			contentType: 'application/json',
			body: JSON.stringify({ method: 'GET', url: '/gateway/bot', requestId, token: 'other' }),
		});
		assert.equal(raw.status, 200);
		assert.equal(JSON.parse(raw.body).kind, 'success');
		assert.equal(fetcher.mock.calls.length, 1);
	});

	test('reserves admission before reading a body and bounds shutdown with a stalled upload', async () => {
		const fixture = await startProxy(async () => response(200, {}), { maxAdmittedRequests: 1 });
		cleanups.push(() => fixture.close());
		const slow = http.request(new URL('/v1/requests', fixture.proxy.url), {
			method: 'POST',
			headers: {
				authorization: `Bearer ${fixture.service.credential}`,
				'content-length': '1024',
				'content-type': 'application/json',
			},
		});
		slow.on('error', () => {});
		slow.flushHeaders();
		slow.write('{"method":');
		await vi.waitUntil(() => fixture.proxy.getStats().pendingRequests > 0, { interval: 1 });

		const overloaded = await request(fixture.proxy.url, {
			path: '/v1/requests',
			method: 'POST',
			credential: fixture.service.credential,
			contentType: 'application/json',
			body: JSON.stringify({ method: 'GET', url: '/gateway/bot', requestId: 'overloaded' }),
		});
		assert.equal(overloaded.status, 503);
		assert.equal(JSON.parse(overloaded.body).code, 'PROXY_OVERLOADED');

		const started = Date.now();
		await fixture.close(30);
		assert.ok(Date.now() - started < 500);
		assert.equal(fixture.proxy.getStats().state, 'closed');
		slow.destroy();
	});

	test('enforces aggregate buffered bytes while reading a chunked body', async () => {
		const fetcher = vi.fn<typeof fetch>(async () => response(200, {}));
		const fixture = await startProxy(fetcher, { maxBufferedBytes: 32 });
		cleanups.push(() => fixture.close());
		const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
			const req = http.request(
				new URL('/v1/requests', fixture.proxy.url),
				{
					method: 'POST',
					headers: {
						authorization: `Bearer ${fixture.service.credential}`,
						'content-type': 'application/json',
					},
				},
				res => {
					const chunks: Buffer[] = [];
					res.on('data', chunk => chunks.push(Buffer.from(chunk)));
					res.on('end', () => resolve({ status: res.statusCode ?? 500, body: Buffer.concat(chunks).toString() }));
				},
			);
			req.once('error', reject);
			req.write('x'.repeat(64));
		});

		assert.equal(result.status, 413);
		assert.equal(JSON.parse(result.body).code, 'PROXY_PAYLOAD_TOO_LARGE');
		assert.equal(fetcher.mock.calls.length, 0);
	});

	test('deduplicates identical in-flight request IDs during drain', async () => {
		const held = deferred<void>();
		const fetcher = vi.fn<typeof fetch>(async () => {
			await held.promise;
			return response(200, { ok: true });
		});
		const fixture = await startProxy(fetcher);
		cleanups.push(() => fixture.close());
		const payload = JSON.stringify({
			method: 'POST',
			url: '/interactions/1/token/callback',
			requestId: 'duplicate',
			auth: false,
			body: { type: 4 },
		});
		const first = request(fixture.proxy.url, {
			path: '/v1/requests',
			method: 'POST',
			credential: fixture.service.credential,
			contentType: 'application/json',
			body: payload,
		}).catch(value => value);
		const second = request(fixture.proxy.url, {
			path: '/v1/requests',
			method: 'POST',
			credential: fixture.service.credential,
			contentType: 'application/json',
			body: payload,
		}).catch(value => value);
		await vi.waitUntil(() => fixture.proxy.getStats().inFlightRequests >= 1, { interval: 1 });
		assert.equal(fetcher.mock.calls.length, 1);

		await fixture.proxy.close({ drainTimeout: 20 });
		assert.equal(fixture.proxy.getStats().outcomes.unknown, 1);
		held.resolve();
		await Promise.allSettled([first, second]);
	});

	test('drains without cancelling dispatched work and counts timeout ambiguity once', async () => {
		const held = deferred<Response>();
		const fixture = await startProxy(() => held.promise);
		const pending = fixture.handler.request('GET', '/gateway/bot').catch(value => value);
		await vi.waitUntil(() => fixture.proxy.getStats().inFlightRequests > 0, { interval: 1 });

		vi.useFakeTimers();
		const closing = fixture.close(50);
		await vi.advanceTimersByTimeAsync(50);
		await closing;
		const result = await pending;
		assert.instanceOf(result, ProxyError);
		assert.equal(result.outcome, 'unknown');
		assert.equal(fixture.proxy.getStats().outcomes.unknown, 1);
		assert.equal(fixture.proxy.getStats().state, 'closed');
		held.resolve(response(200, { ok: true }));
	});
});
