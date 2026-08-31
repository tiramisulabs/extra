import type { RedisAdapter } from '@slipher/redis-adapter';
import type { Client, PluginUsingClient } from 'seyfert';
import { definePlugins } from 'seyfert';
import { type CacheIntegrity, type CacheIntegrityStatus, cacheIntegrity, localCoordinator } from '../src';
import { type RedisCoordinator, type RedisCoordinatorOptions, redisCoordinator } from '../src/coordinators/redis';

declare function expectType<T>(value: T): void;

const reconciler = cacheIntegrity({ coordinator: localCoordinator() });
const plugins = definePlugins(reconciler);
declare const client: Client<typeof plugins>;
declare const pluginClient: PluginUsingClient<typeof plugins>;
declare const redisClient: RedisAdapter['client'];

const redisOptions = {
	cacheNamespace: 'bot-cache',
	client: redisClient,
	namespace: 'bot-cache-integrity',
} satisfies RedisCoordinatorOptions;
const distributed = redisCoordinator(redisOptions);

expectType<CacheIntegrity>(client.cacheIntegrity);
expectType<CacheIntegrity>(pluginClient.cacheIntegrity);
expectType<CacheIntegrityStatus>(client.cacheIntegrity.status());
expectType<Promise<void>>(client.cacheIntegrity.waitForIdle());
expectType<RedisCoordinator>(distributed);

// @ts-expect-error lifecycle mutation is intentionally not public
client.cacheIntegrity.close();
// @ts-expect-error the concrete manager is intentionally not exposed by the plugin
reconciler.manager;

// @ts-expect-error a coordinator is required
cacheIntegrity({});
// @ts-expect-error unknown options are not part of the public contract
cacheIntegrity({ coordinator: localCoordinator(), flushOnStart: true });

// @ts-expect-error the cache namespace is part of the pinned RedisAdapter contract
redisCoordinator({ client: redisClient, namespace: 'bot-cache-integrity' });
// @ts-expect-error coordinator internals are not public configuration
redisCoordinator({ ...redisOptions, reconnect: true });
