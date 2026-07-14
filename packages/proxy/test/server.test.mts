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
	test('exposes unauthenticated liveness and authenticates readiness and stats', async () => {
		const fixture = await startProxy(async () => response(200, {}));
		cleanups.push(() => fixture.close());

		assert.deepEqual(await request(fixture.proxy.url, { path: '/health/live' }), { status: 200, body: '' });
		assert.equal((await request(fixture.proxy.url, { path: '/health/ready' })).status, 401);
		assert.equal(
			(await request(fixture.proxy.url, { path: '/health/ready', credential: fixture.service.credential })).status,
			200,
		);
		const stats = await request(fixture.proxy.url, { path: '/stats', credential: fixture.service.credential });
		assert.equal(stats.status, 200);
		assert.equal(JSON.parse(stats.body).instanceId, fixture.proxy.instanceId);
		assert.equal(stats.body.includes('discord-token'), false);
		assert.equal(stats.body.includes(fixture.service.credential), false);
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

	test('keeps Discord 429 inside the RPC and lets the central ApiHandler retry it', async () => {
		let calls = 0;
		const fetcher = vi.fn<typeof fetch>(async () => {
			if (++calls === 1) {
				return response(
					429,
					{ message: 'rate limited', retry_after: 0.001 },
					{
						'x-ratelimit-global': 'true',
						'x-ratelimit-scope': 'global',
						'x-ratelimit-reset-after': '0.001',
					},
				);
			}
			return response(200, { ok: true });
		});
		const fixture = await startProxy(fetcher);
		cleanups.push(() => fixture.close());

		assert.deepEqual(await fixture.handler.request('GET', '/gateway/bot'), { ok: true });
		assert.equal(calls, 2);
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

	test('quarantines the whole proxy after an authenticated Discord 401', async () => {
		const fetcher = vi.fn<typeof fetch>(async () => response(401, { code: 0, message: '401: Unauthorized' }));
		const fixture = await startProxy(fetcher);
		cleanups.push(() => fixture.close());

		const first = await fixture.handler.request('GET', '/users/@me').catch(value => value);
		assert.instanceOf(first, SeyfertError);
		const second = await fixture.handler.request('GET', '/gateway/bot').catch(value => value);
		assert.instanceOf(second, ProxyError);
		assert.equal(second.code, 'PROXY_QUARANTINED');
		assert.equal(second.outcome, 'not_dispatched');
		assert.equal(fetcher.mock.calls.length, 1);
		assert.equal(
			(await request(fixture.proxy.url, { path: '/health/ready', credential: fixture.service.credential })).status,
			503,
		);
	});

	test('temporarily quarantines when the invalid request budget is exhausted', async () => {
		const fetcher = vi.fn<typeof fetch>(async () => response(403, { code: 50013, message: 'Missing Permissions' }));
		const fixture = await startProxy(fetcher, { invalidWindow: { max: 1, perMs: 20 } });
		cleanups.push(() => fixture.close());

		assert.instanceOf(await fixture.handler.request('GET', '/channels/1').catch(value => value), SeyfertError);
		const blocked = await fixture.handler.request('GET', '/channels/2').catch(value => value);
		assert.instanceOf(blocked, ProxyError);
		assert.equal(blocked.code, 'PROXY_QUARANTINED');
		await new Promise(resolve => setTimeout(resolve, 25));
		assert.instanceOf(await fixture.handler.request('GET', '/channels/3').catch(value => value), SeyfertError);
		assert.equal(fetcher.mock.calls.length, 2);
	});

	test('rejects oversized payloads and raw token overrides before dispatch', async () => {
		const fetcher = vi.fn<typeof fetch>(async () => response(200, {}));
		const fixture = await startProxy(fetcher, { maxRequestBytes: 256 });
		cleanups.push(() => fixture.close());

		const oversized = await fixture.handler
			.request('POST', '/channels/1/messages', { body: { content: 'x'.repeat(512) } })
			.catch(value => value);
		assert.instanceOf(oversized, ProxyError);
		assert.equal(oversized.code, 'PROXY_PAYLOAD_TOO_LARGE');

		const requestId = 'raw-token-override';
		const raw = await request(fixture.proxy.url, {
			path: '/api',
			method: 'POST',
			credential: fixture.service.credential,
			contentType: 'application/json',
			body: JSON.stringify({ method: 'GET', url: '/gateway/bot', requestId, token: 'other' }),
		});
		assert.equal(raw.status, 400);
		assert.deepInclude(JSON.parse(raw.body), {
			code: 'PROXY_TOKEN_OVERRIDE_UNSUPPORTED',
			outcome: 'not_dispatched',
			requestId,
		});
		assert.equal(fetcher.mock.calls.length, 0);
	});

	test('drains without cancelling dispatched work and counts timeout ambiguity once', async () => {
		const held = deferred<Response>();
		const fixture = await startProxy(() => held.promise);
		const pending = fixture.handler.request('GET', '/gateway/bot').catch(value => value);
		while (fixture.proxy.getStats().inFlightRequests === 0) await new Promise(resolve => setTimeout(resolve, 1));

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
