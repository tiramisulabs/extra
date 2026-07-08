import {
	type Attributes,
	type Context,
	metrics,
	type Span,
	type SpanOptions,
	SpanStatusCode,
	type Tracer,
	trace,
} from '@opentelemetry/api';

let activeServiceName = 'seyfert';

/** Package-internal: set by plugin setup so helpers scope to the plugin service name. */
export function setTraceServiceName(name: string): void {
	activeServiceName = name;
}

export function getTracer(): Tracer {
	return trace.getTracer(activeServiceName);
}

export function getMeter() {
	return metrics.getMeter(activeServiceName);
}

export type ActiveSpanArgs<F extends (span: Span) => unknown = (span: Span) => unknown> =
	| [name: string, fn: F]
	| [name: string, options: SpanOptions, fn: F]
	| [name: string, options: SpanOptions, context: Context, fn: F];

export type StartActiveSpan = (...args: ActiveSpanArgs) => unknown;

function createActiveSpanHandler(fn: (span: Span) => unknown) {
	return function handler(span: Span) {
		try {
			const result = fn(span);
			if (result !== null && typeof result === 'object' && typeof (result as Promise<unknown>).then === 'function') {
				return Promise.resolve(result).then(
					value => {
						span.end();
						return value;
					},
					rejectResult => {
						const err = rejectResult instanceof Error ? rejectResult : new Error(String(rejectResult));
						span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
						span.recordException(err);
						span.end();
						throw rejectResult;
					},
				);
			}
			span.end();
			return result;
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
			span.recordException(err);
			span.end();
			throw error;
		}
	};
}

export const startActiveSpan: StartActiveSpan = (...args: ActiveSpanArgs) => {
	const tracer = getTracer();
	switch (args.length) {
		case 2:
			return tracer.startActiveSpan(args[0], createActiveSpanHandler(args[1]));
		case 3:
			return tracer.startActiveSpan(args[0], args[1], createActiveSpanHandler(args[2]));
		case 4:
			return tracer.startActiveSpan(args[0], args[1], args[2], createActiveSpanHandler(args[3]));
	}
};

/** Alias of {@link startActiveSpan}: auto-ends span; ERROR + recordException on throw/reject. */
export const record = startActiveSpan;

export function startSpan(name: string, options?: SpanOptions, context?: Context): Span {
	return getTracer().startSpan(name, options, context);
}

export function getCurrentSpan(): Span | undefined {
	return trace.getActiveSpan();
}

export function setAttributes(attributes: Attributes): boolean {
	const span = getCurrentSpan();
	if (!span) return false;
	span.setAttributes(attributes);
	return true;
}
