import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { assert, describe, test } from 'vitest';
import { type CacheClient, extractCacheResource, instrumentCache } from '../src/instrument/cache';
import { setTraceServiceName } from '../src/trace-api';
import { installTestTracer } from './helpers/otel-test-provider.mts';

function withProvider(run: (exporter: InMemorySpanExporter) => Promise<void> | void) {
	const { exporter, shutdown } = installTestTracer();
	setTraceServiceName('cache-test');
	return Promise.resolve(run(exporter)).finally(() => shutdown());
}

/** Minimal in-memory adapter surface matching seyfert `Adapter` data methods. */
function fakeAdapter(store = new Map<string, unknown>()) {
	const adapter: Record<string, unknown> = {
		start() {},
		scan(query: string) {
			const prefix = query.replace(/\*$/, '');
			return [...store.entries()].filter(([key]) => key.startsWith(prefix)).map(([, value]) => value);
		},
		get(key: string) {
			if (!store.has(key)) return null;
			return store.get(key);
		},
		set(key: string, data: unknown) {
			store.set(key, data);
		},
		remove(key: string) {
			store.delete(key);
		},
		patch(key: string, data: unknown) {
			const prev = store.get(key);
			store.set(
				key,
				typeof data === 'object' && data !== null && typeof prev === 'object' && prev !== null
					? { ...(prev as object), ...(data as object) }
					: data,
			);
		},
		bulkGet(keys: string[]) {
			return keys.map(k => store.get(k)).filter(v => v !== undefined);
		},
		bulkSet(entries: [string, unknown][]) {
			for (const [k, v] of entries) store.set(k, v);
		},
		bulkRemove(keys: string[]) {
			for (const k of keys) store.delete(k);
		},
		bulkPatch(entries: [string, unknown][]) {
			for (const [k, v] of entries) {
				(adapter.patch as (key: string, data: unknown) => void)(k, v);
			}
		},
		getToRelationship(to: string) {
			return store.has(`rel:${to}`) ? (store.get(`rel:${to}`) as string[]) : [];
		},
		values(to: string) {
			return [...store.entries()].filter(([key]) => key.startsWith(`${to}.`)).map(([, value]) => value);
		},
		keys(to: string) {
			return [...store.keys()].filter(key => key.startsWith(`${to}.`));
		},
		count(to: string) {
			return [...store.keys()].filter(key => key.startsWith(`${to}.`)).length;
		},
		flush() {
			store.clear();
		},
		contains(to: string, key: string) {
			return store.has(`${to}.${key}`);
		},
		bulkAddToRelationShip(_data: Record<string, string[]>) {},
		addToRelationship(_to: string, _keys: string | string[]) {},
		removeToRelationship(_to: string, _keys: string | string[]) {},
		removeRelationship(_to: string | string[]) {},
	};
	return { adapter, store };
}

function fakeClient(adapter: Record<string, unknown>): CacheClient {
	return { cache: { adapter } };
}

describe('extractCacheResource', () => {
	test('uses first segment of dotted keys', () => {
		assert.equal(extractCacheResource(['user.123']), 'user');
		assert.equal(extractCacheResource(['presence.guild.user']), 'presence');
		assert.equal(extractCacheResource(['voice_state.1.2']), 'voice_state');
	});

	test('handles bulk key lists and tuples', () => {
		assert.equal(extractCacheResource([['user.1', 'user.2']]), 'user');
		assert.equal(extractCacheResource([[['channel.9', { id: '9' }]]]), 'channel');
	});

	test('falls back to unknown', () => {
		assert.equal(extractCacheResource([]), 'unknown');
		assert.equal(extractCacheResource([42]), 'unknown');
	});
});

