import { type ParseClient, WorkerClient } from 'seyfert';

const client = new WorkerClient();

void client.start().catch(error => {
	client.logger.error(error);
	process.exitCode = 1;
});

declare module 'seyfert' {
	interface SeyfertRegistry {
		client: ParseClient<WorkerClient<true>>;
	}
}
