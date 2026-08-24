import { type Client, type CommandContext, definePlugins } from 'seyfert';
import { opentelemetry, record, type SignalFlags } from '../src';

const traces: SignalFlags = { cache: false, rest: true };
const metrics: SignalFlags = { cache: true, rest: true };
const plugins = definePlugins(opentelemetry({ serviceName: 'types-check', traces, metrics }));

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
