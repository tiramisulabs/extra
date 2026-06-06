import type {} from 'seyfert';
import type { RootLogger, WideEventLogger } from './index';

declare module 'seyfert' {
	interface Client<Ready extends boolean = boolean> {
		slipherLogger?: RootLogger;
	}

	interface HttpClient {
		slipherLogger?: RootLogger;
	}

	interface WorkerClient<Ready extends boolean = boolean> {
		slipherLogger?: RootLogger;
	}

	interface ExtendContext {
		logger: WideEventLogger;
	}

	interface UsingClient {
		slipherLogger?: RootLogger;
	}
}
