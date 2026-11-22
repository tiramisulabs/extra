import { createContextKey, context as otelContext } from '@opentelemetry/api';
import { Client, Command, createPlugin, definePlugins } from 'seyfert';
import { assert, describe, test, vi } from 'vitest';
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
	onBeforeOptions?: (context: object) => unknown;
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

function supportsMiddlewareWrappers(): boolean {
	let supported = false;
	const probe = createPlugin({
		name: 'test-middleware-wrapper-api',
		register(api) {
			const middlewares = api.middlewares as { wrap?: unknown };
			supported = typeof middlewares.wrap === 'function';
		},
	});
	createTestClient(definePlugins(probe));
	return supported;
}

const hasMiddlewareWrappers = supportsMiddlewareWrappers();

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

	test.skipIf(hasMiddlewareWrappers)('legacy setServices middleware gets its own span', async () => {
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

	test.each([
		{ chain: ['cooldown', 'usage'], parent: 'command ping' },
		{ chain: ['usage', 'cooldown'], parent: 'Middlewares' },
	])('traces plugin work in middleware chain $chain', async ({ chain, parent }) => {
		await withProvider(async exporter => {
			const contributed = ({ next }: { next: () => void }) => {
				getTracer().startSpan('plugin work').end();
				next();
			};
			const usage = ({ next }: { next: () => void }) => next();

			const otel = otelPlugin();
			const client = createTestClient(definePlugins(middlewarePlugin('cooldown', contributed), otel));
			client.setServices({ middlewares: { usage } as never });
			await client.start({}, false);
			await client.reloadPluginContributions();

			const hooks = commandDefaults(client);
			const command = new Command();
			command.middlewares = chain as never;
			const context = { client, fullCommandName: 'ping' };
			const run = () =>
				scopeFor()(context, async () => {
					hooks.onBeforeMiddlewares?.(context);
					assert.deepEqual(await client.handleCommand.runMiddlewares(command, context as never), {});
					hooks.onAfterRun?.(context, undefined);
				});
			try {
				await run();
				const spans = exporter.getFinishedSpans();
				const phase = spans.find(span => span.name === 'Middlewares');
				const usageSpan = spans.find(span => span.name === 'middleware usage');
				const pluginSpan = spans.find(span => span.name === 'middleware cooldown');
				const work = spans.find(span => span.name === 'plugin work');
				assert.ok(phase);
				assert.ok(usageSpan);
				assert.ok(work);
				assert.equal(usageSpan.parentSpanContext?.spanId, phase.spanContext().spanId);
				if (hasMiddlewareWrappers) {
					assert.ok(pluginSpan);
					assert.equal(pluginSpan.parentSpanContext?.spanId, phase.spanContext().spanId);
					assert.equal(work.parentSpanContext?.spanId, pluginSpan.spanContext().spanId);
					assert.equal(middlewares(client).usage, usage);
				} else {
					assert.isUndefined(pluginSpan);
					const parentSpan = spans.find(span => span.name === parent);
					assert.ok(parentSpan);
					assert.equal(work.parentSpanContext?.spanId, parentSpan.spanContext().spanId);
				}
				assert.equal(middlewares(client).cooldown, contributed);
			} finally {
				await client.close();
			}
			exporter.reset();
			await run();
			assert.isFalse(exporter.getFinishedSpans().some(span => span.name.startsWith('middleware ')));
		});
	});

	test('the wrapper API opens the phase with custom hooks and preserves context through next()', async () => {
		await withProvider(async exporter => {
			type Invocation = { name: string; context: object; next: () => void };
			type Wrapper = (invocation: Invocation, run: (invocation: Invocation) => void) => void;

			const otel = otelPlugin();
			const client = createTestClient(definePlugins(otel));
			const detach = vi.fn();
			const wrap = vi.fn((_wrapper: Wrapper) => detach);
			await otel.setup?.(client as never, { middlewares: { wrap } } as never);
			try {
				const wrapper = wrap.mock.calls[0]?.[0];
				assert.ok(wrapper);
				const key = createContextKey('middleware context');
				const context = { fullCommandName: 'ping' };
				const hooks = commandDefaults(client);
				await scopeFor()(context, () => {
					hooks.onBeforeOptions?.(context);
					wrapper(
						{
							name: 'usage',
							context,
							next: () => {
								assert.equal(otelContext.active().getValue(key), 'from middleware');
							},
						},
						({ next }) => otelContext.with(otelContext.active().setValue(key, 'from middleware'), next),
					);
					hooks.onAfterRun?.(context, undefined);
				});
				const spans = exporter.getFinishedSpans();
				const root = spans.find(span => span.name === 'command ping');
				const phase = spans.find(span => span.name === 'Middlewares');
				const usage = spans.find(span => span.name === 'middleware usage');
				assert.ok(root);
				assert.ok(phase);
				assert.ok(usage);
				assert.equal(phase.parentSpanContext?.spanId, root.spanContext().spanId);
				assert.equal(usage.parentSpanContext?.spanId, phase.spanContext().spanId);
			} finally {
				await otel.teardown?.(client as never, {} as never);
			}
			assert.equal(detach.mock.calls.length, 1);
		});
	});

	test.skipIf(hasMiddlewareWrappers)('a second setup does not wrap the same legacy middleware twice', async () => {
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

	test.skipIf(hasMiddlewareWrappers)('teardown restores the legacy middleware registry', async () => {
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
