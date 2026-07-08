import { definePlugins } from 'seyfert';
import { opentelemetry } from '../src';

const plugins = definePlugins(opentelemetry({ serviceName: 'types-check' }));

declare module 'seyfert' {
	interface SeyfertRegistry {
		plugins: typeof plugins;
	}
}

export type _Plugins = typeof plugins;
