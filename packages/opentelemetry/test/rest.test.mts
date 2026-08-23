import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { SeyfertError } from 'seyfert';
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
import { installTestTracer } from './helpers/otel-test-provider.mts';

function withProvider(run: (exporter: InMemorySpanExporter) => Promise<void> | void) {
	const { exporter, shutdown } = installTestTracer();
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
			template: '/webhooks/{webhook_id}/{token}',
		});
		assert.deepEqual(sanitizeRestTarget('/interactions/456/interaction-secret/callback'), {
			path: '/interactions/456/REDACTED/callback',
			template: '/interactions/{interaction_id}/{token}/callback',
		});
		assert.deepEqual(sanitizeRestTarget('/channels/123/messages/456'), {
			path: '/channels/123/messages/456',
			template: '/channels/{channel_id}/messages/{message_id}',
		});
		assert.equal(sanitizeRestTarget('/invites/user-controlled-code').template, '/invites/{code}');
		assert.equal(
			sanitizeRestTarget('/channels/123/messages/456/reactions/name%3A789/@me').template,
			'/channels/{channel_id}/messages/{message_id}/reactions/{emoji}/@me',
		);
	});

	test('names distinct route parameters distinctly', () => {
		assert.equal(
			sanitizeRestTarget('/guilds/1297522927922712608/members/1418688009540206773').template,
			'/guilds/{guild_id}/members/{user_id}',
		);
		assert.equal(
			sanitizeRestTarget('/channels/1/messages/2/reactions/%F0%9F%91%8D/3').template,
			'/channels/{channel_id}/messages/{message_id}/reactions/{emoji}/{user_id}',
		);
	});

	test('falls back to a generic parameter for unmapped segments', () => {
		assert.equal(sanitizeRestTarget('/lobbies/123').template, '/lobbies/{id}');
	});
});

