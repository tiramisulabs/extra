import type { ObservedWorker } from './types';

export function toError(error: unknown) {
	return error instanceof Error ? error : new Error(String(error));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Freeze at creation so every consumer can share the reference without defensive copies. */
export function freezeObserved(worker: ObservedWorker): ObservedWorker {
	return Object.freeze({
		...worker,
		identity: Object.freeze({ ...worker.identity }),
		topology: Object.freeze({ ...worker.topology }),
	});
}

export function positiveMs(value: number, name: string) {
	if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a positive number`);
	return value;
}

export function nonNegativeMs(value: number, name: string) {
	if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a non-negative number`);
	return value;
}

export function delay(milliseconds: number, signal?: AbortSignal) {
	if (signal?.aborted) return Promise.reject<void>(signal.reason);
	return new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			cleanup();
			resolve();
		}, milliseconds);
		const cleanup = () => signal?.removeEventListener('abort', onAbort);
		const onAbort = () => {
			clearTimeout(timeout);
			cleanup();
			reject(signal?.reason);
		};
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}
