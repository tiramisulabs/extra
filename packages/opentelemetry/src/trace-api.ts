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

export type ActiveSpanArgs<T> =
	| [name: string, fn: (span: Span) => T]
	| [name: string, options: SpanOptions, fn: (span: Span) => T]
	| [name: string, options: SpanOptions, context: Context, fn: (span: Span) => T];

export interface StartActiveSpan {
	<T>(name: string, fn: (span: Span) => T): T;
	<T>(name: string, options: SpanOptions, fn: (span: Span) => T): T;
	<T>(name: string, options: SpanOptions, context: Context, fn: (span: Span) => T): T;
}

function createActiveSpanHandler<T>(fn: (span: Span) => T): (span: Span) => T {
	return function handler(span: Span) {
		try {
			const result = fn(span);
			if (
				result !== null &&
				typeof result === 'object' &&
				typeof (result as unknown as Promise<unknown>).then === 'function'
			) {
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
				) as T;
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

export const startActiveSpan: StartActiveSpan = (<T>(...args: ActiveSpanArgs<T>) => {
	const tracer = getTracer();
	switch (args.length) {
		case 2:
			return tracer.startActiveSpan(args[0], createActiveSpanHandler(args[1]));
		case 3:
			return tracer.startActiveSpan(args[0], args[1], createActiveSpanHandler(args[2]));
		case 4:
			return tracer.startActiveSpan(args[0], args[1], args[2], createActiveSpanHandler(args[3]));
	}
}) as StartActiveSpan;

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
