import { type Client, type CommandContext, definePlugins } from 'seyfert';
import { opentelemetry, record } from '../src';

const plugins = definePlugins(opentelemetry({ serviceName: 'types-check' }));

declare module 'seyfert' {
	interface SeyfertRegistry {
		plugins: typeof plugins;
	}
}

export type _Plugins = typeof plugins;

declare const client: Client<true>;
declare const context: CommandContext;

client.trace.setAttributes({ 'test.client': true });
context.trace.setAttributes({ 'test.context': true });

const synchronousResult: string = record('sync-result', () => 'ok');
const asynchronousResult: Promise<number> = record('async-result', async () => 42);
void synchronousResult;
void asynchronousResult;
