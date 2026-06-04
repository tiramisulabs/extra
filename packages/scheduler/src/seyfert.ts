import type {} from 'seyfert';
import type { SchedulerRegistry } from './manager';

declare module 'seyfert' {
	interface Client<Ready extends boolean = boolean> {
		scheduler?: SchedulerRegistry;
	}

	interface HttpClient {
		scheduler?: SchedulerRegistry;
	}

	interface WorkerClient<Ready extends boolean = boolean> {
		scheduler?: SchedulerRegistry;
	}

	interface ExtendContext {
		scheduler: SchedulerRegistry;
	}

	interface UsingClient {
		scheduler?: SchedulerRegistry;
	}
}
