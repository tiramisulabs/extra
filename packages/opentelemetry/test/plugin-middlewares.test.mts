import { Client, createPlugin, definePlugins } from 'seyfert';
import { assert, describe, test } from 'vitest';
import { createInteractionContextScope } from '../src/context-scope';
import { opentelemetry } from '../src/plugin';
import { getTracer } from '../src/trace-api';
import { installTestTracer } from './helpers/otel-test-provider.mts';

type AnyFn = (...args: never[]) => unknown;
type MiddlewareRecord = Record<string, AnyFn>;

function withProvider(run: (exporter: ReturnType<typeof installTestTracer>['exporter']) => Promise<void> | void) {
	const { exporter, shutdown } = installTestTracer();
	return Promise.resolve(run(exporter)).finally(() => shutdown());
}

/** Plugin middlewares are installed in the constructor, so `client.middlewares` is loose here. */
function middlewares(client: Client): MiddlewareRecord {
	return (client.middlewares ?? {}) as unknown as MiddlewareRecord;
}

/**
 * Real client, no network: `start()` only hits the REST API to build a
 * ShardManager, and skips that when one is already set.
 */
function createTestClient(plugins: unknown): Client {
	// SeyfertRegistry is augmented elsewhere in the suite, so the option types are pinned.
	const client = new Client({
		plugins,
		getRC: () => ({ token: 'x', intents: 0, debug: false, locations: { base: '.' } }),
	} as never);
	(client as unknown as { gateway: unknown }).gateway = { spawnShards: async () => undefined };
	return client;
}

function otelPlugin() {
	return opentelemetry({
		serviceName: 'plugin-middlewares',
		traces: { interactions: true, events: false, rest: false, cache: false },
		metrics: { interactions: false, events: false, rest: false, cache: false, gateway: false, memory: false },
	});
}

/** Minimal plugin that contributes a middleware the way `@slipher/cooldown` does. */
function middlewarePlugin(name: string, middleware: AnyFn) {
	return createPlugin({
		name: `test-${name}`,
		register(api) {
			(api.middlewares.add as (n: string, m: AnyFn) => void)(name, middleware);
		},
	});
}

type CommandDefaults = {
	onBeforeMiddlewares?: (context: object) => unknown;
	onAfterRun?: (context: object, error?: unknown) => unknown;
};

/** The hooks the plugin contributes through `api.commands.defaults`, as Seyfert merged them. */
function commandDefaults(client: Client): CommandDefaults {
	const defaults = client.options.commands?.defaults as CommandDefaults | undefined;
	assert.ok(defaults?.onBeforeMiddlewares, 'plugin command defaults are installed');
	return defaults;
}

/** The plugin's context scope, which opens the root and `Middlewares` spans. */
function scopeFor() {
	return createInteractionContextScope({
		traceEnabled: true,
		checkIfShouldTrace: () => true,
		getMetrics: () => undefined,
	}) as unknown as <T>(context: object, run: () => T) => T;
}

