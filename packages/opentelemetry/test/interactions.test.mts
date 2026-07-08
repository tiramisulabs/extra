import { SpanStatusCode } from '@opentelemetry/api';
import type { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { assert, describe, test } from 'vitest';
import { createInteractionContextScope } from '../src/context-scope';
import { registerInteractionInstrumentation } from '../src/instrument/interactions';
import { opentelemetry } from '../src/plugin';
import { setTraceServiceName } from '../src/trace-api';
import { installTestTracer } from './helpers/otel-test-provider.mts';

function withProvider(run: (exporter: InMemorySpanExporter) => Promise<void> | void) {
	const { exporter, shutdown } = installTestTracer();
	setTraceServiceName('interactions-test');
	return Promise.resolve(run(exporter)).finally(() => shutdown());
}

describe('interaction context scope (root spans)', () => {
	test('creates root span named command ping', async () => {
		await withProvider(async exporter => {
			const scope = createInteractionContextScope({
				serviceName: 'interactions-test',
				checkIfShouldTrace: () => true,
				getMetrics: () => undefined,
			});
			const result = scope({ fullCommandName: 'ping' }, () => 'ok');
			assert.equal(result, 'ok');
			const spans = exporter.getFinishedSpans();
			assert.equal(spans.length, 1);
			assert.equal(spans[0].name, 'command ping');
			assert.equal(spans[0].status.code, SpanStatusCode.UNSET);
		});
	});

	test('error path sets SpanStatusCode.ERROR', async () => {
		await withProvider(async exporter => {
			const scope = createInteractionContextScope({
				serviceName: 'interactions-test',
				checkIfShouldTrace: () => true,
				getMetrics: () => undefined,
			});
			assert.throws(
				() =>
					scope({ fullCommandName: 'fail' }, () => {
						throw new Error('boom');
					}),
				/boom/,
			);
			const spans = exporter.getFinishedSpans();
			assert.equal(spans.length, 1);
			assert.equal(spans[0].name, 'command fail');
			assert.equal(spans[0].status.code, SpanStatusCode.ERROR);
			assert.ok(spans[0].events.some(e => e.name === 'exception'));
		});
	});

	test('async rejection sets ERROR status', async () => {
		await withProvider(async exporter => {
			const scope = createInteractionContextScope({
				serviceName: 'interactions-test',
				checkIfShouldTrace: () => true,
				getMetrics: () => undefined,
			});
			let thrown: unknown;
			try {
				await scope({ fullCommandName: 'async-fail' }, async () => {
					throw new Error('async boom');
				});
			} catch (error) {
				thrown = error;
			}
			assert.ok(thrown instanceof Error);
			assert.match((thrown as Error).message, /async boom/);
			const spans = exporter.getFinishedSpans();
			assert.equal(spans.length, 1);
			assert.equal(spans[0].status.code, SpanStatusCode.ERROR);
		});
	});

	test('checkIfShouldTrace false → zero spans', async () => {
		await withProvider(async exporter => {
			const scope = createInteractionContextScope({
				serviceName: 'interactions-test',
				checkIfShouldTrace: () => false,
				getMetrics: () => undefined,
			});
			const result = scope({ fullCommandName: 'ping' }, () => 'ok');
			assert.equal(result, 'ok');
			assert.equal(exporter.getFinishedSpans().length, 0);
		});
	});

	test('checkIfShouldTrace throw → fail open (still traces)', async () => {
		await withProvider(async exporter => {
			const scope = createInteractionContextScope({
				serviceName: 'interactions-test',
				checkIfShouldTrace: () => {
					throw new Error('filter boom');
				},
				getMetrics: () => undefined,
			});
			const result = scope({ fullCommandName: 'ping' }, () => 'ok');
			assert.equal(result, 'ok');
			assert.equal(exporter.getFinishedSpans().length, 1);
			assert.equal(exporter.getFinishedSpans()[0].name, 'command ping');
		});
	});

	test('user result still returns when metrics throw on finish', async () => {
		await withProvider(async exporter => {
			const scope = createInteractionContextScope({
				serviceName: 'interactions-test',
				checkIfShouldTrace: () => true,
				getMetrics: () => ({
					recordInteraction() {
						throw new Error('metrics boom');
					},
					recordEvent() {},
					recordRest() {},
					recordCache() {},
				}),
			});
			const result = scope({ fullCommandName: 'ping' }, () => 'still-ok');
			assert.equal(result, 'still-ok');
			const spans = exporter.getFinishedSpans();
			assert.equal(spans.length, 1);
			assert.equal(spans[0].name, 'command ping');
		});
	});

	test('detectKind uses isModal / isComponent markers', async () => {
		await withProvider(async exporter => {
			const scope = createInteractionContextScope({
				serviceName: 'interactions-test',
				checkIfShouldTrace: () => true,
				getMetrics: () => undefined,
			});
			scope(
				{
					customId: 'btn-1',
					isComponent() {
						return true;
					},
					isModal() {
						return false;
					},
				},
				() => undefined,
			);
			scope(
				{
					customId: 'modal-1',
					isModal() {
						return true;
					},
					isComponent() {
						return false;
					},
				},
				() => undefined,
			);
			const names = exporter.getFinishedSpans().map(s => s.name);
			assert.deepEqual(names, ['component btn-1', 'modal modal-1']);
		});
	});
});

describe('registerInteractionInstrumentation', () => {
	test('installs defaults on commands, components, and modals', () => {
		const calls: Array<{ target: string; hooks: Record<string, unknown> }> = [];
		const api = {
			commands: {
				defaults(hooks: object) {
					calls.push({ target: 'commands', hooks: hooks as Record<string, unknown> });
				},
			},
			components: {
				defaults(hooks: object) {
					calls.push({ target: 'components', hooks: hooks as Record<string, unknown> });
				},
			},
			modals: {
				defaults(hooks: object) {
					calls.push({ target: 'modals', hooks: hooks as Record<string, unknown> });
				},
			},
		};

		registerInteractionInstrumentation(api, { checkIfShouldTrace: () => true });

		assert.equal(calls.length, 3);
		assert.equal(calls[0].target, 'commands');
		assert.equal(calls[1].target, 'components');
		assert.equal(calls[2].target, 'modals');

		const commandKeys = Object.keys(calls[0].hooks);
		for (const key of [
			'onBeforeOptions',
			'onBeforeMiddlewares',
			'onAfterRun',
			'onRunError',
			'onMiddlewaresError',
			'onOptionsError',
		]) {
			assert.ok(commandKeys.includes(key), `commands defaults missing ${key}`);
			assert.equal(typeof calls[0].hooks[key], 'function');
		}

		for (const entry of [calls[1], calls[2]]) {
			for (const key of ['onBeforeMiddlewares', 'onAfterRun', 'onRunError', 'onMiddlewaresError']) {
				assert.ok(Object.keys(entry.hooks).includes(key), `${entry.target} missing ${key}`);
				assert.equal(typeof entry.hooks[key], 'function');
			}
		}
	});

	test('plugin register() installs defaults when interactions are on', () => {
		const calls: string[] = [];
		const api = {
			commands: {
				defaults() {
					calls.push('commands');
				},
			},
			components: {
				defaults() {
					calls.push('components');
				},
			},
			modals: {
				defaults() {
					calls.push('modals');
				},
			},
		};

		const plugin = opentelemetry({
			instrument: { interactions: true, events: false, rest: false, cache: false },
		});
		plugin.register?.(api as never);
		assert.deepEqual(calls, ['commands', 'components', 'modals']);
	});

	test('plugin register() skips defaults when interactions are off', () => {
		let called = false;
		const api = {
			commands: {
				defaults() {
					called = true;
				},
			},
			components: {
				defaults() {
					called = true;
				},
			},
			modals: {
				defaults() {
					called = true;
				},
			},
		};

		const plugin = opentelemetry({
			instrument: { interactions: false, events: false, rest: false, cache: false },
		});
		plugin.register?.(api as never);
		assert.equal(called, false);
	});

	test('lifecycle hooks create Middlewares / Options / Run children under root', async () => {
		await withProvider(async exporter => {
			const hooks: Record<string, (...args: never[]) => void> = {};
			const api = {
				commands: {
					defaults(h: object) {
						Object.assign(hooks, h);
					},
				},
				components: { defaults() {} },
				modals: { defaults() {} },
				handlers: {
					transform(
						transformer: (instance: { run?: (ctx: object) => unknown }, metadata: { kind: string }) => unknown,
					) {
						const instance = {
							run(ctx: object) {
								return `ran:${(ctx as { fullCommandName?: string }).fullCommandName}`;
							},
						};
						transformer(instance, { kind: 'command' });
						hooks.__run = instance.run as (...args: never[]) => void;
					},
				},
			};

			registerInteractionInstrumentation(api, { checkIfShouldTrace: () => true });

			const scope = createInteractionContextScope({
				serviceName: 'interactions-test',
				checkIfShouldTrace: () => true,
				getMetrics: () => undefined,
			});

			const ctx = { fullCommandName: 'ping' };
			const result = scope(ctx, () => {
				hooks.onBeforeOptions?.(ctx as never);
				hooks.onBeforeMiddlewares?.(ctx as never);
				const out = hooks.__run?.(ctx as never);
				hooks.onAfterRun?.(ctx as never, undefined as never);
				return out;
			});

			assert.equal(result, 'ran:ping');
			const spans = exporter.getFinishedSpans();
			const names = spans.map(s => s.name);
			assert.ok(names.includes('command ping'), `missing root, got ${names.join(',')}`);
			assert.ok(names.includes('Options'), `missing Options, got ${names.join(',')}`);
			assert.ok(names.includes('Middlewares'), `missing Middlewares, got ${names.join(',')}`);
			assert.ok(names.includes('Run'), `missing Run, got ${names.join(',')}`);

			const root = spans.find(s => s.name === 'command ping');
			assert.ok(root);
			for (const childName of ['Options', 'Middlewares', 'Run']) {
				const child = spans.find(s => s.name === childName);
				assert.ok(child, childName);
				assert.equal(child.parentSpanContext?.spanId, root.spanContext().spanId);
			}
		});
	});

	test('hooks never throw even when tracer/check fails', () => {
		const hooks: Record<string, (...args: never[]) => void> = {};
		registerInteractionInstrumentation(
			{
				commands: {
					defaults(h: object) {
						Object.assign(hooks, h);
					},
				},
				components: { defaults() {} },
				modals: { defaults() {} },
			},
			{
				checkIfShouldTrace: () => {
					throw new Error('filter boom');
				},
			},
		);

		const ctx = { fullCommandName: 'x' };
		// shouldTrace swallows filter errors and defaults to true; hooks still must not throw
		hooks.onBeforeMiddlewares?.(ctx as never);
		hooks.onAfterRun?.(ctx as never, undefined as never);
		hooks.onRunError?.(ctx as never, new Error('run') as never);
	});
});
