import type {} from 'seyfert';
import type { TraceHandle } from './handle';

/**
 * Fallback module augmentation for consumers that do not register plugins via
 * `SeyfertRegistry`. In seyfert v5, `Client` and `UsingClient` are type aliases
 * (not interfaces), so they cannot be merged here — they receive `trace` through
 * the plugin `client` map once the plugin is registered.
 */
declare module 'seyfert' {
	interface HttpClient {
		trace?: TraceHandle;
	}

	interface WorkerClient<Ready extends boolean = boolean> {
		trace?: TraceHandle;
	}

	interface ExtendContext {
		trace?: TraceHandle;
	}
}
