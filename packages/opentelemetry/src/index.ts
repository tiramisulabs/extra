import './seyfert';

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
