import { createPlugin, type SeyfertPlugin } from 'seyfert';
import type { OpenTelemetryPluginOptions } from './options';

export function opentelemetry(_options: OpenTelemetryPluginOptions = {}): SeyfertPlugin {
	return createPlugin({
		name: '@slipher/opentelemetry',
		setup() {},
		teardown() {},
	});
}
