import { AsyncLocalStorage } from 'node:async_hooks';

export interface DispatchContext {
	readonly dispatchId: number;
	componentCommandExecuted: boolean;
	collectorMatched: boolean;
	modalMatched: boolean;
	resolveDenial?: () => void;
}

export const dispatchStore = new AsyncLocalStorage<DispatchContext>();

let nextId = 1;

export function nextDispatchId(): number {
	return nextId++;
}

export function resetDispatchIds(): void {
	nextId = 1;
}
