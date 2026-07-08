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
}

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

	test('fail with 4xx → status attribute without ERROR', async () => {
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
			assert.equal(spans[0].status.code, SpanStatusCode.UNSET);

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
			assert.deepEqual(keys, ['http.request.method', 'http.response.status_code', 'url.path']);

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
			assert.equal(recorded[0].attrs['url.path'], '/gateway/bot');
			assert.equal(recorded[0].attrs['http.response.status_code'], 200);
			assert.equal(recorded[0].attrs['seyfert.error'], false);
			assertNoSensitiveAttributes(recorded[0].attrs);
			assert.equal(exporter.getFinishedSpans().length, 1);

			cleanup();
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
			assert.equal(spans[1].attributes['http.response.status_code'], 200);

			cleanup();
		});
	});
});
