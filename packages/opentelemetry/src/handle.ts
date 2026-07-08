import type { Attributes, Span } from '@opentelemetry/api';
import type { StartActiveSpan } from './trace-api';

export interface TraceHandle {
	readonly span: Span | undefined;
	setAttributes(attributes: Attributes): boolean;
	recordException(error: unknown): void;
	record: StartActiveSpan;
}
