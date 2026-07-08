import './seyfert';

export { createTraceHandle, type TraceHandle } from './handle';
export type {
	InstrumentFlags,
	OpenTelemetryPluginOptions,
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
