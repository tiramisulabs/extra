import {
	context as otelContext,
	trace as otelTrace,
	ROOT_CONTEXT,
	type Span,
	SpanKind,
	SpanStatusCode,
} from '@opentelemetry/api';
import type { InteractionContextScope } from '../context-scope';
import { currentInteractionFlow, type InteractionFlowCarrier, withInteractionFlow } from '../flow';
import type { TraceSource } from '../options';
import { getCurrentSpan, getTracer } from '../trace-api';
import type { InstrumentTarget } from './deps';

export interface InteractionInstrumentDeps {
	checkIfShouldTrace: (source: TraceSource) => boolean;
}

/**
 * Minimal plugin API surface used by interaction instrumentation.
 * Structural and loose so SeyfertPluginApi assigns cleanly.
 */
export interface InteractionApi {
	commands: {
		defaults: (hooks: object, opts?: object) => void;
		observe?: (observer: object, opts?: object) => () => void;
	};
	components: {
		defaults: (hooks: object, opts?: object) => void;
	};
	modals: {
		defaults: (hooks: object, opts?: object) => void;
	};
	handlers?: {
		// Transformer signature is Seyfert-generic; keep loose at the boundary.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		transform?: (transformer: (...args: any[]) => any, opts?: object) => void;
	};
}

/** Open lifecycle child spans, keyed by interaction context. */
const openChildren = new WeakMap<object, Span>();

export type InteractionFailurePhase = 'options' | 'middlewares' | 'run';

export interface InteractionFailure {
	phase: InteractionFailurePhase;
	errorType?: string;
	middleware?: string;
	middlewareScope?: string;
}

/** Failure detail captured by lifecycle hooks, consumed once when the root scope closes. */
const failures = new WeakMap<object, InteractionFailure>();

function asContextKey(context: unknown): object | undefined {
	return context !== null && typeof context === 'object' ? context : undefined;
}

/** Prefer a Seyfert error code over the class name; both are low cardinality. */
function errorTypeOf(error: unknown): string | undefined {
	if (!(error instanceof Error)) return undefined;
	const code = (error as { code?: unknown }).code;
	if (typeof code === 'string' && code.length > 0) return code;
	return error.name || 'Error';
}

/**
 * Recorded before any `checkIfShouldTrace` filtering: a caller who opts out of spans
 * still gets the failure phase on the duration histogram.
 */
function recordFailure(context: unknown, failure: InteractionFailure): void {
	const key = asContextKey(context);
	if (!key) return;
	failures.set(key, failure);
}

export function takeInteractionFailure(context: unknown): InteractionFailure | undefined {
	const key = asContextKey(context);
	if (!key) return undefined;
	const failure = failures.get(key);
	if (failure) failures.delete(key);
	return failure;
}

/** Seyfert denial metadata: which middleware rejected the interaction, and at which scope. */
function middlewareFailure(error: unknown, metadata: unknown): InteractionFailure {
	const source = metadata !== null && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : {};
	const middleware = typeof source.middleware === 'string' ? source.middleware : undefined;
	const scope = source.scope === 'global' || source.scope === 'command' ? source.scope : undefined;
	return { phase: 'middlewares', errorType: errorTypeOf(error), middleware, middlewareScope: scope };
}

function endChild(context: unknown): void {
	const key = asContextKey(context);
	if (!key) return;
	const span = openChildren.get(key);
	if (!span) return;
	try {
		span.end();
	} catch {
		// never throw from instrumentation
	}
	openChildren.delete(key);
}

function beginChild(context: unknown, name: string): Span | undefined {
	const key = asContextKey(context);
	if (!key) return undefined;
	endChild(key);
	try {
		const span = getTracer().startSpan(name);
		openChildren.set(key, span);
		return span;
	} catch {
		// never throw from instrumentation
		return undefined;
	}
}

function failChild(context: unknown, error: unknown): void {
	const key = asContextKey(context);
	if (!key) return;
	const span = openChildren.get(key);
	if (!span) return;
	try {
		const err = error instanceof Error ? error : new Error(String(error));
		span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
		span.recordException(err);
	} catch {
		// never throw from instrumentation
	}
}

function annotateRootError(error: unknown): void {
	try {
		const span = getCurrentSpan();
		if (!span) return;
		const err = error instanceof Error ? error : new Error(String(error));
		span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
		span.recordException(err);
	} catch {
		// never throw from instrumentation
	}
}

