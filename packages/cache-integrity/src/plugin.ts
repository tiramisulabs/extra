import { createPlugin, type SeyfertPlugin, WorkerAdapter } from 'seyfert';
import { ProcessGenerationAdapter } from './adapter';

export interface CacheIntegrityPlugin extends SeyfertPlugin {
	name: '@slipher/cache-integrity';
}

export function cacheIntegrity(): CacheIntegrityPlugin {
	let original: ProcessGenerationAdapter['inner'] | undefined;
	let wrapper: ProcessGenerationAdapter | undefined;

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
			wrapper = new ProcessGenerationAdapter(original);
			client.cache.adapter = wrapper;
		},
		teardown(client) {
			if (client.cache.adapter === wrapper && original) client.cache.adapter = original;
			original = undefined;
			wrapper = undefined;
		},
	}) as CacheIntegrityPlugin;
}
