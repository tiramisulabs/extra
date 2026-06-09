import type { LoggerLike } from '@slipher/types';
import { Command, type CommandContext, createMiddleware, Declare, type Register } from 'seyfert';
import { createEvlogAdapter, type LoggerAdapter, logger, useLogger, type WideEventLogger } from '../src';

declare function expectType<T>(value: T): void;
declare const context: CommandContext;
const loggerPlugin = logger();

declare module 'seyfert' {
	interface Register {
		plugins: [typeof loggerPlugin];
	}
}

expectType<Register>({ plugins: [loggerPlugin] });
expectType<WideEventLogger>(context.logger);
expectType<LoggerLike>({} as WideEventLogger);

expectType<LoggerAdapter>(createEvlogAdapter());
// @ts-expect-error evlog drain/redact/enrich configuration belongs in initLogger()
createEvlogAdapter({ drain() {} });
expectType<WideEventLogger>(useLogger());

const auditMiddleware = createMiddleware<{ requestId: string }, CommandContext>(async ({ context, next }) => {
	context.logger.add({ requestId: 'request-1' });
	return next({ requestId: 'request-1' });
});

declare module 'seyfert' {
	interface RegisteredMiddlewares {
		audit: typeof auditMiddleware;
	}
}

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