/** End any lifecycle child that is still open when the root interaction scope exits. */
export function finishInteractionLifecycle(context: unknown, error?: unknown): void {
	if (error !== undefined) failChild(context, error);
	endChild(context);
}

function safeHook<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
	return (...args: A) => {
		try {
			fn(...args);
		} catch {
			// never throw from instrumentation hooks
		}
	};
}

function shouldTrace(
	deps: InteractionInstrumentDeps,
	kind: 'command' | 'component' | 'modal',
	context: unknown,
): boolean {
	try {
		return deps.checkIfShouldTrace({ kind, context });
	} catch {
		return true;
	}
}

/**
 * Command lifecycle (Seyfert chat order):
 * onBeforeOptions → options → onBeforeMiddlewares → middlewares → run → onAfterRun
 *
 * Context menus skip options and start at onBeforeMiddlewares.
 */
function createCommandHooks(deps: InteractionInstrumentDeps) {
	return {
		onBeforeOptions: safeHook((context: unknown) => {
			if (!shouldTrace(deps, 'command', context)) return;
			beginChild(context, 'Options');
		}),
		onBeforeMiddlewares: safeHook((context: unknown) => {
			if (!shouldTrace(deps, 'command', context)) return;
			// Ends Options when present; starts Middlewares
			beginChild(context, 'Middlewares');
		}),
		onAfterRun: safeHook((context: unknown, error: unknown) => {
			if (!shouldTrace(deps, 'command', context)) return;
			endChild(context);
			if (error !== undefined && error !== null) annotateRootError(error);
		}),
		onRunError: safeHook((context: unknown, error: unknown) => {
			recordFailure(context, { phase: 'run', errorType: errorTypeOf(error) });
			if (!shouldTrace(deps, 'command', context)) return;
			failChild(context, error);
			annotateRootError(error);
		}),
		onMiddlewaresError: safeHook((context: unknown, error: unknown, metadata: unknown) => {
			recordFailure(context, middlewareFailure(error, metadata));
			if (!shouldTrace(deps, 'command', context)) return;
			failChild(context, error);
			endChild(context);
			annotateRootError(error);
		}),
		onOptionsError: safeHook((context: unknown) => {
			const error = new Error('options validation failed');
			recordFailure(context, { phase: 'options', errorType: errorTypeOf(error) });
			if (!shouldTrace(deps, 'command', context)) return;
			failChild(context, error);
			endChild(context);
			annotateRootError(error);
		}),
		onInternalError: safeHook((_client: unknown, _command: unknown, error: unknown) => {
			if (error !== undefined && error !== null) annotateRootError(error);
		}),
	};
}

/**
 * Component / modal lifecycle:
 * onBeforeMiddlewares → middlewares → run → onAfterRun
 */
function createComponentHooks(kind: 'component' | 'modal', deps: InteractionInstrumentDeps) {
	return {
		onBeforeMiddlewares: safeHook((context: unknown) => {
			if (!shouldTrace(deps, kind, context)) return;
			beginChild(context, 'Middlewares');
		}),
		onAfterRun: safeHook((context: unknown, error: unknown) => {
			if (!shouldTrace(deps, kind, context)) return;
			endChild(context);
			if (error !== undefined && error !== null) annotateRootError(error);
		}),
		onRunError: safeHook((context: unknown, error: unknown) => {
			recordFailure(context, { phase: 'run', errorType: errorTypeOf(error) });
			if (!shouldTrace(deps, kind, context)) return;
			failChild(context, error);
			annotateRootError(error);
		}),
		onMiddlewaresError: safeHook((context: unknown, error: unknown, metadata: unknown) => {
			recordFailure(context, middlewareFailure(error, metadata));
			if (!shouldTrace(deps, kind, context)) return;
			failChild(context, error);
			endChild(context);
			annotateRootError(error);
		}),
		onInternalError: safeHook((_client: unknown, _command: unknown, error: unknown) => {
			if (error !== undefined && error !== null) annotateRootError(error);
		}),
	};
}

type RunnableInstance = {
	run?: (context: unknown, ...args: unknown[]) => unknown;
	options?: readonly unknown[];
};

export type InteractionHandlerKind = 'command' | 'component' | 'modal';

