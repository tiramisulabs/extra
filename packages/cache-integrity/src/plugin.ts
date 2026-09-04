import { createPlugin, type SeyfertPlugin, WorkerAdapter } from 'seyfert';
import { CacheIntegrityAdapter } from './adapter';

export interface CacheIntegrityOptions {
	/** Maximum age, in milliseconds, accepted for persisted values read by explicit key. */
	maxAge: number;
}

export interface CacheIntegrityPlugin extends SeyfertPlugin {
	name: '@slipher/cache-integrity';
}

export function cacheIntegrity(options: CacheIntegrityOptions): CacheIntegrityPlugin {
	const maxAge = options?.maxAge;
	if (!Number.isFinite(maxAge) || maxAge <= 0) {
		throw new TypeError('@slipher/cache-integrity maxAge must be a positive finite number.');
	}

	let original: CacheIntegrityAdapter['inner'] | undefined;
	let wrapper: CacheIntegrityAdapter | undefined;

	return createPlugin({
		name: '@slipher/cache-integrity',
		setup(client) {
			original = client.cache.adapter;
			if (original instanceof WorkerAdapter) {
				original = undefined;
				throw new TypeError(
					'@slipher/cache-integrity cannot wrap WorkerAdapter because Seyfert resolves worker cache responses through the adapter instance installed on the client.',
				);
			}
			wrapper = new CacheIntegrityAdapter(original, maxAge);
			client.cache.adapter = wrapper;
		},
		teardown(client) {
			if (client.cache.adapter === wrapper && original) client.cache.adapter = original;
			original = undefined;
			wrapper = undefined;
		},
	}) as CacheIntegrityPlugin;
}
