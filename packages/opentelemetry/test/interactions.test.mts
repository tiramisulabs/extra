import { SpanStatusCode } from '@opentelemetry/api';
import type { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { assert, describe, test } from 'vitest';
import { createInteractionContextScope } from '../src/context-scope';
import { registerInteractionInstrumentation } from '../src/instrument/interactions';
import { opentelemetry } from '../src/plugin';
import { getTracer } from '../src/trace-api';
import { installTestTracer } from './helpers/otel-test-provider.mts';

function withProvider(run: (exporter: InMemorySpanExporter) => Promise<void> | void) {
	const { exporter, shutdown } = installTestTracer();
	return Promise.resolve(run(exporter)).finally(() => shutdown());
}

type ScopeDeps = Parameters<typeof createInteractionContextScope>[0];

/**
 * The plugin duck-types the interaction context and ignores the handler's return value.
 * Tests build partial contexts on purpose, so the fake shape is asserted here once
 * instead of casting at every call site.
 */
function testScope(deps: ScopeDeps) {
	return createInteractionContextScope(deps) as unknown as <T>(context: object, run: () => T) => T;
}

describe('interaction context scope (root spans)', () => {
	test('creates root span named command ping', async () => {
		await withProvider(async exporter => {
			const scope = testScope({
				traceEnabled: true,
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
			const scope = testScope({
				traceEnabled: true,
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
			const scope = testScope({
				traceEnabled: true,
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
			const scope = testScope({
				traceEnabled: true,
				checkIfShouldTrace: () => false,
				getMetrics: () => undefined,
			});
			const result = scope({ fullCommandName: 'ping' }, () => 'ok');
			assert.equal(result, 'ok');
			assert.equal(exporter.getFinishedSpans().length, 0);
		});
	});

	test('records interaction metrics without creating a span when tracing is disabled', async () => {
		await withProvider(async exporter => {
			const recorded: Record<string, unknown>[] = [];
			const scope = testScope({
				traceEnabled: false,
				checkIfShouldTrace: () => true,
				getMetrics: () => ({
					recordInteraction(_durationSeconds, attributes) {
						recorded.push(attributes as Record<string, unknown>);
					},
					recordEvent() {},
					recordRest() {},
					recordCache() {},
				}),
			});

			assert.equal(
				scope({ fullCommandName: 'ping' }, () => 'ok'),
				'ok',
			);
			assert.equal(recorded.length, 1);
			assert.equal(recorded[0]['seyfert.command'], 'ping');
			assert.equal(exporter.getFinishedSpans().length, 0);
		});
	});

	test('checkIfShouldTrace throw → fail open (still traces)', async () => {
		await withProvider(async exporter => {
			const scope = testScope({
				traceEnabled: true,
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
			const scope = testScope({
				traceEnabled: true,
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

	test('interaction metrics exclude high-cardinality IDs while spans retain diagnostics', async () => {
		await withProvider(async exporter => {
			const recorded: Record<string, unknown>[] = [];
			const scope = testScope({
				traceEnabled: true,
				checkIfShouldTrace: () => true,
				getMetrics: () => ({
					recordInteraction(_duration, attributes) {
						recorded.push(attributes as Record<string, unknown>);
					},
					recordEvent() {},
					recordRest() {},
					recordCache() {},
				}),
			});

			scope(
				{
					customId: 'user-specific:123',
					isComponent: () => true,
					guildId: 'guild-1',
					channelId: 'channel-1',
					author: { id: 'user-1' },
					interaction: { id: 'interaction-1' },
					shardId: 2,
				},
				() => undefined,
			);

			assert.deepEqual(recorded, [
				{
					'seyfert.interaction.kind': 'component',
					'seyfert.shard_id': 2,
					'seyfert.error': false,
				},
			]);
			assert.equal(exporter.getFinishedSpans()[0].attributes['seyfert.custom_id'], 'user-specific:123');
			assert.equal(exporter.getFinishedSpans()[0].attributes['seyfert.user_id'], 'user-1');
		});
	});

	test('detectKind uses isModal / isComponent markers', async () => {
		await withProvider(async exporter => {
			const scope = testScope({
				traceEnabled: true,
				checkIfShouldTrace: () => true,
				getMetrics: () => undefined,
			});
			scope(
				{
					customId: 'btn-1',
					command: { customId: 'btn-1' },
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
					command: { customId: 'modal-1' },
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

describe('collector flows', () => {
	test('a collector click continues the command trace after the command span ends', async () => {
		await withProvider(async exporter => {
			const values = new Map<string, { callback?: (interaction: object) => unknown }>();
			const components = {
				values,
				modals: new Map<string, (interaction: object) => unknown>(),
				createComponentCollector(messageId: string) {
					const row: { callback?: (interaction: object) => unknown } = {};
					values.set(messageId, row);
					return {
						run(_customId: string, callback: (interaction: object) => unknown) {
							row.callback = callback;
						},
					};
				},
				async onComponent(messageId: string, interaction: object) {
					try {
						return await values.get(messageId)?.callback?.(interaction);
					} catch {
						// Seyfert reports collector errors and does not rethrow them.
						return undefined;
					}
				},
				onModalSubmit(interaction: object) {
					const userId = (interaction as { user: { id: string } }).user.id;
					const callback = this.modals.get(userId);
					this.modals.delete(userId);
					return callback?.(interaction);
				},
			};
			const plugin = opentelemetry({
				traces: { interactions: true, events: false, rest: false, cache: false },
				metrics: { interactions: false, events: false, rest: false, cache: false },
			});
			const scope = plugin.options?.({} as never)?.contextScopes?.[0] as unknown as (
				context: object,
				run: () => unknown,
			) => unknown;
			await plugin.setup?.({ components } as never, {} as never);

			scope({ fullCommandName: 'setup' }, () => {
				getTracer().startActiveSpan('Run', runSpan => {
					components.createComponentCollector('message-1').run('continue', () => {
						getTracer().startSpan('collector work').end();
					});
					components.createComponentCollector('message-error').run('fail', () => {
						throw new Error('collector failed');
					});
					runSpan.end();
				});
			});
			await components.onComponent('message-1', {
				type: 3,
				customId: 'continue',
				id: 'interaction-2',
				user: { id: 'user-1' },
			});
			await components.onComponent('message-error', {
				type: 3,
				customId: 'fail',
				id: 'interaction-3',
				user: { id: 'user-1' },
			});
			await plugin.teardown?.({} as never);

			const spans = exporter.getFinishedSpans();
			const command = spans.find(span => span.name === 'command setup');
			const run = spans.find(span => span.name === 'Run');
			const click = spans.find(span => span.name === 'component collector continue');
			const work = spans.find(span => span.name === 'collector work');
			const failed = spans.find(span => span.name === 'component collector fail');
			assert.ok(command);
			assert.ok(run);
			assert.ok(click);
			assert.ok(work);
			assert.ok(failed);
			assert.equal(click.spanContext().traceId, command.spanContext().traceId);
			assert.equal(click.parentSpanContext?.spanId, run.spanContext().spanId);
			assert.equal(click.attributes['seyfert.flow_id'], command.attributes['seyfert.flow_id']);
			assert.equal(click.attributes['seyfert.collector.result'], 'completed');
			assert.equal(typeof click.attributes['seyfert.collector.wait_duration_ms'], 'number');
			assert.ok(click.events.some(event => event.name === 'seyfert.button.clicked'));
			const registered = run.events.find(event => event.name === 'seyfert.collector.registered');
			assert.equal(registered?.attributes?.['seyfert.collector.type'], 'component');
			assert.equal(registered?.attributes?.['seyfert.collector.matcher'], 'continue');
			assert.equal(work.parentSpanContext?.spanId, click.spanContext().spanId);
			assert.equal(failed.attributes['seyfert.collector.result'], 'error');
			assert.equal(failed.status.code, SpanStatusCode.ERROR);
		});
	});

	test('a modal submit continues the trace that recorded the modal opening', async () => {
		await withProvider(async exporter => {
			let restObserver: { onSuccess?: (payload: object) => unknown } | undefined;
			const values = new Map<string, { callback?: (interaction: object) => unknown }>();
			const components = {
				values,
				modals: new Map<string, (interaction: object) => unknown>(),
				createComponentCollector(messageId: string) {
					const row: { callback?: (interaction: object) => unknown } = {};
					values.set(messageId, row);
					return {
						run(_customId: string, callback: (interaction: object) => unknown) {
							row.callback = callback;
						},
					};
				},
				onComponent(messageId: string, interaction: object) {
					return values.get(messageId)?.callback?.(interaction);
				},
				onModalSubmit(interaction: object) {
					const userId = (interaction as { user: { id: string } }).user.id;
					const callback = this.modals.get(userId);
					this.modals.delete(userId);
					return callback?.(interaction);
				},
			};
			const plugin = opentelemetry({
				traces: { interactions: true, events: false, rest: false, cache: false },
				metrics: { interactions: false, events: false, rest: false, cache: false },
			});
			const scope = plugin.options?.({} as never)?.contextScopes?.[0] as unknown as (
				context: object,
				run: () => unknown,
			) => unknown;
			await plugin.setup?.(
				{ components } as never,
				{
					rest: {
						observe(observer: { onSuccess?: (payload: object) => unknown }) {
							restObserver = observer;
							return () => {
								restObserver = undefined;
							};
						},
					},
				} as never,
			);

			scope({ fullCommandName: 'setup' }, () => {
				getTracer().startActiveSpan('Run', runSpan => {
					components.modals.set('user-1', () => {
						getTracer().startSpan('submit work').end();
						components.createComponentCollector('message-2').run('continue', () => {
							getTracer().startSpan('button work').end();
						});
						restObserver?.onSuccess?.({
							method: 'POST',
							url: '/interactions/2/token/callback',
							request: {
								body: {
									type: 4,
									data: {
										components: [{ type: 1, components: [{ type: 2, custom_id: 'continue' }] }],
									},
								},
							},
							response: { status: 204 },
						});
					});
					restObserver?.onSuccess?.({
						method: 'POST',
						url: '/interactions/1/token/callback',
						request: {
							body: {
								type: 9,
								data: { custom_id: 'setup-modal', title: 'Setup', components: [] },
							},
						},
						response: { status: 204 },
					});
					runSpan.end();
				});
			});
			await components.onModalSubmit({
				type: 5,
				customId: 'setup-modal',
				id: 'interaction-2',
				user: { id: 'user-1' },
			});
			await components.onComponent('message-2', {
				type: 3,
				customId: 'continue',
				id: 'interaction-3',
				user: { id: 'user-1' },
			});
			await plugin.teardown?.({} as never);

			const spans = exporter.getFinishedSpans();
			const command = spans.find(span => span.name === 'command setup');
			const run = spans.find(span => span.name === 'Run');
			const submit = spans.find(span => span.name === 'modal collector setup-modal');
			const work = spans.find(span => span.name === 'submit work');
			const click = spans.find(span => span.name === 'component collector continue');
			const buttonWork = spans.find(span => span.name === 'button work');
			assert.ok(command);
			assert.ok(run);
			assert.ok(submit);
			assert.ok(work);
			assert.ok(click);
			assert.ok(buttonWork);
			assert.ok(run.events.some(event => event.name === 'seyfert.modal.opened'));
			assert.ok(
				run.events.some(
					event =>
						event.name === 'seyfert.collector.registered' && event.attributes?.['seyfert.collector.type'] === 'modal',
				),
			);
			assert.ok(submit.events.some(event => event.name === 'seyfert.modal.submitted'));
			assert.ok(submit.events.some(event => event.name === 'seyfert.button.presented'));
			assert.equal(submit.attributes['seyfert.collector.result'], 'completed');
			assert.equal(typeof submit.attributes['seyfert.collector.wait_duration_ms'], 'number');
			assert.equal(submit.attributes['seyfert.interaction.response_type'], 'reply');
			assert.equal(typeof submit.attributes['seyfert.interaction.ack_latency_ms'], 'number');
			assert.ok(submit.events.some(event => event.name === 'seyfert.interaction.acknowledged'));
			assert.equal(submit.spanContext().traceId, command.spanContext().traceId);
			assert.equal(submit.parentSpanContext?.spanId, run.spanContext().spanId);
			assert.equal(submit.attributes['seyfert.flow_id'], command.attributes['seyfert.flow_id']);
			assert.equal(work.parentSpanContext?.spanId, submit.spanContext().spanId);
			assert.equal(click.spanContext().traceId, command.spanContext().traceId);
			assert.equal(click.parentSpanContext?.spanId, submit.spanContext().spanId);
			assert.equal(click.attributes['seyfert.flow_id'], command.attributes['seyfert.flow_id']);
			assert.equal(buttonWork.parentSpanContext?.spanId, click.spanContext().spanId);
		});
	});

	test('records collector timeout and manual stop without a long-lived span', async () => {
		await withProvider(async exporter => {
			type StopOptions = { timeout?: number; onStop?: (reason: string, restart: () => void) => unknown };
			const values = new Map<string, object>();
			const components = {
				values,
				modals: new Map<string, (interaction: object) => unknown>(),
				createComponentCollector(messageId: string, _channelId?: string, _guildId?: string, options: StopOptions = {}) {
					values.set(messageId, {});
					return {
						run() {},
						stop(reason: string) {
							return options.onStop?.(reason, () => undefined);
						},
					};
				},
				onComponent() {},
				onModalSubmit() {},
			};
			const plugin = opentelemetry({
				traces: { interactions: true, events: false, rest: false, cache: false },
				metrics: { interactions: false, events: false, rest: false, cache: false },
			});
			const scope = plugin.options?.({} as never)?.contextScopes?.[0] as unknown as (
				context: object,
				run: () => unknown,
			) => unknown;
			await plugin.setup?.({ components } as never, {} as never);

			let timeoutCollector: { stop(reason: string): unknown } | undefined;
			let stoppedCollector: { stop(reason: string): unknown } | undefined;
			scope({ fullCommandName: 'setup' }, () => {
				getTracer().startActiveSpan('Run', runSpan => {
					timeoutCollector = components.createComponentCollector('timeout', undefined, undefined, {
						timeout: 60_000,
					});
					stoppedCollector = components.createComponentCollector('stopped');
					runSpan.end();
				});
			});
			timeoutCollector?.stop('timeout');
			stoppedCollector?.stop('cancelled');
			await plugin.teardown?.({} as never);

			const run = exporter.getFinishedSpans().find(span => span.name === 'Run');
			const timeout = exporter.getFinishedSpans().find(span => span.name === 'component collector timeout');
			const stopped = exporter.getFinishedSpans().find(span => span.name === 'component collector stopped');
			assert.ok(run);
			assert.ok(timeout);
			assert.ok(stopped);
			assert.equal(timeout.parentSpanContext?.spanId, run.spanContext().spanId);
			assert.equal(timeout.attributes['seyfert.collector.result'], 'timeout');
			assert.equal(timeout.attributes['seyfert.collector.timeout_ms'], 60_000);
			assert.equal(stopped.attributes['seyfert.collector.result'], 'stopped');
			assert.equal(stopped.attributes['seyfert.collector.stop_reason'], 'cancelled');
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
			'onInternalError',
		]) {
			assert.ok(commandKeys.includes(key), `commands defaults missing ${key}`);
			assert.equal(typeof calls[0].hooks[key], 'function');
		}

		for (const entry of [calls[1], calls[2]]) {
			for (const key of ['onBeforeMiddlewares', 'onAfterRun', 'onRunError', 'onMiddlewaresError', 'onInternalError']) {
				assert.ok(Object.keys(entry.hooks).includes(key), `${entry.target} missing ${key}`);
				assert.equal(typeof entry.hooks[key], 'function');
			}
		}
	});

	test('root scope closes a lifecycle child when middleware exits early', async () => {
		await withProvider(async exporter => {
			const hooks: Record<string, (...args: never[]) => unknown> = {};
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
				{ checkIfShouldTrace: () => true },
			);
			const scope = testScope({
				traceEnabled: true,
				checkIfShouldTrace: () => true,
				getMetrics: () => undefined,
			});
			const ctx = { fullCommandName: 'early-exit' };

			const result = scope(ctx, () => {
				hooks.onBeforeMiddlewares?.(ctx as never);
				return 'passed';
			});

			assert.equal(result, 'passed');
			assert.deepEqual(
				exporter
					.getFinishedSpans()
					.map(span => span.name)
					.sort(),
				['Middlewares', 'command early-exit'],
			);
		});
	});

	test('middleware denial names the middleware and its scope on the root span', async () => {
		await withProvider(async exporter => {
			const hooks: Record<string, (...args: never[]) => unknown> = {};
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
				{ checkIfShouldTrace: () => true },
			);
			const scope = testScope({
				traceEnabled: true,
				checkIfShouldTrace: () => true,
				getMetrics: () => undefined,
			});
			const ctx = { fullCommandName: 'ban' };

			scope(ctx, () => {
				hooks.onBeforeMiddlewares?.(ctx as never);
				hooks.onMiddlewaresError?.(
					ctx as never,
					'missing permissions' as never,
					{ middleware: 'requirePermissions', scope: 'command' } as never,
				);
			});

			const root = exporter.getFinishedSpans().find(span => span.name === 'command ban');
			assert.ok(root);
			assert.equal(root.attributes['seyfert.failure.phase'], 'middlewares');
			assert.equal(root.attributes['seyfert.middleware.name'], 'requirePermissions');
			assert.equal(root.attributes['seyfert.middleware.scope'], 'command');
		});
	});

	test('missing or malformed denial metadata still records the phase', async () => {
		await withProvider(async exporter => {
			const hooks: Record<string, (...args: never[]) => unknown> = {};
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
				{ checkIfShouldTrace: () => true },
			);
			const scope = testScope({
				traceEnabled: true,
				checkIfShouldTrace: () => true,
				getMetrics: () => undefined,
			});
			const ctx = { fullCommandName: 'ban' };

			scope(ctx, () => {
				hooks.onBeforeMiddlewares?.(ctx as never);
				hooks.onMiddlewaresError?.(ctx as never, 'denied' as never, undefined as never);
			});

			const root = exporter.getFinishedSpans().find(span => span.name === 'command ban');
			assert.ok(root);
			assert.equal(root.attributes['seyfert.failure.phase'], 'middlewares');
			assert.equal(root.attributes['seyfert.middleware.name'], undefined);
		});
	});

	test('run errors record the phase and a low-cardinality error type', async () => {
		await withProvider(async exporter => {
			const hooks: Record<string, (...args: never[]) => unknown> = {};
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
				{ checkIfShouldTrace: () => true },
			);
			const scope = testScope({
				traceEnabled: true,
				checkIfShouldTrace: () => true,
				getMetrics: () => undefined,
			});
			const ctx = { fullCommandName: 'ban' };

			scope(ctx, () => {
				hooks.onRunError?.(ctx as never, new TypeError('boom') as never);
			});

			const root = exporter.getFinishedSpans().find(span => span.name === 'command ban');
			assert.ok(root);
			assert.equal(root.attributes['seyfert.failure.phase'], 'run');
			assert.equal(root.attributes['error.type'], 'TypeError');
		});
	});

	test('failure phase reaches the duration histogram, middleware name does not', async () => {
		await withProvider(async () => {
			const hooks: Record<string, (...args: never[]) => unknown> = {};
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
				{ checkIfShouldTrace: () => true },
			);
			const recorded: Record<string, unknown>[] = [];
			const scope = testScope({
				traceEnabled: true,
				checkIfShouldTrace: () => true,
				getMetrics: () => ({
					recordInteraction(_duration, attributes) {
						recorded.push(attributes as Record<string, unknown>);
					},
					recordEvent() {},
					recordRest() {},
					recordCache() {},
				}),
			});
			const ctx = { fullCommandName: 'ban' };

			scope(ctx, () => {
				hooks.onBeforeMiddlewares?.(ctx as never);
				hooks.onMiddlewaresError?.(
					ctx as never,
					'denied' as never,
					{ middleware: 'cooldown', scope: 'global' } as never,
				);
			});

			assert.equal(recorded.length, 1);
			assert.equal(recorded[0]['seyfert.failure.phase'], 'middlewares');
			// Kept off metrics on purpose: middleware x command would multiply series.
			assert.equal(recorded[0]['seyfert.middleware.name'], undefined);
		});
	});

	test('a filtered-out interaction still reports its failure phase in metrics', async () => {
		await withProvider(async exporter => {
			const hooks: Record<string, (...args: never[]) => unknown> = {};
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
				{ checkIfShouldTrace: () => false },
			);
			const recorded: Record<string, unknown>[] = [];
			const scope = testScope({
				traceEnabled: true,
				checkIfShouldTrace: () => false,
				getMetrics: () => ({
					recordInteraction(_duration, attributes) {
						recorded.push(attributes as Record<string, unknown>);
					},
					recordEvent() {},
					recordRest() {},
					recordCache() {},
				}),
			});
			const ctx = { fullCommandName: 'ban' };

			scope(ctx, () => {
				hooks.onMiddlewaresError?.(
					ctx as never,
					'denied' as never,
					{ middleware: 'cooldown', scope: 'global' } as never,
				);
			});

			assert.equal(exporter.getFinishedSpans().length, 0);
			assert.equal(recorded.length, 1);
			assert.equal(recorded[0]['seyfert.failure.phase'], 'middlewares');
		});
	});

	test('options validation errors annotate both child and root spans', async () => {
		await withProvider(async exporter => {
			const hooks: Record<string, (...args: never[]) => unknown> = {};
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
				{ checkIfShouldTrace: () => true },
			);
			const scope = testScope({
				traceEnabled: true,
				checkIfShouldTrace: () => true,
				getMetrics: () => undefined,
			});
			const ctx = { fullCommandName: 'invalid-options' };

			scope(ctx, () => {
				hooks.onBeforeOptions?.(ctx as never);
				hooks.onOptionsError?.(ctx as never);
			});

			const root = exporter.getFinishedSpans().find(span => span.name === 'command invalid-options');
			const child = exporter.getFinishedSpans().find(span => span.name === 'Options');
			assert.equal(root?.status.code, SpanStatusCode.ERROR);
			assert.equal(child?.status.code, SpanStatusCode.ERROR);
		});
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
			traces: { interactions: true, events: false, rest: false, cache: false },
			metrics: { interactions: false, events: false, rest: false, cache: false },
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
			traces: { interactions: false, events: false, rest: false, cache: false },
			metrics: { interactions: false, events: false, rest: false, cache: false },
		});
		plugin.register?.(api as never);
		assert.equal(called, false);
	});

	test('lifecycle hooks create Middlewares / Options / Run children under root', async () => {
		await withProvider(async exporter => {
			const hooks: Record<string, (...args: never[]) => unknown> = {};
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
								getTracer().startSpan('run dependency').end();
								return `ran:${(ctx as { fullCommandName?: string }).fullCommandName}`;
							},
						};
						transformer(instance, { kind: 'command' });
						hooks.__run = instance.run as (...args: never[]) => void;
					},
				},
			};

			registerInteractionInstrumentation(api, { checkIfShouldTrace: () => true });

			const scope = testScope({
				traceEnabled: true,
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
			const run = spans.find(s => s.name === 'Run');
			const dependency = spans.find(s => s.name === 'run dependency');
			assert.ok(run);
			assert.ok(dependency);
			assert.equal(dependency.parentSpanContext?.spanId, run.spanContext().spanId);
		});
	});

	test('creates one active child span per registered middleware', async () => {
		await withProvider(async exporter => {
			const hooks: Record<string, (...args: never[]) => unknown> = {};
			const plugin = opentelemetry({
				traces: { interactions: true, events: false, rest: false, cache: false },
				metrics: { interactions: false, events: false, rest: false, cache: false },
			});
			plugin.register?.({
				commands: {
					defaults(h: object) {
						Object.assign(hooks, h);
					},
				},
				components: { defaults() {} },
				modals: { defaults() {} },
				handlers: { transform() {} },
			} as never);

			let nextCalls = 0;
			const client = {
				middlewares: {
					usage: async (middle: { context: object; next: () => void }) => {
						getTracer().startSpan('middleware dependency').end();
						middle.next();
					},
				},
			};
			await plugin.setup?.(client as never, {} as never);

			const scope = testScope({
				traceEnabled: true,
				checkIfShouldTrace: () => true,
				getMetrics: () => undefined,
			});
			const ctx = { fullCommandName: 'referral stats' };
			await scope(ctx, async () => {
				hooks.onBeforeMiddlewares?.(ctx as never);
				await client.middlewares.usage({
					context: ctx,
					next() {
						nextCalls += 1;
					},
				});
				hooks.onAfterRun?.(ctx as never, undefined as never);
			});
			await plugin.teardown?.({} as never);

			assert.equal(nextCalls, 1);
			const spans = exporter.getFinishedSpans();
			const phase = spans.find(span => span.name === 'Middlewares');
			const middleware = spans.find(span => span.name === 'middleware usage');
			const dependency = spans.find(span => span.name === 'middleware dependency');
			assert.ok(phase);
			assert.ok(middleware);
			assert.ok(dependency);
			assert.equal(middleware.parentSpanContext?.spanId, phase.spanContext().spanId);
			assert.equal(dependency.parentSpanContext?.spanId, middleware.spanContext().spanId);
		});
	});

	test('wraps Run on nested subcommands', async () => {
		await withProvider(async exporter => {
			const hooks: Record<string, (...args: never[]) => unknown> = {};
			let transformed: { options: Array<{ run: (ctx: object) => string }> } | undefined;
			const api = {
				commands: {
					defaults(h: object) {
						Object.assign(hooks, h);
					},
				},
				components: { defaults() {} },
				modals: { defaults() {} },
				handlers: {
					transform(transformer: (instance: object, metadata: { kind: string }) => void) {
						transformed = {
							options: [
								{
									run: ctx => `ran:${(ctx as { fullCommandName?: string }).fullCommandName}`,
								},
							],
						};
						transformer(transformed, { kind: 'command' });
					},
				},
			};

			registerInteractionInstrumentation(api, { checkIfShouldTrace: () => true });
			assert.ok(transformed);

			const scope = testScope({
				traceEnabled: true,
				checkIfShouldTrace: () => true,
				getMetrics: () => undefined,
			});
			const ctx = { fullCommandName: 'referral stats' };
			const result = scope(ctx, () => {
				hooks.onBeforeOptions?.(ctx as never);
				hooks.onBeforeMiddlewares?.(ctx as never);
				const output = transformed?.options[0].run(ctx);
				hooks.onAfterRun?.(ctx as never, undefined as never);
				return output;
			});

			assert.equal(result, 'ran:referral stats');
			assert.ok(exporter.getFinishedSpans().some(span => span.name === 'Run'));
		});
	});

	// Seyfert only runs `handlers.transform` for top-level commands, so subcommands are
	// reached by recursing into `options`; without it they never get a Run span.
	test('wraps subcommand run methods reached through command options', async () => {
		await withProvider(async exporter => {
			const hooks: Record<string, (...args: never[]) => unknown> = {};
			let transformer: ((instance: object, metadata: { kind: string }) => void) | undefined;
			const plugin = opentelemetry({
				traces: { interactions: true, events: false, rest: false, cache: false },
				metrics: { interactions: false, events: false, rest: false, cache: false },
			});
			plugin.register?.({
				commands: {
					defaults(h: object) {
						Object.assign(hooks, h);
					},
				},
				components: { defaults() {} },
				modals: { defaults() {} },
				handlers: {
					transform(fn: (instance: object, metadata: { kind: string }) => void) {
						transformer = fn;
					},
				},
			} as never);

			assert.equal(typeof transformer, 'function');

			const subcommand = {
				run: (ctx: object) => `late:${(ctx as { fullCommandName?: string }).fullCommandName}`,
			};
			const parentCommand = { options: [subcommand] };
			const originalRun = subcommand.run;
			transformer?.(parentCommand, { kind: 'command' });
			assert.notEqual(subcommand.run, originalRun);

			const scope = testScope({
				traceEnabled: true,
				checkIfShouldTrace: () => true,
				getMetrics: () => undefined,
			});
			const ctx = { fullCommandName: 'referral stats' };
			scope(ctx, () => {
				hooks.onBeforeMiddlewares?.(ctx as never);
				subcommand.run(ctx);
				hooks.onAfterRun?.(ctx as never, undefined as never);
			});

			assert.ok(exporter.getFinishedSpans().some(span => span.name === 'Run'));
		});
	});

	test('hooks never throw even when tracer/check fails', () => {
		const hooks: Record<string, (...args: never[]) => unknown> = {};
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