interface InteractionInstrumentor {
	instrument(handlers: Iterable<object>, kind?: InteractionHandlerKind): number;
}

type MiddlewareInvocation = {
	context?: unknown;
	next?: (...args: unknown[]) => unknown;
	stop?: (...args: unknown[]) => unknown;
	[key: string]: unknown;
};

type MiddlewareHandler = (middle: MiddlewareInvocation) => unknown;

type MiddlewareClient = {
	middlewares?: Record<string, MiddlewareHandler>;
};

function markSpanError(span: Span, error: unknown): void {
	const err = error instanceof Error ? error : new Error(String(error));
	span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
	span.recordException(err);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
	return typeof (value as { then?: unknown }).then === 'function';
}

function endSpanAfterResult(span: Span, result: unknown): unknown {
	if (!isPromiseLike(result)) {
		span.end();
		return result;
	}
	return Promise.resolve(result).then(
		value => {
			span.end();
			return value;
		},
		error => {
			markSpanError(span, error);
			span.end();
			throw error;
		},
	);
}

function detectMiddlewareKind(context: unknown): InteractionHandlerKind {
	if (context === null || typeof context !== 'object') return 'command';
	const candidate = context as { isComponent?: () => boolean; isModal?: () => boolean };
	try {
		if (candidate.isModal?.()) return 'modal';
		if (candidate.isComponent?.()) return 'component';
	} catch {
		// Fall back to command for incomplete third-party contexts.
	}
	return 'command';
}

/**
 * Wrap registered Seyfert middleware functions with individually named spans.
 *
 * Known limitation — plugin setup runs at `BaseClient.start()` before
 * `installPluginMiddlewares` reassigns `client.middlewares` to a fresh object:
 * - middlewares registered via `setServices` before `start()` are wrapped, and the
 *   wrapped functions survive because the reassignment spreads them forward;
 * - middlewares contributed by plugins are installed afterwards and stay untraced;
 * - cleanup targets the original object, so teardown does not unwrap the live registry.
 *
 * Moving this to the `plugins:setupComplete` hook would fix all three.
 */
export function instrumentInteractionMiddlewares(
	target: InstrumentTarget,
	deps: InteractionInstrumentDeps,
): () => void {
	const middlewareClient = target.client as MiddlewareClient;
	const registry = middlewareClient.middlewares;
	if (!registry) return () => undefined;

	const restorations: Array<() => void> = [];
	for (const [name, original] of Object.entries(registry)) {
		if (typeof original !== 'function') continue;

		const wrapped: MiddlewareHandler = function otelWrappedMiddleware(this: unknown, middle) {
			const interactionContext = middle.context;
			const key = asContextKey(interactionContext);
			const phaseSpan = key ? openChildren.get(key) : undefined;
			const kind = detectMiddlewareKind(interactionContext);
			if (!phaseSpan || !shouldTrace(deps, kind, interactionContext)) {
				return original.call(this, middle);
			}

			const phaseContext = otelTrace.setSpan(otelContext.active(), phaseSpan);
			const next = middle.next;
			const instrumentedMiddle =
				typeof next === 'function'
					? {
							...middle,
							next: (...args: unknown[]) => otelContext.with(phaseContext, () => next(...args)),
						}
					: middle;

			return otelContext.with(phaseContext, () =>
				getTracer().startActiveSpan(`middleware ${name}`, span => {
					try {
						return endSpanAfterResult(span, original.call(this, instrumentedMiddle));
					} catch (error) {
						markSpanError(span, error);
						span.end();
						throw error;
					}
				}),
			);
		};

		registry[name] = wrapped;
		restorations.push(() => {
			if (registry[name] === wrapped) registry[name] = original;
		});
	}

	return () => {
		for (const restore of restorations.reverse()) restore();
	};
}

type CollectorRow = object;

type CollectorRegistry = {
	values?: Map<unknown, CollectorRow>;
	modals?: {
		get(key: unknown): unknown;
		set(key: unknown, value: unknown): unknown;
		delete(key: unknown): unknown;
	};
	createComponentCollector?: (messageId: unknown, ...args: unknown[]) => unknown;
	onComponent?: (messageId: unknown, interaction: unknown) => unknown;
	onModalSubmit?: (interaction: unknown) => unknown;
};

type CollectorClient = { components?: CollectorRegistry };

