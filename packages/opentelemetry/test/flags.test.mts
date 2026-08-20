import type { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { assert, describe, test } from 'vitest';
import { opentelemetry } from '../src';
import type { SignalFlags } from '../src/options';
import { installTestTracer } from './helpers/otel-test-provider.mts';

const ALL_OFF: Required<SignalFlags> = {
	interactions: false,
	events: false,
	rest: false,
	cache: false,
};

function withProvider(run: (exporter: InMemorySpanExporter) => Promise<void> | void) {
	const { exporter, shutdown } = installTestTracer();
	return Promise.resolve(run(exporter)).finally(() => shutdown());
}

/** Fake plugin API with rest.observe + interaction defaults. */
function fakeApi() {
	const defaultsCalls: string[] = [];
	let observeCalls = 0;
	let restObserver: object | undefined;

	const api = {
		rest: {
			observe(obs: object) {
				observeCalls += 1;
				restObserver = obs;
				return () => {
					restObserver = undefined;
				};
			},
		},
		commands: {
			defaults() {
				defaultsCalls.push('commands');
			},
		},
		components: {
			defaults() {
				defaultsCalls.push('components');
			},
		},
		modals: {
			defaults() {
				defaultsCalls.push('modals');
			},
		},
	};

	return {
		api,
		defaultsCalls,
		getObserveCalls: () => observeCalls,
		getRestObserver: () => restObserver,
	};
}

/** Fake client with gateway events + cache adapter surfaces. */
function fakeClient() {
	const eventCalls: string[] = [];
	const originalRunEvent = function runEvent(name: string, ..._args: unknown[]) {
		eventCalls.push(name);
		return 'ok';
	};
	const originalGet = function get(key: string) {
		return key === 'user.1' ? { id: '1' } : null;
	};
	const adapter = {
		get: originalGet as (key: string) => unknown,
	};

	const client = {
		events: {
			runEvent: originalRunEvent as (name: string, ...args: unknown[]) => unknown,
		},
		cache: {
			adapter,
		},
	};

	return {
		client,
		eventCalls,
		originalRunEvent,
		originalGet,
		adapter,
	};
}

describe('signal flags', () => {
	test('all signals false: setup does not wrap any surface', async () => {
		await withProvider(async exporter => {
			const { client, originalRunEvent, originalGet, adapter, eventCalls } = fakeClient();
			const { api, defaultsCalls, getObserveCalls } = fakeApi();

			const plugin = opentelemetry({
				serviceName: 'flags-all-off',
				traces: { ...ALL_OFF },
				metrics: { ...ALL_OFF },
			});

			// interactions surfaces
			assert.deepEqual(plugin.options?.({} as never), {});
			plugin.register?.(api as never);
			assert.deepEqual(defaultsCalls, []);

			await plugin.setup?.(client as never, api as never);

			// rest observer never registered
			assert.equal(getObserveCalls(), 0);

			// events.runEvent identity preserved + no spans
			assert.equal(client.events.runEvent, originalRunEvent);
			const eventResult = await client.events.runEvent('messageCreate', client, {}, 0);
			assert.equal(eventResult, 'ok');
			assert.deepEqual(eventCalls, ['messageCreate']);
			assert.equal(exporter.getFinishedSpans().length, 0);

			// cache adapter method identity preserved + no spans
			assert.equal(adapter.get, originalGet);
			assert.deepEqual(adapter.get('user.1'), { id: '1' });
			assert.equal(exporter.getFinishedSpans().length, 0);

			await plugin.teardown?.(client as never);
		});
	});

	test('interactions:false → options has no contextScopes; register skips defaults', () => {
		const { api, defaultsCalls } = fakeApi();
		const plugin = opentelemetry({
			traces: { ...ALL_OFF, interactions: false },
			metrics: { ...ALL_OFF },
		});

		const fragment = plugin.options?.({} as never);
		assert.deepEqual(fragment, {});
		assert.equal(fragment?.contextScopes, undefined);

		plugin.register?.(api as never);
		assert.deepEqual(defaultsCalls, []);
	});

	test('interactions:true only → options installs contextScopes; register calls defaults', () => {
		const { api, defaultsCalls } = fakeApi();
		const plugin = opentelemetry({
			traces: { ...ALL_OFF, interactions: true },
			metrics: { ...ALL_OFF },
		});

		const fragment = plugin.options?.({} as never);
		assert.ok(fragment?.contextScopes);
		assert.equal(fragment?.contextScopes?.length, 1);
		assert.equal(typeof fragment?.contextScopes?.[0], 'function');

		plugin.register?.(api as never);
		assert.deepEqual(defaultsCalls, ['commands', 'components', 'modals']);
	});

	test('events:false → runEvent not wrapped and produces no spans', async () => {
		await withProvider(async exporter => {
			const { client, originalRunEvent, eventCalls } = fakeClient();
			const { api, getObserveCalls } = fakeApi();
			const plugin = opentelemetry({
				serviceName: 'flags-events-off',
				traces: { ...ALL_OFF, events: false },
				metrics: { ...ALL_OFF },
			});

			await plugin.setup?.(client as never, api as never);

			assert.equal(client.events.runEvent, originalRunEvent);
			await client.events.runEvent('messageCreate', client, {}, 0);
			assert.deepEqual(eventCalls, ['messageCreate']);
			assert.equal(exporter.getFinishedSpans().length, 0);
			// rest still off
			assert.equal(getObserveCalls(), 0);

			await plugin.teardown?.(client as never);
		});
	});

	test('events:true → runEvent wrapped and produces event spans', async () => {
		await withProvider(async exporter => {
			const { client, originalRunEvent, eventCalls } = fakeClient();
			const { api, getObserveCalls } = fakeApi();
			const plugin = opentelemetry({
				serviceName: 'flags-events-on',
				traces: { ...ALL_OFF, events: true },
				metrics: { ...ALL_OFF },
			});

			await plugin.setup?.(client as never, api as never);

			assert.notEqual(client.events.runEvent, originalRunEvent);
			await client.events.runEvent('messageCreate', client, {}, 0);
			assert.deepEqual(eventCalls, ['messageCreate']);

			const spans = exporter.getFinishedSpans();
			assert.equal(spans.length, 1);
			assert.equal(spans[0].name, 'event messageCreate');
			// other instruments remain off
			assert.equal(getObserveCalls(), 0);

			await plugin.teardown?.(client as never);
		});
	});

	test('rest:false → api.rest.observe never called', async () => {
		await withProvider(async () => {
			const { client } = fakeClient();
			const { api, getObserveCalls, getRestObserver } = fakeApi();
			const plugin = opentelemetry({
				serviceName: 'flags-rest-off',
				traces: { ...ALL_OFF, rest: false },
				metrics: { ...ALL_OFF },
			});

			await plugin.setup?.(client as never, api as never);

			assert.equal(getObserveCalls(), 0);
			assert.equal(getRestObserver(), undefined);

			await plugin.teardown?.(client as never);
		});
	});

	test('rest:true → api.rest.observe is registered once', async () => {
		await withProvider(async () => {
			const { client } = fakeClient();
			const { api, getObserveCalls, getRestObserver } = fakeApi();
			const plugin = opentelemetry({
				serviceName: 'flags-rest-on',
				traces: { ...ALL_OFF, rest: true },
				metrics: { ...ALL_OFF },
			});

			await plugin.setup?.(client as never, api as never);

			assert.equal(getObserveCalls(), 1);
			assert.ok(getRestObserver());

			await plugin.teardown?.(client as never);
			// disposer from observe cleanup should clear the observer
			assert.equal(getRestObserver(), undefined);
		});
	});

	test('cache:false → adapter methods not wrapped and produce no spans', async () => {
		await withProvider(async exporter => {
			const { client, originalGet, adapter } = fakeClient();
			const { api } = fakeApi();
			const plugin = opentelemetry({
				serviceName: 'flags-cache-off',
				traces: { ...ALL_OFF, cache: false },
				metrics: { ...ALL_OFF },
			});

			await plugin.setup?.(client as never, api as never);

			assert.equal(adapter.get, originalGet);
			assert.deepEqual(adapter.get('user.1'), { id: '1' });
			assert.equal(exporter.getFinishedSpans().length, 0);

			await plugin.teardown?.(client as never);
		});
	});

	test('cache:true → adapter methods wrapped and produce cache spans', async () => {
		await withProvider(async exporter => {
			const { client, originalGet, adapter } = fakeClient();
			const { api, getObserveCalls } = fakeApi();
			const plugin = opentelemetry({
				serviceName: 'flags-cache-on',
				traces: { ...ALL_OFF, cache: true },
				metrics: { ...ALL_OFF },
			});

			await plugin.setup?.(client as never, api as never);

			assert.notEqual(adapter.get, originalGet);
			assert.deepEqual(adapter.get('user.1'), { id: '1' });

			const spans = exporter.getFinishedSpans();
			assert.equal(spans.length, 1);
			assert.equal(spans[0].name, 'cache get user');
			// other instruments remain off
			assert.equal(getObserveCalls(), 0);

			await plugin.teardown?.(client as never);
			// teardown restores original method
			assert.equal(adapter.get, originalGet);
		});
	});

	test('cache metrics can wrap the adapter without producing cache spans', async () => {
		await withProvider(async exporter => {
			const { client, originalGet, adapter } = fakeClient();
			const { api } = fakeApi();
			const plugin = opentelemetry({
				traces: { ...ALL_OFF },
				metrics: { ...ALL_OFF, cache: true },
			});

			await plugin.setup?.(client as never, api as never);
			assert.notEqual(adapter.get, originalGet);
			assert.deepEqual(adapter.get('user.1'), { id: '1' });
			assert.equal(exporter.getFinishedSpans().length, 0);

			await plugin.teardown?.(client as never);
			assert.equal(adapter.get, originalGet);
		});
	});
});