describe('instrumentCache (adapter wraps)', () => {
	test('wraps the complete Seyfert Adapter data surface and restores exact identities', async () => {
		await withProvider(async () => {
			const methods = [
				'scan',
				'bulkGet',
				'get',
				'bulkSet',
				'set',
				'bulkPatch',
				'patch',
				'values',
				'keys',
				'count',
				'bulkRemove',
				'remove',
				'flush',
				'contains',
				'getToRelationship',
				'bulkAddToRelationShip',
				'addToRelationship',
				'removeToRelationship',
				'removeRelationship',
			] as const;
			const { adapter } = fakeAdapter();
			const originals = new Map(methods.map(method => [method, adapter[method]]));
			const originalStart = adapter.start;
			const cleanup = instrumentCache(fakeClient(adapter), {
				checkIfShouldTrace: () => true,
				skipResources: new Set(),
				getMetrics: () => undefined,
			});

			for (const method of methods) {
				assert.notEqual(adapter[method], originals.get(method), `${method} was not instrumented`);
			}
			assert.equal(adapter.start, originalStart, 'adapter lifecycle start must not be instrumented');

			cleanup();
			for (const method of methods) {
				assert.equal(adapter[method], originals.get(method), `${method} identity was not restored`);
			}
		});
	});

	test('get hit sets seyfert.cache.hit true', async () => {
		await withProvider(async exporter => {
			const { adapter, store } = fakeAdapter();
			store.set('user.1', { id: '1', username: 'a' });
			const client = fakeClient(adapter);
			const cleanup = instrumentCache(client, {
				checkIfShouldTrace: () => true,
				skipResources: new Set(),
				getMetrics: () => undefined,
			});

			const value = (adapter.get as (k: string) => unknown)('user.1');
			assert.deepEqual(value, { id: '1', username: 'a' });

			const spans = exporter.getFinishedSpans();
			assert.equal(spans.length, 1);
			assert.equal(spans[0].name, 'cache get user');
			assert.equal(spans[0].kind, SpanKind.INTERNAL);
			assert.equal(spans[0].attributes['seyfert.cache.op'], 'get');
			assert.equal(spans[0].attributes['seyfert.cache.resource'], 'user');
			assert.equal(spans[0].attributes['seyfert.cache.hit'], true);
			assert.equal(spans[0].status.code, SpanStatusCode.UNSET);

			cleanup();
		});
	});

	test('get miss sets seyfert.cache.hit false', async () => {
		await withProvider(async exporter => {
			const { adapter } = fakeAdapter();
			const client = fakeClient(adapter);
			const cleanup = instrumentCache(client, {
				checkIfShouldTrace: () => true,
				skipResources: new Set(),
				getMetrics: () => undefined,
			});

			const value = (adapter.get as (k: string) => unknown)('user.missing');
			assert.equal(value, null);

			const spans = exporter.getFinishedSpans();
			assert.equal(spans.length, 1);
			assert.equal(spans[0].name, 'cache get user');
			assert.equal(spans[0].attributes['seyfert.cache.hit'], false);

			cleanup();
		});
	});

	test('skipResources → no span', async () => {
		await withProvider(async exporter => {
			const { adapter, store } = fakeAdapter();
			store.set('presence.1', { status: 'online' });
			const client = fakeClient(adapter);
			const cleanup = instrumentCache(client, {
				checkIfShouldTrace: () => true,
				skipResources: new Set(['presence', 'voice_state']),
				getMetrics: () => undefined,
			});

			const value = (adapter.get as (k: string) => unknown)('presence.1');
			assert.deepEqual(value, { status: 'online' });
			assert.equal(exporter.getFinishedSpans().length, 0);

			// voice_state also skipped
			(adapter.get as (k: string) => unknown)('voice_state.guild.user');
			assert.equal(exporter.getFinishedSpans().length, 0);

			// Non-skipped resource still traces
			(adapter.set as (k: string, v: unknown) => void)('user.2', { id: '2' });
			assert.equal(exporter.getFinishedSpans().length, 1);
			assert.equal(exporter.getFinishedSpans()[0].name, 'cache set user');

			cleanup();
		});
	});

	test('cleanup restores original methods', async () => {
		await withProvider(async exporter => {
			const { adapter } = fakeAdapter();
			const originalGet = adapter.get;
			const client = fakeClient(adapter);
			const cleanup = instrumentCache(client, {
				checkIfShouldTrace: () => true,
				skipResources: new Set(),
				getMetrics: () => undefined,
			});

			assert.notEqual(adapter.get, originalGet);
			(adapter.get as (k: string) => unknown)('user.1');
			assert.equal(exporter.getFinishedSpans().length, 1);

			cleanup();
			assert.equal(adapter.get, originalGet);

			(adapter.get as (k: string) => unknown)('user.1');
			assert.equal(exporter.getFinishedSpans().length, 1);
		});
	});

	test('errors → ERROR status and rethrow', async () => {
		await withProvider(async exporter => {
			const { adapter } = fakeAdapter();
			adapter.get = () => {
				throw new Error('adapter boom');
			};
			const client = fakeClient(adapter);
			const cleanup = instrumentCache(client, {
				checkIfShouldTrace: () => true,
				skipResources: new Set(),
				getMetrics: () => undefined,
			});

			assert.throws(() => (adapter.get as (k: string) => unknown)('user.1'), /adapter boom/);

			const spans = exporter.getFinishedSpans();
			assert.equal(spans.length, 1);
			assert.equal(spans[0].status.code, SpanStatusCode.ERROR);
			assert.ok(spans[0].events.some(e => e.name === 'exception'));

			cleanup();
		});
	});

	test('async adapter rejection → ERROR status and rethrow', async () => {
		await withProvider(async exporter => {
			const { adapter } = fakeAdapter();
			adapter.get = async () => {
				throw new Error('async boom');
			};
			const client = fakeClient(adapter);
			const cleanup = instrumentCache(client, {
				checkIfShouldTrace: () => true,
				skipResources: new Set(),
				getMetrics: () => undefined,
			});

			let thrown: unknown;
			try {
				await (adapter.get as (k: string) => Promise<unknown>)('channel.1');
			} catch (error) {
				thrown = error;
			}
			assert.ok(thrown instanceof Error);
			assert.match((thrown as Error).message, /async boom/);

			const spans = exporter.getFinishedSpans();
			assert.equal(spans.length, 1);
			assert.equal(spans[0].name, 'cache get channel');
			assert.equal(spans[0].status.code, SpanStatusCode.ERROR);

			cleanup();
		});
	});

	test('checkIfShouldTrace false → no span', async () => {
		await withProvider(async exporter => {
			const { adapter } = fakeAdapter();
			const sources: unknown[] = [];
			const client = fakeClient(adapter);
			const cleanup = instrumentCache(client, {
				checkIfShouldTrace: source => {
					sources.push(source);
					return false;
				},
				skipResources: new Set(),
				getMetrics: () => undefined,
			});

			(adapter.set as (k: string, v: unknown) => void)('guild.1', { id: '1' });
			assert.equal(exporter.getFinishedSpans().length, 0);
			assert.deepEqual(sources, [{ kind: 'cache', op: 'set', resource: 'guild' }]);

			cleanup();
		});
	});

	test('missing cache.adapter → no-op disposer', async () => {
		await withProvider(async exporter => {
			const cleanup = instrumentCache(
				{},
				{
					checkIfShouldTrace: () => true,
					skipResources: new Set(),
					getMetrics: () => undefined,
				},
			);
			assert.equal(typeof cleanup, 'function');
			cleanup();
			assert.equal(exporter.getFinishedSpans().length, 0);
		});
	});

	test('records cache metrics when provided', async () => {
		await withProvider(async exporter => {
			const recorded: Array<{ duration: number; attrs: Record<string, unknown> }> = [];
			const { adapter, store } = fakeAdapter();
			store.set('role.1', { id: '1' });
			const client = fakeClient(adapter);
			const cleanup = instrumentCache(client, {
				checkIfShouldTrace: () => true,
				skipResources: new Set(),
				getMetrics: () => ({
					recordInteraction() {},
					recordEvent() {},
					recordRest() {},
					recordCache(durationSeconds, attributes) {
						recorded.push({
							duration: durationSeconds,
							attrs: attributes as Record<string, unknown>,
						});
					},
				}),
			});

			(adapter.get as (k: string) => unknown)('role.1');

			assert.equal(recorded.length, 1);
			assert.ok(recorded[0].duration >= 0);
			assert.equal(recorded[0].attrs['seyfert.cache.op'], 'get');
			assert.equal(recorded[0].attrs['seyfert.cache.resource'], 'role');
			assert.equal(recorded[0].attrs['seyfert.cache.hit'], true);
			assert.equal(recorded[0].attrs['seyfert.error'], false);
			assert.equal(exporter.getFinishedSpans().length, 1);

			cleanup();
		});
	});

	test('bulkGet wraps with INTERNAL span', async () => {
		await withProvider(async exporter => {
			const { adapter, store } = fakeAdapter();
			store.set('emoji.1', { id: '1' });
			const client = fakeClient(adapter);
			const cleanup = instrumentCache(client, {
				checkIfShouldTrace: () => true,
				skipResources: new Set(),
				getMetrics: () => undefined,
			});

			const values = (adapter.bulkGet as (keys: string[]) => unknown[])(['emoji.1']);
			assert.deepEqual(values, [{ id: '1' }]);

			const spans = exporter.getFinishedSpans();
			assert.equal(spans.length, 1);
			assert.equal(spans[0].name, 'cache bulkGet emoji');
			assert.equal(spans[0].kind, SpanKind.INTERNAL);
			assert.equal(spans[0].attributes['seyfert.cache.op'], 'bulkGet');
			// hit only applies to singular get
			assert.equal(spans[0].attributes['seyfert.cache.hit'], undefined);

			cleanup();
		});
	});
});
