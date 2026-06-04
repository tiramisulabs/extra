import type {} from 'seyfert';
import type { QueuesRegistry } from './index';

declare module 'seyfert' {
	interface Client<Ready extends boolean = boolean> {
		queues?: QueuesRegistry;
	}

	interface HttpClient {
		queues?: QueuesRegistry;
	}

	interface WorkerClient<Ready extends boolean = boolean> {
		queues?: QueuesRegistry;
	}

	interface ExtendContext {
		queues: QueuesRegistry;
	}

	interface UsingClient {
		queues?: QueuesRegistry;
	}
}
