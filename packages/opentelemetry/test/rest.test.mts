import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { assert, describe, test } from 'vitest';
import {
	instrumentRest,
	type RestObserver,
	type RestObserverFailPayload,
	type RestObserverRatelimitPayload,
	type RestObserverRequestPayload,
	type RestObserverSuccessPayload,
	sanitizeRestTarget,
} from '../src/instrument/rest';
import { setTraceServiceName } from '../src/trace-api';
import { installTestTracer } from './helpers/otel-test-provider.mts';

function withProvider(run: (exporter: InMemorySpanExporter) => Promise<void> | void) {
	const { exporter, shutdown } = installTestTracer();
	setTraceServiceName('rest-test');
	return Promise.resolve(run(exporter)).finally(() => shutdown());
}

/** Fake `api.rest.observe` that captures the registered observer and disposer. */
function fakeRestApi() {
	let observer: RestObserver | undefined;
	let disposed = false;
	const api = {
		rest: {
			observe(obs: RestObserver) {
				observer = obs;
				return () => {
					disposed = true;
					observer = undefined;
				};
			},
		},
	};
	return {
		api,
		getObserver: () => observer,
		isDisposed: () => disposed,
	};
}

function requestPayload(
	partial: Partial<RestObserverRequestPayload> & Pick<RestObserverRequestPayload, 'method' | 'url'>,
): RestObserverRequestPayload {
	return {
		client: {},
		request: Object.freeze({
			auth: true,
			// Sensitive fields must never appear on spans even if present here.
			token: 'super-secret-token',
			body: { content: 'hi' },
		}),
		...partial,
	};
}

function successPayload(
	partial: Partial<RestObserverSuccessPayload> & Pick<RestObserverSuccessPayload, 'method' | 'url' | 'response'>,
): RestObserverSuccessPayload {
	return {
		...requestPayload(partial),
		response: partial.response,
	};
}

function failPayload(
	partial: Partial<RestObserverFailPayload> & Pick<RestObserverFailPayload, 'method' | 'url' | 'error'>,
): RestObserverFailPayload {
	return {
		...requestPayload(partial),
		error: partial.error,
		statusCode: partial.statusCode,
	};
}

function ratelimitPayload(
	partial: Partial<RestObserverRatelimitPayload> & Pick<RestObserverRatelimitPayload, 'method' | 'url' | 'response'>,
): RestObserverRatelimitPayload {
	return {
		...requestPayload(partial),
		response: partial.response,
	};
}

const SENSITIVE_ATTR_KEYS = ['authorization', 'Authorization', 'token', 'auth', 'cookie', 'body', 'request'];

function assertNoSensitiveAttributes(attrs: Record<string, unknown>): void {
	const keys = Object.keys(attrs);
	for (const forbidden of SENSITIVE_ATTR_KEYS) {
		assert.ok(!keys.includes(forbidden), `attributes must not include sensitive key "${forbidden}"`);
	}
	for (const key of keys) {
		assert.ok(!/authori[sz]ation|token|cookie|password|secret/i.test(key), `attributes key looks sensitive: ${key}`);
	}
	const serialized = JSON.stringify(attrs);
	for (const secret of ['super-secret-token', 'Bot.leaked', 'SUPER_SECRET_WEBHOOK_TOKEN']) {
		assert.ok(!serialized.includes(secret), `attributes leaked sensitive value "${secret}"`);
	}
}

describe('sanitizeRestTarget', () => {
	test('redacts Discord tokens, drops queries, and templates snowflakes', () => {
		assert.deepEqual(sanitizeRestTarget('/webhooks/123/SUPER_SECRET_WEBHOOK_TOKEN?wait=true'), {
			path: '/webhooks/123/REDACTED',
			template: '/webhooks/:id/:token',
		});
		assert.deepEqual(sanitizeRestTarget('/interactions/456/interaction-secret/callback'), {
			path: '/interactions/456/REDACTED/callback',
			template: '/interactions/:id/:token/callback',
		});
		assert.deepEqual(sanitizeRestTarget('/channels/123/messages/456'), {
			path: '/channels/123/messages/456',
			template: '/channels/:id/messages/:id',
		});
		assert.equal(sanitizeRestTarget('/invites/user-controlled-code').template, '/invites/:code');
		assert.equal(
			sanitizeRestTarget('/channels/123/messages/456/reactions/name%3A789/@me').template,
			'/channels/:id/messages/:id/reactions/:emoji/@me',
		);
	});
});