describe('plugin-contributed middlewares', () => {
	test('start() does not throw and leaves the plugin function in place', async () => {
		await withProvider(async () => {
			const contributed: AnyFn = (async ({ next }: { next: () => void }) => {
				next();
			}) as unknown as AnyFn;
			const otel = otelPlugin();
			const client = createTestClient(definePlugins(middlewarePlugin('cooldown', contributed), otel));

			// Reproduction from the issue: this threw PLUGIN_FAILED /
			// `Middleware "cooldown" is already registered.` when the wrapper
			// replaced the plugin's function.
			await client.start({}, false);

			assert.equal(middlewares(client).cooldown, contributed);
			await otel.teardown?.(client as never, {} as never);
		});
	});

	test('reinstalling plugin middlewares again does not throw', async () => {
		await withProvider(async () => {
			const contributed: AnyFn = (async ({ next }: { next: () => void }) => {
				next();
			}) as unknown as AnyFn;
			const otel = otelPlugin();
			const client = createTestClient(definePlugins(middlewarePlugin('cooldown', contributed), otel));
			await client.start({}, false);

			const refresh = (client as unknown as { refreshPluginContributions: () => void }).refreshPluginContributions;
			assert.equal(typeof refresh, 'function');
			refresh.call(client);
			refresh.call(client);

			assert.equal(middlewares(client).cooldown, contributed);
			await otel.teardown?.(client as never, {} as never);
		});
	});

	test('a setServices middleware still gets its own span', async () => {
		await withProvider(async exporter => {
			let nextCalls = 0;
			const usage: AnyFn = (async ({ next }: { next: () => void }) => {
				getTracer().startSpan('middleware dependency').end();
				next();
			}) as unknown as AnyFn;
			const contributed: AnyFn = (async ({ next }: { next: () => void }) => {
				next();
			}) as unknown as AnyFn;

			const otel = otelPlugin();
			const client = createTestClient(definePlugins(middlewarePlugin('cooldown', contributed), otel));
			client.setServices({ middlewares: { usage } as never });
			await client.start({}, false);

			// Only the bot's own middleware is wrapped.
			assert.notEqual(middlewares(client).usage, usage);
			assert.equal(middlewares(client).cooldown, contributed);

			const hooks = commandDefaults(client);
			const scope = scopeFor();

			const context = { fullCommandName: 'referral stats' };
			await scope(context, async () => {
				hooks.onBeforeMiddlewares?.(context);
				await (middlewares(client).usage as (middle: object) => Promise<void>)({
					context,
					next() {
						nextCalls += 1;
					},
				});
				await (middlewares(client).cooldown as (middle: object) => Promise<void>)({
					context,
					next() {
						nextCalls += 1;
					},
				});
				hooks.onAfterRun?.(context, undefined);
			});

			assert.equal(nextCalls, 2);
			const names = exporter.getFinishedSpans().map(span => span.name);
			assert.ok(names.includes('middleware usage'), `missing bot middleware span, got ${names.join(',')}`);
			assert.ok(names.includes('middleware dependency'), `missing nested span, got ${names.join(',')}`);
			assert.ok(!names.includes('middleware cooldown'), 'plugin middlewares stay untraced');
			await otel.teardown?.(client as never, {} as never);
		});
	});

	test('spans a plugin middleware creates attach to the interaction root', async () => {
		await withProvider(async exporter => {
			const contributed: AnyFn = (async ({ next }: { next: () => void }) => {
				getTracer().startSpan('plugin work').end();
				next();
			}) as unknown as AnyFn;

			const otel = otelPlugin();
			const client = createTestClient(definePlugins(middlewarePlugin('cooldown', contributed), otel));
			await client.start({}, false);

			const hooks = commandDefaults(client);
			const context = { fullCommandName: 'ping' };
			await scopeFor()(context, async () => {
				hooks.onBeforeMiddlewares?.(context);
				await (middlewares(client).cooldown as (middle: object) => Promise<void>)({
					context,
					next() {
						// nothing to chain
					},
				});
				hooks.onAfterRun?.(context, undefined);
			});

			const spans = exporter.getFinishedSpans();
			const root = spans.find(span => span.name === 'command ping');
			const phase = spans.find(span => span.name === 'Middlewares');
			const work = spans.find(span => span.name === 'plugin work');
			assert.ok(root);
			assert.ok(phase, 'the phase span still covers the chain');
			assert.ok(work);
			// Only a wrapper makes the phase span the active parent, and plugin
			// middlewares are not wrapped, so their spans hang off the root.
			assert.equal(work.parentSpanContext?.spanId, root.spanContext().spanId);
			assert.notEqual(work.parentSpanContext?.spanId, phase.spanContext().spanId);
			await otel.teardown?.(client as never, {} as never);
		});
	});

	test('a second setup does not wrap the same middleware twice', async () => {
		await withProvider(async exporter => {
			const usage: AnyFn = (async ({ next }: { next: () => void }) => {
				next();
			}) as unknown as AnyFn;

			const otel = otelPlugin();
			const client = createTestClient(definePlugins(otel));
			client.setServices({ middlewares: { usage } as never });
			await client.start({}, false);

			// Restart / hot reload path: setup runs again on the same client. It unwraps
			// first, so the entry holds one wrapper around the bot's function, never two.
			await otel.setup?.(client as never, {} as never);
			assert.notEqual(middlewares(client).usage, usage);

			const hooks = commandDefaults(client);
			const context = { fullCommandName: 'ping' };
			await scopeFor()(context, async () => {
				hooks.onBeforeMiddlewares?.(context);
				await (middlewares(client).usage as (middle: object) => Promise<void>)({
					context,
					next() {
						// nothing to chain
					},
				});
				hooks.onAfterRun?.(context, undefined);
			});

			const spans = exporter.getFinishedSpans().filter(span => span.name === 'middleware usage');
			assert.equal(spans.length, 1, 'one span per middleware call');
			await otel.teardown?.(client as never, {} as never);
			assert.equal(middlewares(client).usage, usage);
		});
	});

	test('teardown restores the live middleware registry', async () => {
		await withProvider(async () => {
			const usage: AnyFn = (async ({ next }: { next: () => void }) => {
				next();
			}) as unknown as AnyFn;
			const contributed: AnyFn = (async ({ next }: { next: () => void }) => {
				next();
			}) as unknown as AnyFn;

			const otel = otelPlugin();
			const client = createTestClient(definePlugins(middlewarePlugin('cooldown', contributed), otel));
			client.setServices({ middlewares: { usage } as never });
			await client.start({}, false);

			// Seyfert replaced client.middlewares during start; teardown must unwrap that object.
			assert.notEqual(middlewares(client).usage, usage);
			await otel.teardown?.(client as never, {} as never);

			assert.equal(middlewares(client).usage, usage);
			assert.equal(middlewares(client).cooldown, contributed);
			assert.deepEqual(Object.keys(middlewares(client)).sort(), ['cooldown', 'usage']);
		});
	});
});
