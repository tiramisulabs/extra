import type { LoggerLike } from '@slipher/types';
import {
	type Client,
	Command,
	type CommandContext,
	createMiddleware,
	Declare,
	type HttpClient,
	type UsingClient,
	type WorkerClient,
} from 'seyfert';
import { createEvlogAdapter, type LoggerAdapter, type RootLogger, useLogger, type WideEventLogger } from '../src';

declare function expectType<T>(value: T): void;
declare const context: CommandContext;
declare const client: Client;
declare const httpClient: HttpClient;
declare const workerClient: WorkerClient;
declare const usingClient: UsingClient;

expectType<WideEventLogger>(context.logger);
expectType<RootLogger>(client.slipherLogger);
expectType<RootLogger>(httpClient.slipherLogger);
expectType<RootLogger>(workerClient.slipherLogger);
expectType<RootLogger>(usingClient.slipherLogger);
expectType<LoggerLike>({} as WideEventLogger);

expectType<LoggerAdapter>(createEvlogAdapter({ drain() {} }));
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
