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

	/**
	 * Resolves once no reconciliation work is pending: no guild packet is being reconciled, no sweep is running,
	 * and every shard that received READY committed its startup snapshot. It resolves immediately before the
	 * first READY. It does not time out: a READY guild Discord never delivers keeps it pending, so race it with
	 * your own deadline when the wait has to be bounded.
	 */
	waitForIdle(): Promise<void> {
		return this.#runtime.waitForIdle();
	}
}