describe('instrumentRest (api.rest.observe)', () => {
	test('success → CLIENT span + status', async () => {
		await withProvider(async exporter => {
			const { api, getObserver } = fakeRestApi();
			const cleanup = instrumentRest(api, {
				checkIfShouldTrace: () => true,
				getMetrics: () => undefined,
			});

			const observer = getObserver();
			assert.ok(observer?.onRequest);
			assert.ok(observer?.onSuccess);

			await observer!.onRequest!(requestPayload({ method: 'GET', url: '/users/@me' }));
			await observer!.onSuccess!(
				successPayload({
					method: 'GET',
					url: '/users/@me',
					response: { status: 200 },
				}),
			);

			const spans = exporter.getFinishedSpans();
			assert.equal(spans.length, 1);
			assert.equal(spans[0].name, 'HTTP GET');
			assert.equal(spans[0].kind, SpanKind.CLIENT);
			assert.equal(spans[0].attributes['http.request.method'], 'GET');
			assert.equal(spans[0].attributes['url.path'], '/users/@me');
			assert.equal(spans[0].attributes['url.template'], '/users/@me');
			assert.equal(spans[0].attributes['http.response.status_code'], 200);
			assert.equal(spans[0].status.code, SpanStatusCode.UNSET);
			assertNoSensitiveAttributes(spans[0].attributes as Record<string, unknown>);

			cleanup();
		});
	});

	test('fail → ERROR status', async () => {
		await withProvider(async exporter => {
			const { api, getObserver } = fakeRestApi();
			const cleanup = instrumentRest(api, {
				checkIfShouldTrace: () => true,
				getMetrics: () => undefined,
			});

			const observer = getObserver()!;
			await observer.onRequest!(requestPayload({ method: 'POST', url: '/channels/1/messages' }));
			await observer.onFail!(
				failPayload({
					method: 'POST',
					url: '/channels/1/messages',
					error: new Error('network down'),
				}),
			);

			const spans = exporter.getFinishedSpans();
			assert.equal(spans.length, 1);
			assert.equal(spans[0].name, 'HTTP POST');
			assert.equal(spans[0].kind, SpanKind.CLIENT);
			assert.equal(spans[0].status.code, SpanStatusCode.ERROR);
			assert.ok(spans[0].events.some(e => e.name === 'exception'));
			assertNoSensitiveAttributes(spans[0].attributes as Record<string, unknown>);

			cleanup();
		});
	});

	test('fail with status >= 500 → ERROR + status_code', async () => {
		await withProvider(async exporter => {
			const { api, getObserver } = fakeRestApi();
			const cleanup = instrumentRest(api, {
				checkIfShouldTrace: () => true,
				getMetrics: () => undefined,
			});

			const observer = getObserver()!;
			await observer.onRequest!(requestPayload({ method: 'GET', url: '/gateway' }));
			await observer.onFail!(
				failPayload({
					method: 'GET',
					url: '/gateway',
					error: new Error('HTTP 503'),
					statusCode: 503,
				}),
			);

			const spans = exporter.getFinishedSpans();
			assert.equal(spans.length, 1);
			assert.equal(spans[0].attributes['http.response.status_code'], 503);
			assert.equal(spans[0].status.code, SpanStatusCode.ERROR);

			cleanup();
		});
	});

	test('fail with 4xx → CLIENT ERROR status', async () => {
		await withProvider(async exporter => {
			const { api, getObserver } = fakeRestApi();
			const cleanup = instrumentRest(api, {
				checkIfShouldTrace: () => true,
				getMetrics: () => undefined,
			});

			const observer = getObserver()!;
			await observer.onRequest!(requestPayload({ method: 'GET', url: '/users/0' }));
			await observer.onFail!(
				failPayload({
					method: 'GET',
					url: '/users/0',
					error: new Error('Unknown User'),
					statusCode: 404,
				}),
			);

			const spans = exporter.getFinishedSpans();
			assert.equal(spans.length, 1);
			assert.equal(spans[0].attributes['http.response.status_code'], 404);
			assert.equal(spans[0].status.code, SpanStatusCode.ERROR);
			assert.equal(spans[0].attributes['error.type'], '404');

			cleanup();
		});
	});

	test('redacts webhook tokens before filtering, tracing, and metrics', async () => {
		await withProvider(async exporter => {
			const sources: unknown[] = [];
			const recorded: Record<string, unknown>[] = [];
			const { api, getObserver } = fakeRestApi();
			const cleanup = instrumentRest(api, {
				checkIfShouldTrace: source => {
					sources.push(source);
					return true;
				},
				getMetrics: () => ({
					recordInteraction() {},
					recordEvent() {},
					recordRest(_duration, attributes) {
						recorded.push(attributes as Record<string, unknown>);
					},
					recordCache() {},
				}),
			});

			const url = '/webhooks/123/SUPER_SECRET_WEBHOOK_TOKEN?wait=true';
			const observer = getObserver()!;
			await observer.onRequest!(requestPayload({ method: 'POST', url }));
			await observer.onSuccess!(successPayload({ method: 'POST', url, response: { status: 204 } }));

			assert.deepEqual(sources, [{ kind: 'rest', method: 'POST', path: '/webhooks/123/REDACTED' }]);
			const span = exporter.getFinishedSpans()[0];
			assert.equal(span.attributes['url.path'], '/webhooks/123/REDACTED');
			assert.equal(span.attributes['url.template'], '/webhooks/:id/:token');
			assert.equal(recorded[0]['url.template'], '/webhooks/:id/:token');
			assertNoSensitiveAttributes(span.attributes as Record<string, unknown>);
			assertNoSensitiveAttributes(recorded[0]);

			cleanup();
		});
	});

	test('checkIfShouldTrace false → no span', async () => {
		await withProvider(async exporter => {
			const { api, getObserver } = fakeRestApi();
			const sources: unknown[] = [];
			const cleanup = instrumentRest(api, {
				checkIfShouldTrace: source => {
					sources.push(source);
					return false;
				},
				getMetrics: () => undefined,
			});

			const observer = getObserver()!;
			await observer.onRequest!(requestPayload({ method: 'GET', url: '/users/@me' }));
			await observer.onSuccess!(
				successPayload({
					method: 'GET',
					url: '/users/@me',
					response: { status: 200 },
				}),
			);

			assert.equal(exporter.getFinishedSpans().length, 0);
			assert.deepEqual(sources, [{ kind: 'rest', method: 'GET', path: '/users/@me' }]);

			cleanup();
		});
	});

	test('no auth keys in attributes', async () => {
		await withProvider(async exporter => {
			const { api, getObserver } = fakeRestApi();
			const cleanup = instrumentRest(api, {
				checkIfShouldTrace: () => true,
				getMetrics: () => undefined,
			});

			const observer = getObserver()!;
			await observer.onRequest!(
				requestPayload({
					method: 'PATCH',
					url: '/users/@me',
					request: Object.freeze({
						auth: true,
						token: 'Bot.leaked',
						body: { username: 'x' },
						// Deliberately hostile keys on the request object
						authorization: 'Bearer leaked',
						Authorization: 'Bearer leaked',
					}),
				}),
			);
			await observer.onSuccess!(
				successPayload({
					method: 'PATCH',
					url: '/users/@me',
					response: { status: 200 },
				}),
			);

			const spans = exporter.getFinishedSpans();
			assert.equal(spans.length, 1);
			assertNoSensitiveAttributes(spans[0].attributes as Record<string, unknown>);
			// Only expected attribute keys
			const keys = Object.keys(spans[0].attributes).sort();
			assert.deepEqual(keys, ['http.request.method', 'http.response.status_code', 'url.path', 'url.template']);

			cleanup();
		});
	});

	test('missing rest.observe → no-op disposer', async () => {
		await withProvider(async exporter => {
			const cleanup = instrumentRest(
				{},
				{
					checkIfShouldTrace: () => true,
					getMetrics: () => undefined,
				},
			);
			assert.equal(typeof cleanup, 'function');
			cleanup();
			assert.equal(exporter.getFinishedSpans().length, 0);
		});
	});

	test('disposer unregisters observer', async () => {
		await withProvider(async exporter => {
			const { api, getObserver, isDisposed } = fakeRestApi();
			const cleanup = instrumentRest(api, {
				checkIfShouldTrace: () => true,
				getMetrics: () => undefined,
			});
			assert.ok(getObserver());
			cleanup();
			assert.equal(isDisposed(), true);
			assert.equal(getObserver(), undefined);
			assert.equal(exporter.getFinishedSpans().length, 0);
		});
	});

	test('records rest metrics when provided', async () => {
		await withProvider(async exporter => {
			const recorded: Array<{ duration: number; attrs: Record<string, unknown> }> = [];
			const { api, getObserver } = fakeRestApi();
			const cleanup = instrumentRest(api, {
				checkIfShouldTrace: () => true,
				getMetrics: () => ({
					recordInteraction() {},
					recordEvent() {},
					recordRest(durationSeconds, attributes) {
						recorded.push({
							duration: durationSeconds,
							attrs: attributes as Record<string, unknown>,
						});
					},
					recordCache() {},
				}),
			});

			const observer = getObserver()!;
			await observer.onRequest!(requestPayload({ method: 'GET', url: '/gateway/bot' }));
			await observer.onSuccess!(
				successPayload({
					method: 'GET',
					url: '/gateway/bot',
					response: { status: 200 },
				}),
			);

			assert.equal(recorded.length, 1);
			assert.ok(recorded[0].duration >= 0);
			assert.equal(recorded[0].attrs['http.request.method'], 'GET');
			assert.equal(recorded[0].attrs['url.template'], '/gateway/bot');
			assert.equal(recorded[0].attrs['http.response.status_code'], 200);
			assert.equal(recorded[0].attrs['seyfert.error'], false);
			assertNoSensitiveAttributes(recorded[0].attrs);
			assert.equal(exporter.getFinishedSpans().length, 1);

			cleanup();
		});
	});

	test('502/503 retries update one logical span instead of orphaning attempts', async () => {
		await withProvider(async exporter => {
			const { api, getObserver } = fakeRestApi();
			const cleanup = instrumentRest(api, {
				checkIfShouldTrace: () => true,
				getMetrics: () => undefined,
			});

			const observer = getObserver()!;
			const url = '/gateway/bot';
			await observer.onRequest!(requestPayload({ method: 'GET', url }));
			await observer.onRequest!(
				requestPayload({ method: 'GET', url, request: Object.freeze({ auth: true, _50xRetries: 1 }) }),
			);
			await observer.onSuccess!(successPayload({ method: 'GET', url, response: { status: 200 } }));

			const spans = exporter.getFinishedSpans();
			assert.equal(spans.length, 1);
			assert.equal(spans[0].attributes['http.request.resend_count'], 1);
			assert.equal(spans[0].attributes['http.response.status_code'], 200);
			cleanup();
			assert.equal(exporter.getFinishedSpans().length, 1);
		});
	});

	test('correlates concurrent same-route requests via FIFO', async () => {
		await withProvider(async exporter => {
			const { api, getObserver } = fakeRestApi();
			const cleanup = instrumentRest(api, {
				checkIfShouldTrace: () => true,
				getMetrics: () => undefined,
			});

			const observer = getObserver()!;
			// Two in-flight GETs to the same path
			await observer.onRequest!(requestPayload({ method: 'GET', url: '/channels/1' }));
			await observer.onRequest!(requestPayload({ method: 'GET', url: '/channels/1' }));
			// Complete second first would be LIFO wrong; FIFO: first success ends first span
			await observer.onSuccess!(
				successPayload({
					method: 'GET',
					url: '/channels/1',
					response: { status: 200 },
				}),
			);
			await observer.onFail!(
				failPayload({
					method: 'GET',
					url: '/channels/1',
					error: new Error('boom'),
					statusCode: 500,
				}),
			);

			const spans = exporter.getFinishedSpans();
			assert.equal(spans.length, 2);
			assert.equal(spans[0].attributes['http.response.status_code'], 200);
			assert.equal(spans[0].status.code, SpanStatusCode.UNSET);
			assert.equal(spans[1].attributes['http.response.status_code'], 500);
			assert.equal(spans[1].status.code, SpanStatusCode.ERROR);

			cleanup();
		});
	});

	test('ratelimit closes the current request span before retry success', async () => {
		await withProvider(async exporter => {
			const { api, getObserver } = fakeRestApi();
			const cleanup = instrumentRest(api, {
				checkIfShouldTrace: () => true,
				getMetrics: () => undefined,
			});

			const observer = getObserver()!;
			await observer.onRequest!(requestPayload({ method: 'POST', url: '/channels/1/messages' }));
			await observer.onRatelimit!(
				ratelimitPayload({
					method: 'POST',
					url: '/channels/1/messages',
					response: { status: 429 },
				}),
			);
			await observer.onRequest!(requestPayload({ method: 'POST', url: '/channels/1/messages' }));
			await observer.onSuccess!(
				successPayload({
					method: 'POST',
					url: '/channels/1/messages',
					response: { status: 200 },
				}),
			);

			const spans = exporter.getFinishedSpans();
			assert.equal(spans.length, 2);
			assert.equal(spans[0].attributes['http.response.status_code'], 429);
			assert.equal(spans[0].attributes['seyfert.rest.ratelimited'], true);
			assert.equal(spans[0].status.code, SpanStatusCode.ERROR);
			assert.equal(spans[1].attributes['http.response.status_code'], 200);

			cleanup();
		});
	});
});
