export type { TelemetryMetadata } from './attributes';
export { createTraceHandle, type TraceHandle } from './handle';
export type {
	MetricFlags,
	OpenTelemetryBootstrapOptions,
	OpenTelemetryPluginOptions,
	SignalFlags,
	TraceSource,
} from './options';
export { opentelemetry } from './plugin';
export { type OwnedSdk, startOpenTelemetry } from './sdk';
export {
	getCurrentSpan,
	getMeter,
	getTracer,
	record,
	setAttributes,
	startActiveSpan,
	startSpan,
} from './trace-api';
