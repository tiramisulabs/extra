import { randomUUID } from 'node:crypto';
import { ROOT_CONTEXT, type Span, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { ATTR_ERROR_TYPE } from '@opentelemetry/semantic-conventions';
import type { ContextScope } from 'seyfert';
import { extractInteractionAttributes, type InteractionKind, interactionSpanName } from './attributes';
import { type InteractionFlowCarrier, withInteractionFlow } from './flow';
import type { InstrumentDeps } from './instrument/deps';
import { finishInteractionLifecycle, type InteractionFailure, takeInteractionFailure } from './instrument/interactions';
import { durationSecondsSince } from './metrics';
import type { TraceSource } from './options';
import { getTracer } from './trace-api';

type ContextMarkers = {
	isModal?: () => boolean;
	isComponent?: () => boolean;
	isChat?: () => boolean;
	isMenu?: () => boolean;
	isEntryPoint?: () => boolean;
	customId?: unknown;
	command?: unknown;
	fullCommandName?: unknown;
	commandName?: unknown;
	interaction?: unknown;
	values?: unknown;
};

function callMarker(context: ContextMarkers, name: keyof ContextMarkers): boolean {
	const fn = context[name];
	if (typeof fn !== 'function') return false;
	try {
		return Boolean((fn as () => boolean).call(context));
	} catch {
		return false;
	}
}

/**
 * Prefer Seyfert BaseContext markers (`isModal` / `isComponent` / `isChat` / …),
 * then fall back to structural fields for plain test objects.
 */
function detectKind(context: unknown): InteractionKind {
	const source: ContextMarkers = context !== null && typeof context === 'object' ? (context as ContextMarkers) : {};

	if (callMarker(source, 'isModal')) return 'modal';
	if (callMarker(source, 'isComponent')) return 'component';
	if (callMarker(source, 'isChat')) return 'command';
	if (callMarker(source, 'isMenu')) return 'command';
	if (callMarker(source, 'isEntryPoint')) return 'command';

	if (source.customId !== undefined && source.customId !== null) {
		const interaction =
			source.interaction !== null && typeof source.interaction === 'object'
				? (source.interaction as Record<string, unknown>)
				: (source as Record<string, unknown>);
		// Discord interaction type 5 = ModalSubmit, 3 = MessageComponent
		if (interaction.type === 5) return 'modal';
		if (interaction.type === 3) return 'component';
		return 'component';
	}

	if (source.command !== undefined || source.fullCommandName !== undefined || source.commandName !== undefined) {
		return 'command';
	}

	return 'command';
}

/**
 * Root interaction span via Seyfert `contextScopes`.
 * Wraps the command/component/modal pipeline so nested REST/cache spans parent correctly.
 *
 * Fail-open: a throwing `checkIfShouldTrace` still traces. Finish/metrics errors never
 * escape into user code — only the user's own throw/reject is rethrown.
 */
export interface InteractionScopeOptions {
	kind?: InteractionKind;
	spanName?: string;
	parent?: InteractionFlowCarrier;
}

export interface InteractionContextScope extends ContextScope {
	<T>(context: unknown, run: () => T, options?: InteractionScopeOptions): T;
}

export function createInteractionContextScope(deps: InstrumentDeps): InteractionContextScope {
	return ((context: unknown, run: () => unknown, options?: InteractionScopeOptions) => {
		const kind = options?.kind ?? detectKind(context);
		const source: TraceSource = { kind, context };
		const name = options?.spanName ?? interactionSpanName(kind, context);
		const attributes = extractInteractionAttributes(kind, context);
		const flowId = options?.parent?.flowId ?? randomUUID();
		attributes['seyfert.flow_id'] = flowId;
		const start = performance.now();

		const recordMetrics = (error?: unknown, failure?: InteractionFailure) => {
			try {
				deps.getMetrics()?.recordInteraction(durationSecondsSince(start), {
					'seyfert.interaction.kind': kind,
					...(typeof attributes['seyfert.command'] === 'string'
						? { 'seyfert.command': attributes['seyfert.command'] }
						: {}),
					...(typeof attributes['seyfert.shard_id'] === 'number'
						? { 'seyfert.shard_id': attributes['seyfert.shard_id'] }
						: {}),
					'seyfert.error': error !== undefined,
					// Phase only: bounded to four values. The middleware name stays span-only.
					...(failure ? { 'seyfert.failure.phase': failure.phase } : {}),
				});
			} catch {
				// metrics must not break handlers
			}
		};

		const annotateFailure = (span: Span, failure: InteractionFailure) => {
			try {
				span.setAttributes({
					'seyfert.failure.phase': failure.phase,
					...(failure.errorType ? { [ATTR_ERROR_TYPE]: failure.errorType } : {}),
					...(failure.middleware ? { 'seyfert.middleware.name': failure.middleware } : {}),
					...(failure.middlewareScope ? { 'seyfert.middleware.scope': failure.middlewareScope } : {}),
				});
			} catch {
				// never throw instrumentation errors into user code
			}
		};

		const execute = (finish: (error?: unknown) => void) => {
			try {
				const result = run();
				if (result !== null && typeof result === 'object' && typeof (result as Promise<unknown>).then === 'function') {
					return Promise.resolve(result).then(
						value => {
							finish();
							return value;
						},
						error => {
							finish(error);
							throw error;
						},
					);
				}
				finish();
				return result;
			} catch (error) {
				finish(error);
				throw error;
			}
		};

		let shouldTrace = deps.traceEnabled;
		if (shouldTrace) {
			try {
				shouldTrace = deps.checkIfShouldTrace(source);
			} catch {
				// Fail open: prefer a span over silently dropping telemetry.
				shouldTrace = true;
			}
		}
		if (!shouldTrace) {
			return withInteractionFlow(
				{ flowId, spanContext: options?.parent?.spanContext, interactionStartedAt: start },
				() => execute(error => recordMetrics(error, takeInteractionFailure(context))),
			);
		}

		const tracer = getTracer();

		const parentContext = options?.parent?.spanContext
			? trace.setSpanContext(ROOT_CONTEXT, options.parent.spanContext)
			: ROOT_CONTEXT;

		return tracer.startActiveSpan(name, { kind: SpanKind.CONSUMER, attributes }, parentContext, span => {
			const finish = (error?: unknown) => {
				finishInteractionLifecycle(context, error);
				const failure = takeInteractionFailure(context);
				if (failure) annotateFailure(span, failure);
				if (error !== undefined) {
					try {
						const err = error instanceof Error ? error : new Error(String(error));
						span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
						span.recordException(err);
					} catch {
						// never throw instrumentation errors into user code
					}
				}
				recordMetrics(error, failure);
				try {
					span.end();
				} catch {
					// never throw instrumentation errors into user code
				}
			};

			return withInteractionFlow({ flowId, spanContext: span.spanContext(), interactionStartedAt: start }, () =>
				execute(finish),
			);
		});
	}) as InteractionContextScope;
}
