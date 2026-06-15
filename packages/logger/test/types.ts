import type { LoggerLike } from '@slipher/types';
import type { Client, PluginContextMapOf, RegisteredPlugins, Logger as SeyfertLogger } from 'seyfert';
import { Command, type CommandContext, createMiddleware, Declare, definePlugins } from 'seyfert';
import { createEvlogAdapter, type LoggerAdapter, logger, useLogger, type WideEventLogger } from '../src';

declare function expectType<T>(value: T): void;
declare const context: CommandContext;
declare const client: Client;
const loggerPlugin = logger();
const plugins = definePlugins(loggerPlugin);

const auditMiddleware = createMiddleware<{ requestId: string }, CommandContext>(async ({ context, next }) => {
	context.logger.add({ requestId: 'request-1' });
	return next({ requestId: 'request-1' });
});

declare module 'seyfert' {
	interface SeyfertRegistry {
		plugins: typeof plugins;
		middlewares: { audit: typeof auditMiddleware };
	}
}

expectType<RegisteredPlugins>(plugins);
expectType<WideEventLogger>(context.logger);
expectType<WideEventLogger>({} as PluginContextMapOf<typeof plugins>['logger']);
expectType<SeyfertLogger>(client.logger);
// @ts-expect-error client.logger remains Seyfert's base logger; use ctx.logger or useLogger() for wide events.
expectType<WideEventLogger>(client.logger);
expectType<LoggerLike>({} as WideEventLogger);

expectType<LoggerAdapter>(createEvlogAdapter());
// @ts-expect-error evlog drain/redact/enrich configuration belongs in initLogger()
createEvlogAdapter({ drain() {} });
expectType<WideEventLogger>(useLogger());

@Declare({
	name: 'deploy',
	description: 'Deploy the current project',
})
class DeployCommand extends Command {
	async run(context: CommandContext<{}, 'audit'>) {
		context.logger.info('deployment queued');
		expectType<string>(context.metadata.audit.requestId);
	}
}

void DeployCommand;
