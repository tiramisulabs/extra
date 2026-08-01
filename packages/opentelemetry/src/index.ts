export { createTraceHandle, type TraceHandle } from './handle';
export type {
	OpenTelemetryPluginOptions,
	SignalFlags,
	TraceSource,
} from './options';
export { opentelemetry } from './plugin';
export {
	getCurrentSpan,
	getMeter,
	getTracer,
	record,
	setAttributes,
	startActiveSpan,
	startSpan,
} from './trace-api';
