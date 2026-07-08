import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { ContextScope } from 'seyfert';
import {
	extractInteractionAttributes,
	interactionSpanName,
	type InteractionKind,
} from './attributes';
import { durationSecondsSince, type CoreMetrics } from './metrics';
import type { TraceSource } from './options';
import { getTracer } from './trace-api';

export interface InteractionScopeDeps {
	serviceName: string;
	checkIfShouldTrace: (source: TraceSource) => boolean;
	getMetrics: () => CoreMetrics | undefined;
}

function detectKind(context: unknown): InteractionKind {
	const source =
		context !== null && typeof context === 'object'
			? (context as Record<string, unknown>)
			: {};

	if (source.customId !== undefined && source.customId !== null) {
		const interaction =
			source.interaction !== null && typeof source.interaction === 'object'
				? (source.interaction as Record<string, unknown>)
				: source;
		// Discord interaction type 5 = MODAL_SUBMIT
		if (interaction.type === 5) return 'modal';
		return 'component';
	}

	return 'command';
}

/**
 * Root interaction span via Seyfert `contextScopes`.
 * Wraps the command/component/modal pipeline so nested REST/cache spans parent correctly.
 */
export function createInteractionContextScope(deps: InteractionScopeDeps): ContextScope {
	return (context, run) => {
		const kind = detectKind(context);
		const source: TraceSource = { kind, context };
		if (!deps.checkIfShouldTrace(source)) return run();

		const tracer = getTracer();
		const name = interactionSpanName(kind, context);
		const attributes = extractInteractionAttributes(kind, context);
		const start = performance.now();

		return tracer.startActiveSpan(name, { kind: SpanKind.INTERNAL, attributes }, span => {
			const finish = (error?: unknown) => {
				if (error !== undefined) {
					const err = error instanceof Error ? error : new Error(String(error));
					span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
					span.recordException(err);
				}
				deps.getMetrics()?.recordInteraction(durationSecondsSince(start), {
					...attributes,
					'seyfert.error': error !== undefined,
				});
				span.end();
			};

			try {
				const result = run();
				if (
					result !== null &&
					typeof result === 'object' &&
					typeof (result as Promise<unknown>).then === 'function'
				) {
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
