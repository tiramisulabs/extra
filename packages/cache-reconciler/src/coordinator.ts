/** Coordination backend selected through `cacheReconciler({ coordinator })`. */
export interface CacheReconcilerCoordinator {
	/** `memory` coordinates a single process. */
	readonly kind: 'memory';
}

export function isCoordinator(value: unknown): value is CacheReconcilerCoordinator {
	return typeof value === 'object' && value !== null && Reflect.get(value, 'kind') === 'memory';
}
