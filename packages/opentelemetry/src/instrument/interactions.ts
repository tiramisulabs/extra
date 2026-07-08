import { SpanStatusCode, type Span } from '@opentelemetry/api';
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

function beginChild(context: unknown, name: string): void {
	const key = asContextKey(context);
	if (!key) return;
	endChild(key);
	try {
		const span = getTracer().startSpan(name);
		openChildren.set(key, span);
	} catch {
		// never throw from instrumentation
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
			failChild(context, new Error('options validation failed'));
			endChild(context);
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
	};
}

type RunnableInstance = {
	run?: (context: unknown, ...args: unknown[]) => unknown;
};

/**
 * Wrap `run` so a `Run` child starts when the main handler begins
 * (ends Middlewares if still open). Ended by onAfterRun defaults.
 */
function installRunWrappers(api: InteractionApi, deps: InteractionInstrumentDeps): void {
	const transform = api.handlers?.transform;
	if (typeof transform !== 'function') return;

	// Cast: Seyfert PluginHandlerTransformer is generic over kind; we only need run().
	(transform as (transformer: (instance: RunnableInstance, metadata: { kind: string }) => void) => void)(
		(instance, metadata) => {
			if (metadata.kind === 'event') return;
			const original = instance.run;
			if (typeof original !== 'function') return;

			const kind: 'command' | 'component' | 'modal' =
				metadata.kind === 'component'
					? 'component'
					: metadata.kind === 'modal'
						? 'modal'
						: 'command';

			instance.run = function otelWrappedRun(this: unknown, context: unknown, ...rest: unknown[]) {
				if (!shouldTrace(deps, kind, context)) {
					return original.call(this, context, ...rest);
				}
				// Leave Middlewares (if open) and enter Run under the active root span.
				beginChild(context, 'Run');
				return original.call(this, context, ...rest);
			};
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
): void {
	api.commands.defaults(createCommandHooks(deps));
	api.components.defaults(createComponentHooks('component', deps));
	api.modals.defaults(createComponentHooks('modal', deps));
	installRunWrappers(api, deps);
}
