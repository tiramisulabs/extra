import type {} from 'seyfert';
import type { WideEventLogger } from './core';

declare module 'seyfert' {
	interface ExtendContext {
		logger: WideEventLogger;
	}
}
