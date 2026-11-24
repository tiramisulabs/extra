import type { CacheReconcilerStatus, ReconcilerRuntime } from './runtime';

/** Observability surface exposed as `client.cacheReconciler`. It offers no way to mutate the cache. */
export class CacheReconcilerManager {
	readonly #runtime: ReconcilerRuntime;

	/** @internal */
	constructor(runtime: ReconcilerRuntime) {
		this.#runtime = runtime;
	}

	status(): CacheReconcilerStatus {
		return this.#runtime.status();
	}

	/** Resolves once no reconciliation work is pending. */
	waitForIdle(): Promise<void> {
		return this.#runtime.waitForIdle();
	}
}
