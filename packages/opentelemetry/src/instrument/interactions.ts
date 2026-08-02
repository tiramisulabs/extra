import { context as otelContext, trace as otelTrace, type Span, SpanStatusCode } from '@opentelemetry/api';
import type { TraceSource } from '../options';
import { getCurrentSpan, getTracer } from '../trace-api';

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

function asContextKey(context: unknown): object | undefined {
	return context !== null && typeof context === 'object' ? context : undefined;
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
			if (!shouldTrace(deps, 'command', context)) return;
			failChild(context, error);
			annotateRootError(error);
		}),
		onMiddlewaresError: safeHook((context: unknown, error: unknown) => {
			if (!shouldTrace(deps, 'command', context)) return;
			failChild(context, error);
			endChild(context);
			annotateRootError(error);
		}),
		onOptionsError: safeHook((context: unknown) => {
			if (!shouldTrace(deps, 'command', context)) return;
			const error = new Error('options validation failed');
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
			if (!shouldTrace(deps, kind, context)) return;
			failChild(context, error);
			annotateRootError(error);
		}),
		onMiddlewaresError: safeHook((context: unknown, error: unknown) => {
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

export interface InteractionInstrumentor {
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

/** Wrap registered Seyfert middleware functions with individually named spans. */
export function instrumentInteractionMiddlewares(client: unknown, deps: InteractionInstrumentDeps): () => void {
	const middlewareClient = client as MiddlewareClient;
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
export function registerInteractionInstrumentation(
	api: InteractionApi,
	deps: InteractionInstrumentDeps,
): InteractionInstrumentor {
	const instrumentor = createInteractionInstrumentor(deps);
	api.commands.defaults(createCommandHooks(deps));
	api.components.defaults(createComponentHooks('component', deps));
	api.modals.defaults(createComponentHooks('modal', deps));
	installRunWrappers(api, instrumentor);
	return instrumentor;
}
