import {
	BaseResource,
	Client,
	createPlugin,
	type GatewayDispatchPayload,
	PluginOrder,
	type SeyfertPlugin,
	WorkerAdapter,
	WorkerClient,
} from 'seyfert';
import { ReconciledAdapter } from './adapter';
import { AdapterReconciliationController } from './adapter-controller';
import { installCacheOwnershipObserver } from './cache-ownership-observer';
import { bindCoordinator, type ReconciliationCoordinator } from './coordinator';
import { installDuplicateFilterObserver } from './duplicate-filter-observer';
import { ResourcePolicy } from './resource-policy';
import { SnapshotReconciler } from './snapshot-reconciler';
import { type CacheIntegrity, CacheIntegrityManager } from './state';

export interface CacheIntegrityOptions {
	coordinator: ReconciliationCoordinator;
}

export interface CacheIntegrityPlugin extends SeyfertPlugin<{ cacheIntegrity: CacheIntegrity }> {
	name: '@slipher/cache-integrity';
}

class CacheIntegrityObserver extends BaseResource {
	namespace = 'cacheIntegrityObserver';
}

function validateCoordinator(coordinator: ReconciliationCoordinator | undefined): ReconciliationCoordinator {
	if (!coordinator || typeof coordinator.start !== 'function' || typeof coordinator.close !== 'function') {
		throw new TypeError('cacheIntegrity() requires a coordinator with start() and close() methods.');
	}
	return coordinator;
}

function calculateClientShardId(client: object, guildId: string): number | undefined {
	if (client instanceof WorkerClient) return client.calculateShardId(guildId);
	if (client instanceof Client) {
		const gateway = client.gateway;
		const calculateShardId = gateway && Reflect.get(gateway, 'calculateShardId');
		return typeof calculateShardId === 'function' ? Reflect.apply(calculateShardId, gateway, [guildId]) : undefined;
	}
	throw new TypeError('@slipher/cache-integrity supports only Seyfert Client and WorkerClient instances.');
}

function adapterPhysicalKeyPrefix(adapter: object): string | undefined {
	try {
		const namespace = Reflect.get(adapter, 'namespace');
		const buildKey = Reflect.get(adapter, 'buildKey');
		if (typeof namespace !== 'string' || namespace.length === 0 || typeof buildKey !== 'function') return;
		const prefix = `${namespace}:`;
		const probe = 'cacheIntegrity.probe';
		const physicalProbe = `${prefix}${probe}`;
		return Reflect.apply(buildKey, adapter, [probe]) === physicalProbe &&
			Reflect.apply(buildKey, adapter, [physicalProbe]) === physicalProbe
			? prefix
			: undefined;
	} catch {
		return;
	}
}

export function cacheIntegrity(options: CacheIntegrityOptions): CacheIntegrityPlugin {
	const coordinator = validateCoordinator(options?.coordinator);
	const manager = new CacheIntegrityManager();
	let plugin: CacheIntegrityPlugin;

	plugin = createPlugin({
		name: '@slipher/cache-integrity',
		client: {
			cacheIntegrity: () => manager.facade,
		},
		register(api) {
			api.gateway.addIntents('Guilds');
			api.gateway.onDispatch((packet, next, { shardId }) => manager.intercept(packet, next, shardId), {
				order: PluginOrder.Before,
			});
			api.cache.resource('cacheIntegrityObserver', CacheIntegrityObserver, {
				intents: ['Guilds'],
				onPacket(event: GatewayDispatchPayload) {
					return manager.observePostCache(event);
				},
			});
		},
		setup(client) {
			const ownIndex = client.plugins.resolved.indexOf(plugin);
			const earlierInterceptor = client.plugins.diagnostics.find(
				diagnostic => diagnostic.index < ownIndex && diagnostic.gatewayDispatchInterceptors > 0,
			);
			if (ownIndex < 0 || earlierInterceptor) {
				const error = new TypeError(
					earlierInterceptor
						? `@slipher/cache-integrity must be the first resolved plugin that contributes gateway.onDispatch; ${earlierInterceptor.name} is earlier.`
						: '@slipher/cache-integrity could not prove its position in the resolved plugin list.',
				);
				manager.abortSetup(error);
				throw error;
			}

			const original = client.cache.adapter;
			if (original instanceof WorkerAdapter) {
				const error = new TypeError(
					'@slipher/cache-integrity cannot wrap Seyfert WorkerAdapter because its real cache store is owned by WorkerManager. Configure WorkerClient with a real adapter before start().',
				);
				manager.abortSetup(error);
				throw error;
			}

			const calculateShardId = (guildId: string) => calculateClientShardId(client, guildId);
			const policy = new ResourcePolicy(manager.state, calculateShardId, adapterPhysicalKeyPrefix(original));
			const controller = new AdapterReconciliationController(manager.state, {
				canonicalizeKey: key => policy.canonicalizeKey(key),
				isManagedRelationship: to => policy.isManagedRelationship(to),
				isManagedValue: key => policy.isManagedValue(key),
				resolveAdmission: (target, context) => policy.resolveAdmission(target, context),
			});
			let binding;
			try {
				binding = bindCoordinator(coordinator, {
					adapter: original,
					controller,
					onTerminal: (code, error) => manager.onCoordinatorFailure(code, error),
					state: manager.state,
				});
			} catch (error) {
				manager.abortSetup(error);
				throw error;
			}
			const wrapper = new ReconciledAdapter(
				original,
				coordinator,
				{
					beforeStart: () => manager.beforeStart(),
					onFailed: error => manager.onStartFailed(error),
					onStarted: () => manager.onStarted(),
				},
				controller,
				binding,
			);
			const engine = new SnapshotReconciler({
				adapter: wrapper,
				cache: client.cache,
				calculateShardId,
				controller,
				onFailure: (code, error) => manager.recordFailure(code, error),
				state: manager.state,
			});
			let duplicateFilters;
			try {
				duplicateFilters = installDuplicateFilterObserver(client, event => manager.observeDuplicateFilter(event));
				manager.prepare({
					cache: client.cache,
					controller,
					duplicateFilters,
					engine,
					installCacheOwnership: () =>
						installCacheOwnershipObserver(client.cache, controller, manager.state, calculateShardId),
					originalAdapter: original,
					coordinator: binding,
					wrappedAdapter: wrapper,
				});
				client.cache.adapter = wrapper;
			} catch (error) {
				duplicateFilters?.restore();
				if (client.cache.adapter === wrapper) client.cache.adapter = original;
				manager.abortSetup(error);
				throw error;
			}
		},
		teardown() {
			return manager.close();
		},
	}) as CacheIntegrityPlugin;

	return plugin;
}
