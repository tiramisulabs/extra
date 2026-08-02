import type { Attributes, Span } from '@opentelemetry/api';
import type { InteractionHandlerKind } from './instrument/interactions';
import { getCurrentSpan, record, type StartActiveSpan } from './trace-api';

export interface TraceHandle {
	readonly span: Span | undefined;
	setAttributes(attributes: Attributes): boolean;
	recordException(error: unknown): void;
	record: StartActiveSpan;
	instrumentInteractions(handlers: Iterable<object>, kind?: InteractionHandlerKind): number;
}

export interface TraceHandleOptions {
	instrumentInteractions?: (handlers: Iterable<object>, kind?: InteractionHandlerKind) => number;
}

export function createTraceHandle(options: TraceHandleOptions = {}): TraceHandle {
	return {
		get span() {
			return getCurrentSpan();
		},
		setAttributes(attributes) {
			const span = getCurrentSpan();
			if (!span) return false;
			span.setAttributes(attributes);
			return true;
		},
		recordException(error) {
			const span = getCurrentSpan();
			if (!span) return;
			const err = error instanceof Error ? error : new Error(String(error));
			span.recordException(err);
		},
		record,
		instrumentInteractions(handlers, kind) {
			return options.instrumentInteractions?.(handlers, kind) ?? 0;
		},
	};
}