describe('instrumentRest (api.rest.observe)', () => {
	test('success → current HTTP CLIENT semantic conventions', async () => {
		await withProvider(async exporter => {
			const { api, getObserver } = fakeRestApi();
			const cleanup = instrumentRest(
				{ client: undefined, api },
				{
					traceEnabled: true,
					checkIfShouldTrace: () => true,
					getMetrics: () => undefined,
				},
			);

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
			assert.equal(spans[0].name, 'GET /users/@me');
			assert.equal(spans[0].kind, SpanKind.CLIENT);
			assert.equal(spans[0].attributes['http.request.method'], 'GET');
			assert.equal(spans[0].attributes['server.address'], 'discord.com');
			assert.equal(spans[0].attributes['server.port'], 443);
			assert.equal(spans[0].attributes['url.full'], 'https://discord.com/api/v10/users/@me');
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
			const cleanup = instrumentRest(
				{ client: undefined, api },
				{
					traceEnabled: true,
					checkIfShouldTrace: () => true,
					getMetrics: () => undefined,
				},
			);

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
			assert.equal(spans[0].name, 'POST /channels/{channel_id}/messages');
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
			const cleanup = instrumentRest(
				{ client: undefined, api },
				{
					traceEnabled: true,
					checkIfShouldTrace: () => true,
					getMetrics: () => undefined,
				},
			);

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

	test('Discord 4xx failure records its safe error details', async () => {
		await withProvider(async exporter => {
			const { api, getObserver } = fakeRestApi();
			const cleanup = instrumentRest(
				{ client: undefined, api },
				{
					traceEnabled: true,
					checkIfShouldTrace: () => true,
					getMetrics: () => undefined,
				},
			);

			const observer = getObserver()!;
			await observer.onRequest!(requestPayload({ method: 'GET', url: '/users/0' }));
			await observer.onFail!(
				failPayload({
					method: 'GET',
					url: '/users/0',
					error: new SeyfertError('API_Not Found_10013', {
						metadata: {
							response: {
								code: 10013,
								message: 'Unknown User',
								token: 'SUPER_SECRET_WEBHOOK_TOKEN',
							},
						},
					}),
					statusCode: 404,
				}),
			);

			const spans = exporter.getFinishedSpans();
			assert.equal(spans.length, 1);
			const span = spans[0];
			const exception = span.events.find(event => event.name === 'exception');
			assert.equal(span.attributes['http.response.status_code'], 404);
			assert.equal(span.attributes['error.type'], '404');
			assert.equal(span.attributes['discord.error.code'], 10013);
			assert.equal(span.status.code, SpanStatusCode.ERROR);
			assert.equal(span.status.message, 'Unknown User');
			// The original error is recorded, so OTel reports Seyfert's structured code.
			// Discord's own message stays on the span status.
			assert.equal(exception?.attributes?.['exception.type'], 'API_Not Found_10013');
			assert.ok(exception?.attributes?.['exception.stacktrace']);
			assert.ok(!JSON.stringify(span.events).includes('SUPER_SECRET_WEBHOOK_TOKEN'));

			cleanup();
		});
	});

	test('redacts webhook tokens before filtering, tracing, and metrics', async () => {
		await withProvider(async exporter => {
			const sources: unknown[] = [];
			const recorded: Record<string, unknown>[] = [];
			const { api, getObserver } = fakeRestApi();
			const cleanup = instrumentRest(
				{ client: undefined, api },
				{
					traceEnabled: true,
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
				},
			);

			const url = '/webhooks/123/SUPER_SECRET_WEBHOOK_TOKEN?wait=true';
			const observer = getObserver()!;
			await observer.onRequest!(requestPayload({ method: 'POST', url }));
			await observer.onSuccess!(successPayload({ method: 'POST', url, response: { status: 204 } }));

			assert.deepEqual(sources, [{ kind: 'rest', method: 'POST', path: '/webhooks/123/REDACTED' }]);
			const span = exporter.getFinishedSpans()[0];
			assert.equal(span.attributes['url.path'], '/webhooks/123/REDACTED');
			assert.equal(span.attributes['url.template'], '/webhooks/{webhook_id}/{token}');
			assert.equal(recorded[0]['url.template'], '/webhooks/{webhook_id}/{token}');
			assertNoSensitiveAttributes(span.attributes as Record<string, unknown>);
			assertNoSensitiveAttributes(recorded[0]);

			cleanup();
		});
	});

	test('checkIfShouldTrace false → no span', async () => {
		await withProvider(async exporter => {
			const { api, getObserver } = fakeRestApi();
			const sources: unknown[] = [];
			const cleanup = instrumentRest(
				{ client: undefined, api },
				{
					traceEnabled: true,
					checkIfShouldTrace: source => {
						sources.push(source);
						return false;
					},
					getMetrics: () => undefined,
				},
			);

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
			const cleanup = instrumentRest(
				{ client: undefined, api },
				{
					traceEnabled: true,
					checkIfShouldTrace: () => true,
					getMetrics: () => undefined,
				},
			);

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
			assert.deepEqual(keys, [
				'http.request.method',
				'http.response.status_code',
				'server.address',
				'server.port',
				'url.full',
				'url.path',
				'url.template',
			]);

			cleanup();
		});
	});

	test('unknown HTTP method uses _OTHER and preserves the original method', async () => {
		await withProvider(async exporter => {
			const { api, getObserver } = fakeRestApi();
			const cleanup = instrumentRest(
				{ client: undefined, api },
				{
					traceEnabled: true,
					checkIfShouldTrace: () => true,
					getMetrics: () => undefined,
				},
			);

			const observer = getObserver()!;
			await observer.onRequest!(requestPayload({ method: 'CUSTOM', url: '/gateway/bot' }));
			await observer.onSuccess!(successPayload({ method: 'CUSTOM', url: '/gateway/bot', response: { status: 200 } }));

			const span = exporter.getFinishedSpans()[0];
			assert.equal(span.name, 'HTTP /gateway/bot');
			assert.equal(span.attributes['http.request.method'], '_OTHER');
			assert.equal(span.attributes['http.request.method_original'], 'CUSTOM');
			cleanup();
		});
	});

	test('canonicalizes known HTTP methods and preserves non-canonical casing', async () => {
		await withProvider(async exporter => {
			const { api, getObserver } = fakeRestApi();
			const cleanup = instrumentRest(
				{ client: undefined, api },
				{
					traceEnabled: true,
					checkIfShouldTrace: () => true,
					getMetrics: () => undefined,
				},
			);

			const observer = getObserver()!;
			await observer.onRequest!(requestPayload({ method: 'get', url: '/gateway/bot' }));
			await observer.onSuccess!(successPayload({ method: 'get', url: '/gateway/bot', response: { status: 200 } }));

			const span = exporter.getFinishedSpans()[0];
			assert.equal(span.name, 'GET /gateway/bot');
			assert.equal(span.attributes['http.request.method'], 'GET');
			assert.equal(span.attributes['http.request.method_original'], 'get');
			cleanup();
		});
	});

	test('missing rest.observe → no-op disposer', async () => {
		await withProvider(async exporter => {
			const cleanup = instrumentRest(
				{ client: undefined, api: {} },
				{
					traceEnabled: true,
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
			const cleanup = instrumentRest(
				{ client: undefined, api },
				{
					traceEnabled: true,
					checkIfShouldTrace: () => true,
					getMetrics: () => undefined,
				},
			);
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
			const cleanup = instrumentRest(
				{ client: undefined, api },
				{
					traceEnabled: true,
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
				},
			);

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

	test('records REST metrics without creating a span when tracing is disabled', async () => {
		await withProvider(async exporter => {
			const recorded: Record<string, unknown>[] = [];
			const { api, getObserver } = fakeRestApi();
			const cleanup = instrumentRest(
				{ client: undefined, api },
				{
					traceEnabled: false,
					checkIfShouldTrace: () => true,
					getMetrics: () => ({
						recordInteraction() {},
						recordEvent() {},
						recordRest(_durationSeconds, attributes) {
							recorded.push(attributes as Record<string, unknown>);
						},
						recordCache() {},
					}),
				},
			);

			const observer = getObserver()!;
			await observer.onRequest!(requestPayload({ method: 'GET', url: '/gateway/bot' }));
			await observer.onSuccess!(successPayload({ method: 'GET', url: '/gateway/bot', response: { status: 200 } }));

			assert.equal(recorded.length, 1);
			assert.equal(recorded[0]['url.template'], '/gateway/bot');
			assert.equal(exporter.getFinishedSpans().length, 0);
			cleanup();
		});
	});

	test('502/503 retries update one logical span instead of orphaning attempts', async () => {
		await withProvider(async exporter => {
			const { api, getObserver } = fakeRestApi();
			const cleanup = instrumentRest(
				{ client: undefined, api },
				{
					traceEnabled: true,
					checkIfShouldTrace: () => true,
					getMetrics: () => undefined,
				},
			);

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
			const cleanup = instrumentRest(
				{ client: undefined, api },
				{
					traceEnabled: true,
					checkIfShouldTrace: () => true,
					getMetrics: () => undefined,
				},
			);

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
			const cleanup = instrumentRest(
				{ client: undefined, api },
				{
					traceEnabled: true,
					checkIfShouldTrace: () => true,
					getMetrics: () => undefined,
				},
			);

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

	test('peer attributes follow the configured api domain instead of a hardcoded Discord host', async () => {
		await withProvider(async exporter => {
			const { api, getObserver } = fakeRestApi();
			const client = { rest: { options: { domain: 'https://proxy.internal:8080', baseUrl: 'api/v10' } } };
			const cleanup = instrumentRest(
				{ client, api },
				{
					traceEnabled: true,
					checkIfShouldTrace: () => true,
					getMetrics: () => undefined,
				},
			);

			const observer = getObserver()!;
			await observer.onRequest!(requestPayload({ method: 'GET', url: '/users/@me' }));
			await observer.onSuccess!(successPayload({ method: 'GET', url: '/users/@me', response: { status: 200 } }));

			const span = exporter.getFinishedSpans()[0];
			assert.equal(span.attributes['server.address'], 'proxy.internal');
			assert.equal(span.attributes['server.port'], 8080);
			assert.equal(span.attributes['url.full'], 'https://proxy.internal:8080/api/v10/users/@me');

			cleanup();
		});
	});

	test('omits peer attributes when the api domain cannot be parsed', async () => {
		await withProvider(async exporter => {
			const { api, getObserver } = fakeRestApi();
			const cleanup = instrumentRest(
				{ client: { rest: { options: { domain: 'not a url' } } }, api },
				{
					traceEnabled: true,
					checkIfShouldTrace: () => true,
					getMetrics: () => undefined,
				},
			);

			const observer = getObserver()!;
			await observer.onRequest!(requestPayload({ method: 'GET', url: '/users/@me' }));
			await observer.onSuccess!(successPayload({ method: 'GET', url: '/users/@me', response: { status: 200 } }));

			const span = exporter.getFinishedSpans()[0];
			assert.equal(span.attributes['server.address'], undefined);
			assert.equal(span.attributes['url.full'], undefined);
			assert.equal(span.attributes['url.path'], '/users/@me');

			cleanup();
		});
	});

	test('records the ratelimit bucket on success and scope plus retry-after only when ratelimited', async () => {
		await withProvider(async exporter => {
			const { api, getObserver } = fakeRestApi();
			const cleanup = instrumentRest(
				{ client: undefined, api },
				{
					traceEnabled: true,
					checkIfShouldTrace: () => true,
					getMetrics: () => undefined,
				},
			);
			const headers = (values: Record<string, string>) => ({ get: (name: string) => values[name] ?? null });

			const observer = getObserver()!;
			await observer.onRequest!(requestPayload({ method: 'GET', url: '/users/@me' }));
			await observer.onSuccess!(
				successPayload({
					method: 'GET',
					url: '/users/@me',
					response: { status: 200, headers: headers({ 'x-ratelimit-bucket': 'abcd1234' }) },
				}),
			);

			await observer.onRequest!(requestPayload({ method: 'POST', url: '/channels/1/messages' }));
			await observer.onRatelimit!(
				ratelimitPayload({
					method: 'POST',
					url: '/channels/1/messages',
					response: {
						status: 429,
						headers: headers({
							'x-ratelimit-bucket': 'efgh5678',
							'x-ratelimit-scope': 'shared',
							'retry-after': '1.5',
						}),
					},
				}),
			);

			const [success, limited] = exporter.getFinishedSpans();
			assert.equal(success.attributes['discord.ratelimit.bucket'], 'abcd1234');
			assert.equal(success.attributes['discord.ratelimit.scope'], undefined);
			assert.equal(success.attributes['http.response.header.retry-after'], undefined);

			assert.equal(limited.attributes['discord.ratelimit.bucket'], 'efgh5678');
			assert.equal(limited.attributes['discord.ratelimit.scope'], 'shared');
			assert.deepEqual(limited.attributes['http.response.header.retry-after'], ['1.5']);

			cleanup();
		});
	});

	test('missing response headers never break the span', async () => {
		await withProvider(async exporter => {
			const { api, getObserver } = fakeRestApi();
			const cleanup = instrumentRest(
				{ client: undefined, api },
				{
					traceEnabled: true,
					checkIfShouldTrace: () => true,
					getMetrics: () => undefined,
				},
			);

			const observer = getObserver()!;
			await observer.onRequest!(requestPayload({ method: 'GET', url: '/users/@me' }));
			await observer.onSuccess!(successPayload({ method: 'GET', url: '/users/@me', response: { status: 200 } }));

			const span = exporter.getFinishedSpans()[0];
			assert.equal(span.attributes['discord.ratelimit.bucket'], undefined);
			assert.equal(span.status.code, SpanStatusCode.UNSET);

			cleanup();
		});
	});
});
