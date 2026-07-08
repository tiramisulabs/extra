import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { ContextScope } from 'seyfert';
import { extractInteractionAttributes, type InteractionKind, interactionSpanName } from './attributes';
import { type CoreMetrics, durationSecondsSince } from './metrics';
import type { TraceSource } from './options';
import { getTracer } from './trace-api';

export interface InteractionScopeDeps {
	serviceName: string;
	checkIfShouldTrace: (source: TraceSource) => boolean;
	getMetrics: () => CoreMetrics | undefined;
}

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
export function createInteractionContextScope(deps: InteractionScopeDeps): ContextScope {
	return (context, run) => {
		const kind = detectKind(context);
		const source: TraceSource = { kind, context };

		let shouldTrace = true;
		try {
			shouldTrace = deps.checkIfShouldTrace(source);
		} catch {
			// Fail open: prefer a span over silently dropping telemetry.
			shouldTrace = true;
		}
		if (!shouldTrace) return run();

		const tracer = getTracer();
		const name = interactionSpanName(kind, context);
		const attributes = extractInteractionAttributes(kind, context);
		const start = performance.now();

		return tracer.startActiveSpan(name, { kind: SpanKind.INTERNAL, attributes }, span => {
			const finish = (error?: unknown) => {
				if (error !== undefined) {
					try {
						const err = error instanceof Error ? error : new Error(String(error));
						span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
						span.recordException(err);
					} catch {
						// never throw instrumentation errors into user code
					}
				}
				try {
					deps.getMetrics()?.recordInteraction(durationSecondsSince(start), {
						...attributes,
						'seyfert.error': error !== undefined,
					});
				} catch {
					// metrics must not break handlers
				}
				try {
					span.end();
				} catch {
					// never throw instrumentation errors into user code
				}
			};

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
		});
	};
}
