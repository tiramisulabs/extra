import type { RedisClientType } from '@redis/client';
import type { RedisAdapter } from '@slipher/redis-adapter';
import { Client, definePlugins, type PluginUsingClient, type SeyfertPlugin } from 'seyfert';
import * as root from '../src';
import {
	type CacheReconcilerAdapterStatus,
	type CacheReconcilerCoordinator,
	type CacheReconcilerManager,
	type CacheReconcilerOptions,
	type CacheReconcilerPlugin,
	type CacheReconcilerStatus,
	cacheReconciler,
	type GuildOutcome,
	type ManagerLifecycle,
	memoryCoordinator,
	type ReconcilerFailure,
	type ReconcilerFailureKind,
	type ShardSnapshot,
	type ShardStartup,
	type StateSnapshot,
} from '../src';
import { type RedisCoordinatorOptions, redisCoordinator } from '../src/coordinators/redis';

/**
 * Compile-time contract of the public surface. Nothing here runs: `pnpm typecheck` is the test.
 *
 * It deliberately does not augment `SeyfertRegistry`, which would change the client type of every other file in
 * this test project. The plugin tuple carries the extension on its own, and `PluginUsingClient` is that extension
 * on any client class, which is how a `WorkerClient` gets it.
 */
declare function expectType<T>(value: T): void;
/** Compiles only when both types are exactly the same, so `any` or an extra member cannot slip through. */
declare function expectSame<A, B>(
	...mismatch: (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? [] : [never]
): void;
declare const redis: RedisClientType;
declare const adapter: RedisAdapter;

const plugin = cacheReconciler({ coordinator: memoryCoordinator() });
const plugins = definePlugins(plugin);
const client = new Client({ plugins });
declare const usingClient: PluginUsingClient<typeof plugins>;

expectType<SeyfertPlugin>(plugin);
expectType<CacheReconcilerPlugin>(plugin);
expectType<'@slipher/cache-reconciler'>(plugin.name);
expectType<readonly [CacheReconcilerPlugin]>(plugins);
expectType<(options: CacheReconcilerOptions) => CacheReconcilerPlugin>(cacheReconciler);

// `client.cacheReconciler` exists wherever the plugin is installed, and nowhere else.
expectType<CacheReconcilerManager>(client.cacheReconciler);
expectType<CacheReconcilerManager>(usingClient.cacheReconciler);
// @ts-expect-error a client without the plugin has no manager
new Client().cacheReconciler;

// The manager is observability only: these two methods and nothing else.
expectSame<keyof CacheReconcilerManager, 'status' | 'waitForIdle'>();
expectSame<ReturnType<CacheReconcilerManager['waitForIdle']>, Promise<void>>();
expectSame<ReturnType<CacheReconcilerManager['status']>, CacheReconcilerStatus>();
expectSame<Parameters<CacheReconcilerManager['status']>, []>();
expectSame<Parameters<CacheReconcilerManager['waitForIdle']>, []>();
expectSame<keyof CacheReconcilerOptions, 'coordinator'>();
expectSame<CacheReconcilerCoordinator['kind'], 'memory' | 'redis'>();
expectSame<CacheReconcilerStatus['coordinator'], 'memory' | 'redis'>();
expectSame<CacheReconcilerAdapterStatus, 'pending' | 'installed' | 'replaced' | 'restored'>();
expectSame<ManagerLifecycle, 'installing' | 'active' | 'closing' | 'closed' | 'failed'>();
expectSame<ShardStartup, 'awaiting-ready' | 'awaiting-guilds' | 'committed'>();
expectSame<GuildOutcome, 'reconciled' | 'unavailable-preserved' | 'deleted' | 'failed'>();
expectSame<keyof RedisCoordinatorOptions, 'client' | 'cacheNamespace' | 'namespace' | 'leaseTtl'>();

expectType<Promise<void>>(client.cacheReconciler.waitForIdle());
const status = client.cacheReconciler.status();
expectType<CacheReconcilerStatus>(status);
expectType<StateSnapshot>(status);
expectType<'memory' | 'redis'>(status.coordinator);
expectType<CacheReconcilerAdapterStatus>(status.adapter);
expectType<ManagerLifecycle>(status.lifecycle);
expectType<boolean>(status.idle);
expectType<{ guilds: number; deletions: number; tasks: number }>(status.pending);
expectType<ShardSnapshot[]>(status.shards);
expectType<ShardStartup>(status.shards[0]!.startup);
expectType<Record<GuildOutcome, number>>(status.shards[0]!.outcomes);
expectType<ReconcilerFailure[]>(status.failures);
expectType<ReconcilerFailureKind>(status.failures[0]!.kind);
expectType<number>(status.failureCount);

// @ts-expect-error the manager cannot remove anything
client.cacheReconciler.sweep();
// @ts-expect-error the manager cannot flush the cache
client.cacheReconciler.flush();
// @ts-expect-error the runtime behind the manager is not reachable
client.cacheReconciler.runtime;

// The root entry point offers the in-process coordinator. Redis lives on its own subpath.
expectType<CacheReconcilerCoordinator>(memoryCoordinator());
// @ts-expect-error the root entry point does not export the Redis coordinator
root.redisCoordinator;

const redisOptions: RedisCoordinatorOptions = {
	client: adapter.client,
	cacheNamespace: adapter.namespace,
	namespace: `${adapter.namespace}:reconciler`,
};
expectType<CacheReconcilerCoordinator>(redisCoordinator(redisOptions));
expectType<CacheReconcilerPlugin>(
	cacheReconciler({ coordinator: redisCoordinator({ ...redisOptions, client: redis }) }),
);

// @ts-expect-error a coordinator is required
cacheReconciler();
// @ts-expect-error a coordinator is required
cacheReconciler({});
// @ts-expect-error the coordinator is created by its factory, not named
cacheReconciler({ coordinator: 'memory' });
// @ts-expect-error nor described: the published type carries `bind`, so a bare `kind` is not a coordinator
cacheReconciler({ coordinator: { kind: 'memory' } });
// @ts-expect-error an adapter is not a coordinator
cacheReconciler({ coordinator: adapter });
// @ts-expect-error there is no maxAge option
cacheReconciler({ coordinator: memoryCoordinator(), maxAge: 60_000 });
// @ts-expect-error the plugin makes no REST calls, so there is nothing to configure about them
cacheReconciler({ coordinator: memoryCoordinator(), fetch: true });
// @ts-expect-error memoryCoordinator takes no options
memoryCoordinator({ namespace: 'cache' });
// @ts-expect-error the Redis coordinator needs the adapter's client
redisCoordinator({ cacheNamespace: 'cache', namespace: 'cache:reconciler' });
// @ts-expect-error the Redis coordinator needs the cache namespace
redisCoordinator({ client: redis, namespace: 'cache:reconciler' });
// @ts-expect-error the Redis coordinator needs its own namespace
redisCoordinator({ client: redis, cacheNamespace: 'cache' });
// @ts-expect-error the coordinator never connects, so it takes no connection options
redisCoordinator({ ...redisOptions, url: 'redis://localhost' });
