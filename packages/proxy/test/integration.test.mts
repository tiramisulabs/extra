import http from 'node:http';
import { WorkerClient } from 'seyfert';
import { afterEach, assert, describe, test, vi } from 'vitest';
import { ProxyApiHandler, ProxyError } from '../src';
import { response, startProxy } from './helpers.mts';

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
					{ filename: 'hello.txt', contentType: 'text/plain', data: Buffer.from('hello') },
					{ key: 'payload_json', filename: 'collision.txt', data: Buffer.from('collision') },
				],
			}),
			{ ok: true },
		);
	});

	test('rejects token overrides before opening a connection', async () => {
		const fetcher = vi.fn<typeof fetch>(async () => response(200, {}));
		const fixture = await startProxy(fetcher);
		cleanups.push(() => fixture.close());

		const error = await fixture.handler.request('GET', '/gateway/bot', { token: 'other' }).catch(value => value);
		assert.instanceOf(error, ProxyError);
		assert.equal(error.code, 'PROXY_TOKEN_OVERRIDE_UNSUPPORTED');
		assert.equal(error.outcome, 'not_dispatched');
		assert.equal(fetcher.mock.calls.length, 0);
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
});
