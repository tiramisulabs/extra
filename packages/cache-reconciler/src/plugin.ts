import { createPlugin, type SeyfertPlugin } from 'seyfert';
import { type CacheReconcilerCoordinator, isCoordinator } from './coordinator';
import { CacheReconcilerManager } from './manager';
import { ReconcilerRuntime } from './runtime';

export interface CacheReconcilerOptions {
	/** Coordination backend. `memoryCoordinator()` coordinates one process. */
	coordinator: CacheReconcilerCoordinator;
}

export interface CacheReconcilerPlugin extends SeyfertPlugin<{ cacheReconciler: CacheReconcilerManager }> {
	name: '@slipher/cache-reconciler';
}

export function cacheReconciler(options: CacheReconcilerOptions): CacheReconcilerPlugin {
	const coordinator = options?.coordinator;
	if (!isCoordinator(coordinator)) {
		throw new TypeError('@slipher/cache-reconciler requires a coordinator, such as memoryCoordinator().');
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
