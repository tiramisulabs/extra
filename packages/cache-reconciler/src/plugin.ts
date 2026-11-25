import { createPlugin, type SeyfertPlugin } from 'seyfert';
import { type CacheReconcilerCoordinator, isCoordinator } from './coordinator';
import { CacheReconcilerManager } from './manager';
import { ReconcilerRuntime } from './runtime';

export interface CacheReconcilerOptions {
	/**
	 * Coordination backend: `memoryCoordinator()` for one process, or `redisCoordinator()` from
	 * `@slipher/cache-reconciler/coordinators/redis` for workers that share a Redis cache.
	 */
	coordinator: CacheReconcilerCoordinator;
}

export interface CacheReconcilerPlugin extends SeyfertPlugin<{ cacheReconciler: CacheReconcilerManager }> {
	name: '@slipher/cache-reconciler';
}

export function cacheReconciler(options: CacheReconcilerOptions): CacheReconcilerPlugin {
	const coordinator = options?.coordinator;
	if (!isCoordinator(coordinator)) {
		throw new TypeError(
			'@slipher/cache-reconciler requires a coordinator: pass memoryCoordinator() or redisCoordinator().',
		);
	}
	const runtime = new ReconcilerRuntime(coordinator);
	const manager = new CacheReconcilerManager(runtime);

	return createPlugin({
		name: '@slipher/cache-reconciler',
		client: {
			cacheReconciler: () => manager,
		},
		register(api) {
			runtime.register(api);
		},
		setup(client) {
			runtime.install(client);
		},
		teardown(client) {
			return runtime.uninstall(client);
		},
	}) as CacheReconcilerPlugin;
}
