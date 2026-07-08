import './seyfert';

export { createTraceHandle, type TraceHandle } from './handle';
export { opentelemetry } from './plugin';
export type {
	InstrumentFlags,
	OpenTelemetryPluginOptions,
	TraceSource,
} from './options';
export {
	getCurrentSpan,
	getMeter,
	getTracer,
	record,
	setAttributes,
	startActiveSpan,
	startSpan,
} from './trace-api';
