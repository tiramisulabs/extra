import http from 'node:http';
import { ApiHandler, WorkerClient } from 'seyfert';
import { afterEach, assert, describe, test, vi } from 'vitest';
import { createProxy, createServiceCredential, ProxyApiHandler, ProxyError } from '../src';
import { deferred, response, startProxy } from './helpers.mts';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

describe('ProxyApiHandler integration', () => {
	test('runs through a WorkerClient and preserves JSON, query, reason, and auth', async () => {
		const fetcher = vi.fn<typeof fetch>(async (url, init) => {
			assert.match(String(url), /\/channels\/123\?limit=1$/);
			const headers = init?.headers as Record<string, string>;
			assert.equal(headers.Authorization, 'Bot discord-token');
			assert.equal(headers['X-Audit-Log-Reason'], 'integration');
			assert.equal(init?.body, JSON.stringify({ content: 'hello' }));
			return response(200, { id: 'message' });
		});
		const fixture = await startProxy(fetcher);
		cleanups.push(() => fixture.close());
		const worker = new WorkerClient();
		worker.setServices({ rest: fixture.handler });

		const result = await worker.rest.request<{ id: string }>('POST', '/channels/123', {
			query: { limit: 1 },
			body: { content: 'hello' },
			reason: 'integration',
		});

		assert.deepEqual(result, { id: 'message' });
		assert.equal(fetcher.mock.calls.length, 1);
	});

	test('round-trips files without base64 and supports auth false', async () => {
		const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
			const headers = init?.headers as Record<string, string>;
			assert.equal(headers.Authorization, undefined);
			assert.instanceOf(init?.body, FormData);
			const form = init?.body as FormData;
			const payloadParts = form.getAll('payload_json');
			assert.equal(
				payloadParts.find(part => typeof part === 'string'),
				JSON.stringify({ content: 'file' }),
			);
			const file = form.get('files[0]');
			assert.ok(file && typeof file !== 'string');
			assert.equal(file.name, 'hello.txt');
			assert.equal(file.type, 'text/plain; charset=utf-8');
			assert.equal(await file.text(), 'hello');
			const collision = payloadParts.find(part => typeof part !== 'string');
			assert.ok(collision && typeof collision !== 'string');
			assert.equal(collision.name, 'collision.txt');
			assert.equal(await collision.text(), 'collision');
			return response(200, { ok: true });
		});
		const fixture = await startProxy(fetcher);
		cleanups.push(() => fixture.close());

		assert.deepEqual(
			await fixture.handler.request('POST', '/interactions/1/token/callback', {
				auth: false,
				body: { content: 'file' },
				files: [
					{ filename: 'hello.txt', contentType: 'text/plain; charset=utf-8', data: Buffer.from('hello') },
					{ key: 'payload_json', filename: 'collision.txt', data: Buffer.from('collision') },
				],
			}),
			{ ok: true },
		);
	});

	test('preserves top-level JSON arrays used by bulk command routes', async () => {
		const commands = [{ name: 'ping', description: 'Ping' }];
		const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
			assert.equal(init?.body, JSON.stringify(commands));
			return response(200, commands);
		});
		const fixture = await startProxy(fetcher);
		cleanups.push(() => fixture.close());

		assert.deepEqual(
			await fixture.handler.request('PUT', '/applications/1/commands', {
				body: commands as unknown as Record<string, unknown>,
			}),
			commands,
		);
	});

	test('routes token overrides through isolated ApiHandler contexts', async () => {
		const authorizations: (string | undefined)[] = [];
		const createRestForToken = vi.fn((token: string) => new ApiHandler({ token, workerProxy: false }));
		const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
			authorizations.push((init?.headers as Record<string, string>).Authorization);
			return response(200, {});
		});
		const fixture = await startProxy(fetcher, { createRestForToken });
		cleanups.push(() => fixture.close());

		await fixture.handler.request('GET', '/gateway/bot');
		await fixture.handler.request('GET', '/gateway/bot', { token: 'other' });
		await fixture.handler.request('GET', '/users/@me', { token: 'other' });
		assert.deepEqual(authorizations, ['Bot discord-token', 'Bot other', 'Bot other']);
		assert.equal(createRestForToken.mock.calls.length, 1);
	});

	test('creates one context for concurrent requests after default token rotation', async () => {
		const factoryRelease = deferred<void>();
		const createRestForToken = vi.fn(async (token: string) => {
			await factoryRelease.promise;
			return new ApiHandler({ token, workerProxy: false });
		});
		const fixture = await startProxy(async () => response(200, {}), { createRestForToken });
		cleanups.push(() => fixture.close());
		fixture.rest.options.token = 'rotated';

		const first = fixture.handler.request('GET', '/channels/1');
		const second = fixture.handler.request('GET', '/channels/2');
		await vi.waitUntil(() => createRestForToken.mock.calls.length > 0, { interval: 1 });
		await new Promise(resolve => setImmediate(resolve));

		assert.equal(createRestForToken.mock.calls.length, 1);
		factoryRelease.resolve();
		await Promise.all([first, second]);
		assert.equal(createRestForToken.mock.calls.length, 1);
	});

	test('rejects a factory that reuses an evicted handler for another token', async () => {
		const shared = new ApiHandler({ token: 'first', workerProxy: false });
		const fixture = await startProxy(async () => response(200, {}), {
			maxTokenContexts: 1,
			createRestForToken: token => {
				shared.options.token = token;
				return shared;
			},
		});
		cleanups.push(() => fixture.close());

		await fixture.handler.request('GET', '/gateway/bot', { token: 'first' });
		const error = await fixture.handler.request('GET', '/gateway/bot', { token: 'second' }).catch(value => value);

		assert.instanceOf(error, ProxyError);
		assert.equal(error.code, 'PROXY_TOKEN_CONTEXT_UNAVAILABLE');
		assert.equal(error.outcome, 'not_dispatched');
	});

	test('rejects worker-proxy handlers returned by the context factory', async () => {
		const fixture = await startProxy(async () => response(200, {}), {
			createRestForToken: token => {
				const rest = new ApiHandler({ token, workerProxy: false });
				rest.options.workerProxy = true;
				return rest;
			},
		});
		cleanups.push(() => fixture.close());

		const error = await fixture.handler.request('GET', '/gateway/bot', { token: 'other' }).catch(value => value);

		assert.instanceOf(error, ProxyError);
		assert.equal(error.code, 'PROXY_TOKEN_CONTEXT_UNAVAILABLE');
		assert.equal(error.outcome, 'not_dispatched');
	});

	test('does not evict a token context before an exhausted route bucket resets', async () => {
		const createRestForToken = vi.fn((token: string) => new ApiHandler({ token, workerProxy: false }));
		const fixture = await startProxy(
			async () =>
				response(
					200,
					{ ok: true },
					{ 'x-ratelimit-limit': '1', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '0.04' },
				),
			{ createRestForToken, maxTokenContexts: 1 },
		);
		cleanups.push(() => fixture.close());

		await fixture.handler.request('GET', '/channels/1', { token: 'first' });
		const blocked = await fixture.handler.request('GET', '/channels/2', { token: 'second' }).catch(value => value);
		assert.instanceOf(blocked, ProxyError);
		assert.equal(blocked.code, 'PROXY_TOKEN_CONTEXT_UNAVAILABLE');

		await new Promise(resolve => setTimeout(resolve, 50));
		assert.deepEqual(await fixture.handler.request('GET', '/channels/2', { token: 'second' }), { ok: true });
		assert.equal(createRestForToken.mock.calls.length, 2);
	});

	test('rejects an override as not dispatched when the deployment has no context factory', async () => {
		const fetcher = vi.fn<typeof fetch>(async () => response(200, {}));
		const fixture = await startProxy(fetcher, { createRestForToken: undefined });
		cleanups.push(() => fixture.close());

		const error = await fixture.handler.request('GET', '/gateway/bot', { token: 'other' }).catch(value => value);
		assert.instanceOf(error, ProxyError);
		assert.equal(error.code, 'PROXY_TOKEN_CONTEXT_UNAVAILABLE');
		assert.equal(error.outcome, 'not_dispatched');
		assert.equal(error.phase, 'admission');
		assert.equal(error.instanceId, fixture.proxy.instanceId);
		assert.equal(fetcher.mock.calls.length, 0);
	});

	test('rejects proxy base URLs with a path instead of silently rewriting them', () => {
		assert.throws(() => new ProxyApiHandler({ url: 'https://proxy.internal/base', credential: 'service' }), /pathname/);
	});

	test('rejects ProxyApiHandler as the central Discord handler', async () => {
		const service = createServiceCredential('loop-guard');
		const handler = new ProxyApiHandler({ url: 'http://127.0.0.1:4444', credential: service.credential });

		const error = await createProxy({ rest: handler, credentials: [service.hash], port: 0 }).catch(value => value);
		assert.instanceOf(error, ProxyError);
		assert.equal(error.code, 'PROXY_UNSUPPORTED_SEYFERT');
	});

	test('returns undefined for a successful empty Discord response', async () => {
		const fixture = await startProxy(async () => new Response(undefined, { status: 204 }));
		cleanups.push(() => fixture.close());

		assert.equal(await fixture.handler.request('DELETE', '/channels/123/messages/123'), undefined);
	});

	test('classifies a refused connection as not dispatched', async () => {
		const unavailable = http.createServer();
		await new Promise<void>(resolve => unavailable.listen(0, resolve));
		const address = unavailable.address();
		assert.ok(address && typeof address !== 'string');
		await new Promise<void>(resolve => unavailable.close(() => resolve()));
		const handler = new ProxyApiHandler({
			url: `http://127.0.0.1:${address.port}`,
			credential: 'service',
		});

		const error = await handler.request('GET', '/gateway/bot').catch(value => value);
		assert.instanceOf(error, ProxyError);
		assert.equal(error.outcome, 'not_dispatched');
	});

	test('bounds stalled proxy requests and classifies their outcome as unknown', async () => {
		const stalled = http.createServer(() => {});
		await new Promise<void>(resolve => stalled.listen(0, resolve));
		const address = stalled.address();
		assert.ok(address && typeof address !== 'string');
		const handler = new ProxyApiHandler({
			url: `http://127.0.0.1:${address.port}`,
			credential: 'service',
			requestTimeout: 25,
		});

		try {
			const error = await handler.request('GET', '/gateway/bot').catch(value => value);
			assert.instanceOf(error, ProxyError);
			assert.equal(error.outcome, 'unknown');
			assert.match(error.message, /timed out/i);
		} finally {
			stalled.closeAllConnections();
			await new Promise<void>(resolve => stalled.close(() => resolve()));
		}
	});
});