type PresentationObserverPayload = {
	request?: Readonly<Record<string, unknown>>;
};

type PresentationApi = {
	rest?: {
		observe?: (
			observer: { onSuccess?: (payload: PresentationObserverPayload) => unknown },
			opts?: object,
		) => () => void;
	};
};

function recordOf(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function buttonCustomIds(value: unknown): string[] {
	const ids: string[] = [];
	const visit = (candidate: unknown) => {
		if (!Array.isArray(candidate)) return;
		for (const entry of candidate) {
			const component = recordOf(entry);
			if (component.type === 2 && typeof component.custom_id === 'string') ids.push(component.custom_id);
			visit(component.components);
		}
	};
	visit(value);
	return ids;
}

/** Record Discord UI semantics only after the response that presents them succeeds. */
export function instrumentInteractionPresentations(target: InstrumentTarget): () => void {
	const observe = (target.api as PresentationApi | undefined)?.rest?.observe;
	if (typeof observe !== 'function') return () => undefined;
	const acknowledged = new WeakSet<object>();

	return observe({
		onSuccess(payload) {
			try {
				const span = getCurrentSpan();
				if (!span) return;
				const body = recordOf(payload.request?.body);
				const data = recordOf(body.data);
				const flow = currentInteractionFlow();
				const flowId = flow?.flowId;
				const responseType =
					body.type === 4
						? 'reply'
						: body.type === 5 || body.type === 6
							? 'defer'
							: body.type === 7
								? 'update'
								: undefined;
				if (responseType && !acknowledged.has(span)) {
					acknowledged.add(span);
					const latency =
						flow?.interactionStartedAt === undefined ? undefined : performance.now() - flow.interactionStartedAt;
					span.setAttributes({
						'seyfert.interaction.response_type': responseType,
						...(latency === undefined ? {} : { 'seyfert.interaction.ack_latency_ms': latency }),
					});
					span.addEvent('seyfert.interaction.acknowledged', {
						'seyfert.interaction.response_type': responseType,
						...(latency === undefined ? {} : { 'seyfert.interaction.ack_latency_ms': latency }),
					});
				}
				if (body.type === 9 && typeof data.custom_id === 'string') {
					span.addEvent('seyfert.modal.opened', {
						'seyfert.custom_id': data.custom_id,
						...(flowId ? { 'seyfert.flow_id': flowId } : {}),
					});
				}

				for (const customId of buttonCustomIds(data.components ?? body.components)) {
					span.addEvent('seyfert.button.presented', {
						'seyfert.custom_id': customId,
						...(flowId ? { 'seyfert.flow_id': flowId } : {}),
					});
				}
			} catch {
				// never throw presentation instrumentation into the request path
			}
		},
	});
}

function interactionUserId(interaction: unknown): unknown {
	if (interaction === null || typeof interaction !== 'object') return undefined;
	const user = (interaction as { user?: unknown }).user;
	return user !== null && typeof user === 'object' ? (user as { id?: unknown }).id : undefined;
}

function collectorFlow(): InteractionFlowCarrier | undefined {
	const flow = currentInteractionFlow();
	if (!flow) return undefined;
	return {
		flowId: flow.flowId,
		spanContext: getCurrentSpan()?.spanContext() ?? flow.spanContext,
		interactionStartedAt: flow.interactionStartedAt,
	};
}

type CollectorRegistration = {
	flow: InteractionFlowCarrier;
	registeredAt: number;
	timeoutMs?: number;
};

function matcherLabel(matcher: unknown): string | undefined {
	if (typeof matcher === 'string') return matcher;
	if (matcher instanceof RegExp) return matcher.toString();
	if (Array.isArray(matcher)) return matcher.filter(value => typeof value === 'string').join(',');
	return undefined;
}

function registrationAttributes(type: 'component' | 'modal', matcher?: unknown, timeoutMs?: number) {
	const matcherValue = matcherLabel(matcher);
	return {
		'seyfert.collector.type': type,
		...(matcherValue ? { 'seyfert.collector.matcher': matcherValue } : {}),
		...(timeoutMs === undefined ? {} : { 'seyfert.collector.timeout_ms': timeoutMs }),
	};
}

function recordCollectorRegistration(type: 'component' | 'modal', matcher?: unknown, timeoutMs?: number): void {
	try {
		getCurrentSpan()?.addEvent('seyfert.collector.registered', registrationAttributes(type, matcher, timeoutMs));
	} catch {
		// never throw collector instrumentation into user code
	}
}

function annotateCollectorCallback(
	span: Span | undefined,
	registration: CollectorRegistration,
	type: 'component' | 'modal',
	interaction: unknown,
): void {
	if (!span) return;
	const customId = recordOf(interaction).customId;
	span.setAttributes({
		...registrationAttributes(type, undefined, registration.timeoutMs),
		'seyfert.collector.wait_duration_ms': performance.now() - registration.registeredAt,
	});
	span.addEvent(type === 'component' ? 'seyfert.button.clicked' : 'seyfert.modal.submitted', {
		...(typeof customId === 'string' ? { 'seyfert.custom_id': customId } : {}),
	});
}

function setCollectorResult(span: Span | undefined, result: 'completed' | 'error'): void {
	try {
		span?.setAttribute('seyfert.collector.result', result);
	} catch {
		// never throw collector instrumentation into user code
	}
}

function collectorOutcome(registration: CollectorRegistration, reason: unknown, run: () => unknown): unknown {
	const result = reason === 'timeout' || reason === 'idle' ? 'timeout' : 'stopped';
	const parentContext = registration.flow.spanContext
		? otelTrace.setSpanContext(ROOT_CONTEXT, registration.flow.spanContext)
		: ROOT_CONTEXT;
	return getTracer().startActiveSpan(
		`component collector ${result}`,
		{
			kind: SpanKind.CONSUMER,
			attributes: {
				'seyfert.flow_id': registration.flow.flowId,
				'seyfert.collector.type': 'component',
				'seyfert.collector.result': result,
				'seyfert.collector.wait_duration_ms': performance.now() - registration.registeredAt,
				...(registration.timeoutMs === undefined ? {} : { 'seyfert.collector.timeout_ms': registration.timeoutMs }),
				...(typeof reason === 'string' ? { 'seyfert.collector.stop_reason': reason } : {}),
			},
		},
		parentContext,
		span =>
			withInteractionFlow(
				{ ...registration.flow, spanContext: span.spanContext(), interactionStartedAt: performance.now() },
				() => {
					try {
						const outcome = run();
						if (!isPromiseLike(outcome)) {
							span.end();
							return outcome;
						}
						return Promise.resolve(outcome).then(
							value => {
								span.end();
								return value;
							},
							error => {
								span.setAttribute('seyfert.collector.result', 'error');
								markSpanError(span, error);
								span.end();
								throw error;
							},
						);
					} catch (error) {
						span.setAttribute('seyfert.collector.result', 'error');
						markSpanError(span, error);
						span.end();
						throw error;
					}
				},
			),
	);
}

function collectorSpanName(kind: 'component' | 'modal', interaction: unknown): string {
	const source = recordOf(interaction);
	const nested = recordOf(source.interaction);
	const customId = source.customId ?? nested.customId;
	const family = typeof customId === 'string' ? customId.split(':', 1)[0] : undefined;
	return family ? `${kind} collector ${family}` : `${kind} collector`;
}

/** Collector callbacks bypass Seyfert contextScopes, so route their dispatchers through the same interaction scope. */
export function instrumentInteractionCollectors(target: InstrumentTarget, scope: InteractionContextScope): () => void {
	const components = (target.client as CollectorClient | undefined)?.components;
	if (!components) return () => undefined;

	const rowFlows = new WeakMap<CollectorRow, CollectorRegistration>();
	const modalFlows = new Map<unknown, CollectorRegistration>();
	const callbackErrors = new WeakSet<object>();
	const restorations: Array<() => void> = [];

	const originalCreate = components.createComponentCollector;
	if (typeof originalCreate === 'function') {
		const wrapped = function otelCreateCollector(this: CollectorRegistry, messageId: unknown, ...args: unknown[]) {
			const flow = collectorFlow();
			const options = recordOf(args[2]);
			const timeoutMs = typeof options.timeout === 'number' && options.timeout > 0 ? options.timeout : undefined;
			const registration = flow ? { flow, registeredAt: performance.now(), timeoutMs } : undefined;
			if (registration) {
				const onStop = typeof options.onStop === 'function' ? options.onStop : undefined;
				args[2] = {
					...options,
					onStop(this: unknown, reason: unknown, ...stopArgs: unknown[]) {
						return collectorOutcome(registration, reason, () => onStop?.call(this, reason, ...stopArgs));
					},
				};
			}
			const result = originalCreate.call(this, messageId, ...args);
			const row = this.values?.get(messageId);
			if (registration && row) rowFlows.set(row, registration);
			if (registration && result !== null && typeof result === 'object') {
				const collector = result as { run?: (...args: unknown[]) => unknown };
				const originalRun = collector.run;
				if (typeof originalRun === 'function') {
					collector.run = function otelCollectorRun(this: unknown, matcher: unknown, callback: unknown, ...runArgs) {
						recordCollectorRegistration('component', matcher, timeoutMs);
						const wrappedCallback =
							typeof callback === 'function'
								? function otelCollectorCallback(this: unknown, interaction: unknown, ...callbackArgs: unknown[]) {
										try {
											const span = getCurrentSpan();
											const label = matcherLabel(matcher);
											if (label) span?.setAttribute('seyfert.collector.matcher', label);
											const callbackResult = callback.call(this, interaction, ...callbackArgs);
											if (!isPromiseLike(callbackResult)) return callbackResult;
											return Promise.resolve(callbackResult).catch(error => {
												const key = asContextKey(interaction);
												if (key) callbackErrors.add(key);
												if (span) markSpanError(span, error);
												throw error;
											});
										} catch (error) {
											const key = asContextKey(interaction);
											if (key) callbackErrors.add(key);
											const span = getCurrentSpan();
											if (span) markSpanError(span, error);
											throw error;
										}
									}
								: callback;
						return originalRun.call(this, matcher, wrappedCallback, ...runArgs);
					};
				}
			}
			return result;
		};
		components.createComponentCollector = wrapped;
		restorations.push(() => {
			if (components.createComponentCollector === wrapped) components.createComponentCollector = originalCreate;
		});
	}

	const originalComponent = components.onComponent;
	if (typeof originalComponent === 'function') {
		const wrapped = function otelCollectedComponent(this: CollectorRegistry, messageId: unknown, interaction: unknown) {
			const row = this.values?.get(messageId);
			const registration = row ? rowFlows.get(row) : undefined;
			if (!registration) return originalComponent.call(this, messageId, interaction);
			return scope(
				interaction,
				() => {
					const span = getCurrentSpan();
					annotateCollectorCallback(span, registration, 'component', interaction);
					const complete = () => {
						const key = asContextKey(interaction);
						const failed = key ? callbackErrors.has(key) : false;
						setCollectorResult(span, failed ? 'error' : 'completed');
						if (failed && key) callbackErrors.delete(key);
					};
					try {
						const result = originalComponent.call(this, messageId, interaction);
						if (!isPromiseLike(result)) {
							complete();
							return result;
						}
						return Promise.resolve(result).then(
							value => {
								complete();
								return value;
							},
							error => {
								setCollectorResult(span, 'error');
								throw error;
							},
						);
					} catch (error) {
						setCollectorResult(span, 'error');
						throw error;
					}
				},
				{
					kind: 'component',
					spanName: collectorSpanName('component', interaction),
					parent: registration.flow,
				},
			);
		};
		components.onComponent = wrapped;
		restorations.push(() => {
			if (components.onComponent === wrapped) components.onComponent = originalComponent;
		});
	}

	const modals = components.modals;
	if (modals) {
		const originalSet = modals.set;
		const wrappedSet = function otelModalSet(this: typeof modals, key: unknown, value: unknown) {
			const flow = collectorFlow();
			if (flow) {
				modalFlows.set(key, { flow, registeredAt: performance.now() });
				recordCollectorRegistration('modal');
			}
			return originalSet.call(this, key, value);
		};
		modals.set = wrappedSet;
		restorations.push(() => {
			if (modals.set === wrappedSet) modals.set = originalSet;
		});

		const originalDelete = modals.delete;
		const wrappedDelete = function otelModalDelete(this: typeof modals, key: unknown) {
			modalFlows.delete(key);
			return originalDelete.call(this, key);
		};
		modals.delete = wrappedDelete;
		restorations.push(() => {
			if (modals.delete === wrappedDelete) modals.delete = originalDelete;
		});
	}

	const originalModal = components.onModalSubmit;
	if (typeof originalModal === 'function') {
		const wrapped = function otelCollectedModal(this: CollectorRegistry, interaction: unknown) {
			const registration = modalFlows.get(interactionUserId(interaction));
			if (!registration) return originalModal.call(this, interaction);
			return scope(
				interaction,
				() => {
					const span = getCurrentSpan();
					annotateCollectorCallback(span, registration, 'modal', interaction);
					try {
						const result = originalModal.call(this, interaction);
						if (!isPromiseLike(result)) {
							setCollectorResult(span, 'completed');
							return result;
						}
						return Promise.resolve(result).then(
							value => {
								setCollectorResult(span, 'completed');
								return value;
							},
							error => {
								setCollectorResult(span, 'error');
								throw error;
							},
						);
					} catch (error) {
						setCollectorResult(span, 'error');
						throw error;
					}
				},
				{
					kind: 'modal',
					spanName: collectorSpanName('modal', interaction),
					parent: registration.flow,
				},
			);
		};
		components.onModalSubmit = wrapped;
		restorations.push(() => {
			if (components.onModalSubmit === wrapped) components.onModalSubmit = originalModal;
		});
	}

	return () => {
		for (const restore of restorations.reverse()) restore();
	};
}

function asRunnableInstance(value: unknown): RunnableInstance | undefined {
	return value !== null && typeof value === 'object' ? (value as RunnableInstance) : undefined;
}

function createInteractionInstrumentor(deps: InteractionInstrumentDeps): InteractionInstrumentor {
	const wrapped = new WeakSet<object>();

	const instrumentOne = (value: unknown, kind: InteractionHandlerKind): number => {
		const instance = asRunnableInstance(value);
		if (!instance) return 0;

		let count = 0;
		const original = instance.run;
		if (typeof original === 'function' && !wrapped.has(instance)) {
			instance.run = function otelWrappedRun(this: unknown, context: unknown, ...rest: unknown[]) {
				if (!shouldTrace(deps, kind, context)) {
					return original.call(this, context, ...rest);
				}
				// Leave Middlewares (if open) and enter Run under the active root span.
				const span = beginChild(context, 'Run');
				if (!span) return original.call(this, context, ...rest);
				const runContext = otelTrace.setSpan(otelContext.active(), span);
				return otelContext.with(runContext, () => original.call(this, context, ...rest));
			};
			wrapped.add(instance);
			count += 1;
		}

		if (kind === 'command' && Array.isArray(instance.options)) {
			for (const option of instance.options) {
				count += instrumentOne(option, kind);
			}
		}
		return count;
	};

	return {
		instrument(handlers, kind = 'command') {
			let count = 0;
			for (const handler of handlers) {
				count += instrumentOne(handler, kind);
			}
			return count;
		},
	};
}

/**
 * Wrap `run` so a `Run` child starts when the main handler begins
 * (ends Middlewares if still open). Ended by onAfterRun defaults.
 */
function installRunWrappers(api: InteractionApi, instrumentor: InteractionInstrumentor): void {
	const transform = api.handlers?.transform;
	if (typeof transform !== 'function') return;

	// Cast: Seyfert PluginHandlerTransformer is generic over kind; we only need run().
	(transform as (transformer: (instance: RunnableInstance, metadata: { kind: string }) => void) => void)(
		(instance, metadata) => {
			if (metadata.kind === 'event') return;
			const kind: InteractionHandlerKind =
				metadata.kind === 'component' ? 'component' : metadata.kind === 'modal' ? 'modal' : 'command';
			instrumentor.instrument([instance], kind);
		},
	);
}

/**
 * Installs command/component/modal lifecycle defaults (child spans under the
 * interaction root owned by `contextScopes`).
 *
 * Seyfert hook keys (from BaseClientOptions):
 * - commands: onBeforeOptions, onBeforeMiddlewares, onAfterRun, onRunError, …
 * - components/modals: onBeforeMiddlewares, onAfterRun, onRunError, …
 */
export function registerInteractionInstrumentation(api: InteractionApi, deps: InteractionInstrumentDeps): void {
	api.commands.defaults(createCommandHooks(deps));
	api.components.defaults(createComponentHooks('component', deps));
	api.modals.defaults(createComponentHooks('modal', deps));
	installRunWrappers(api, createInteractionInstrumentor(deps));
}
