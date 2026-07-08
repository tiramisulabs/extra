import type { Context, Span, SpanOptions } from '@opentelemetry/api';

export type ActiveSpanArgs<F extends (span: Span) => unknown = (span: Span) => unknown> =
	| [name: string, fn: F]
	| [name: string, options: SpanOptions, fn: F]
	| [name: string, options: SpanOptions, context: Context, fn: F];

export type StartActiveSpan = (...args: ActiveSpanArgs) => unknown;
