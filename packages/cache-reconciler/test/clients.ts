import { createMockBot } from '@slipher/testing';
import {
	type Adapter,
	type AnySeyfertPlugin,
	Client,
	createPlugin,
	definePlugins,
	PluginOrder,
	WorkerClient,
} from 'seyfert';
import { type CacheReconcilerManager, cacheReconciler, memoryCoordinator } from '../src';
import { type Dispatch, gatewayDispatch } from './support';

/** An interceptor registered after the reconciler's: it clones before the rest of the chain runs. */
export function innerCloner() {
	return createPlugin({
		name: 'inner-cloner',
		register(api) {
			api.gateway.onDispatch((packet, next) => next(structuredClone(packet)));
		},
	});
}

/** An interceptor that runs outside the reconciler's and swaps the payload after the whole chain resolved. */
export function outerCloner() {
	return createPlugin({
		name: 'outer-cloner',
		register(api) {
			api.gateway.onDispatch(
				async (_packet, next) => {
					const final = await next();
					return final ? structuredClone(final) : final;
				},
				{ order: PluginOrder.Before },
			);
		},
	});
}

export async function startBot(adapter: Adapter, ...plugins: AnySeyfertPlugin[]) {
	const client = new Client({ plugins: definePlugins(...plugins) });
	client.setServices({ cache: { adapter } });
	const bot = await createMockBot({ client });
	return { bot, client, dispatch: gatewayDispatch(bot) };
}

/** A started mock bot with the reconciler installed. `before` plugins register ahead of it, `after` behind it. */
export async function startReconciled(
	adapter: Adapter,
	plugins: { before?: AnySeyfertPlugin[]; after?: AnySeyfertPlugin[] } = {},
) {
	const started = await startBot(
		adapter,
		...(plugins.before ?? []),
		cacheReconciler({ coordinator: memoryCoordinator() }),
		...(plugins.after ?? []),
	);
	const manager: CacheReconcilerManager = started.client.cacheReconciler;
	return { ...started, manager };
}

/** A client whose own `start()` runs: it only reaches the network to build a ShardManager, which is preset. */
export function realClient(adapter: Adapter, ...plugins: AnySeyfertPlugin[]) {
	// `getRC` is how Seyfert's own tests supply a runtime config; it is not part of the typed client options.
	const runtimeConfig: object = {
		getRC: () => ({ token: 'token', intents: 0, debug: false, locations: { base: '.' } }),
	};
	const client = new Client({ plugins: definePlugins(...plugins), ...runtimeConfig });
	Reflect.set(client, 'gateway', { spawnShards: async () => undefined, values: () => [] });
	client.setServices({ cache: { adapter } });
	return client;
}

export function workerClient(adapter: Adapter, workerData: Record<string, unknown>, ...plugins: AnySeyfertPlugin[]) {
	const client = new WorkerClient({
		plugins: definePlugins(...plugins),
		postMessage: async () => undefined,
	} as never);
	client.setWorkerData({
		workerId: 0,
		shards: [0],
		intents: 1,
		totalShards: 1,
		mode: 'custom',
		...workerData,
	} as never);
	client.setServices({ cache: { adapter } });
	return client;
}

/** `client.cacheReconciler` for a client whose static type does not carry the plugin extension. */
export function managerOf(client: object): CacheReconcilerManager {
	return Reflect.get(client, 'cacheReconciler') as CacheReconcilerManager;
}

/**
 * Drives a client's packet path directly. WorkerClient and a client started through its own `start()` route
 * shard payloads through this protected method and expose no public entry without a socket.
 */
export function packetEntry(client: object, order: 'shard-first' | 'packet-first'): Dispatch {
	const onPacket = Reflect.get(client, 'onPacket') as (...args: unknown[]) => Promise<unknown>;
	return (packet, shardId = 0) =>
		order === 'shard-first' ? onPacket.call(client, shardId, packet) : onPacket.call(client, packet, shardId);
}
