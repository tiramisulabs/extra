import { createMockBot } from '@slipher/testing';
import {
	type Adapter,
	type AdapterEntry,
	type AdapterRelationship,
	type AnySeyfertPlugin,
	BaseResource,
	CacheFrom,
	Client,
	createPlugin,
	definePlugins,
	MemoryAdapter,
	PluginOrder,
	WorkerAdapter,
	WorkerClient,
} from 'seyfert';
import { describe, expect, it } from 'vitest';
import { cacheReconciler, memoryCoordinator } from '../src';
import { ReconciledAdapter } from '../src/adapter';
import { PacketCorrelation } from '../src/correlation';
import { BOT_ID, deferred, gatewayDispatch, guildPacket, readyPacket } from './support';

class ProbeResource extends BaseResource {
	namespace = 'reconciler_probe';
}

/** Records how many times the backing adapter was started. */
class CountingAdapter extends MemoryAdapter<unknown> {
	starts = 0;

	override start() {
		this.starts++;
	}
}

/** Async adapter whose `bulkPatch` calls can be held open to reorder completion. */
class GatedAdapter implements Adapter {
	readonly isAsync = true;
	readonly memory = new MemoryAdapter();
	readonly patchGates: Promise<void>[] = [];

	async start() {}
	async scan(query: string, keys?: boolean) {
		return this.memory.scan(query, keys as true);
	}
	async bulkGet(keys: string[]) {
		return this.memory.bulkGet(keys);
	}
	async get(key: string) {
		return this.memory.get(key);
	}
	async bulkSet(entries: AdapterEntry[]) {
		this.memory.bulkSet(entries);
	}
	async set(key: string, value: unknown, relationship: AdapterRelationship) {
		this.memory.set(key, value, relationship);
	}
	async bulkPatch(entries: AdapterEntry[]) {
		await this.patchGates.shift();
		this.memory.bulkPatch(entries);
	}
	async patch(key: string, value: unknown, relationship: AdapterRelationship) {
		this.memory.patch(key, value, relationship);
	}
	async values(to: string) {
		return this.memory.values(to);
	}
	async keys(to: string) {
		return this.memory.keys(to);
	}
	async count(to: string) {
		return this.memory.count(to);
	}
	async bulkRemove(keys: string[]) {
		this.memory.bulkRemove(keys);
	}
	async remove(key: string) {
		this.memory.remove(key);
	}
	async flush() {
		this.memory.flush();
	}
	async contains(to: string, key: string) {
		return this.memory.contains(to, key);
	}
	async getToRelationship(to: string) {
		return this.memory.getToRelationship(to);
	}
	async removeToRelationship(to: string, keys: string | string[]) {
		this.memory.removeToRelationship(to, keys);
	}
	async removeRelationship(to: string | string[]) {
		this.memory.removeRelationship(to);
	}
}

interface Observation {
	s: number;
	shardId: number;
}

interface CorrelationLog {
	resolved: (Observation | undefined)[];
	/** Groups of pending entries the correlation refused to choose between. */
	ambiguous: Observation[][];
}

/**
 * Wires `PacketCorrelation` the way the reconciler does: track before core cache in the Gateway interceptor,
 * follow the final payload returned by `next()`, resolve from the plugin cache resource.
 */
function correlationProbe(event: string, log: CorrelationLog) {
	const correlation = new PacketCorrelation<Observation>();
	return createPlugin({
		name: 'correlation-probe',
		register(api) {
			api.gateway.onDispatch(
				async (packet, next, meta) => {
					if (packet.t !== event) return;
					const payload = packet.d as { id: string };
					const entry = { s: packet.s, shardId: meta.shardId };
					correlation.track(payload, event, payload.id, entry);
					const final = await next();
					if (final) correlation.retarget(final.d, entry);
				},
				{ order: PluginOrder.Before },
			);
			api.cache.resource('reconcilerProbe', ProbeResource, {
				onPacket(packet) {
					if (packet.t !== event) return;
					const payload = packet.d as { id: string };
					const entry = correlation.resolve(payload, event, payload.id);
					log.resolved.push(entry);
					if (entry) {
						correlation.release(event, payload.id, entry);
						return;
					}
					const lost = correlation.ambiguous(event, payload.id);
					if (lost.length) log.ambiguous.push(lost);
					for (const pending of lost) correlation.release(event, payload.id, pending);
				},
			});
		},
	});
}

function correlationLog(): CorrelationLog {
	return { resolved: [], ambiguous: [] };
}

/** An interceptor registered after the reconciler's: it clones before the rest of the chain runs. */
function innerCloner() {
	return createPlugin({
		name: 'inner-cloner',
		register(api) {
			api.gateway.onDispatch((packet, next) => next(structuredClone(packet)));
		},
	});
}

/** An interceptor that runs outside the reconciler's and swaps the payload after the whole chain resolved. */
function outerCloner() {
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

async function startBot(adapter: Adapter, ...plugins: AnySeyfertPlugin[]) {
	const client = new Client({ plugins: definePlugins(...plugins) });
	client.setServices({ cache: { adapter } });
	const bot = await createMockBot({ client });
	return { bot, client, dispatch: gatewayDispatch(bot) };
}

/** A client whose own `start()` runs: it only reaches the network to build a ShardManager, which is preset. */
function realClient(adapter: Adapter, ...plugins: AnySeyfertPlugin[]) {
	// `getRC` is how Seyfert's own tests supply a runtime config; it is not part of the typed client options.
	const runtimeConfig: object = {
		getRC: () => ({ token: 'token', intents: 0, debug: false, locations: { base: '.' } }),
	};
	const client = new Client({ plugins: definePlugins(...plugins), ...runtimeConfig });
	Reflect.set(client, 'gateway', { spawnShards: async () => undefined });
	client.setServices({ cache: { adapter } });
	return client;
}

function workerClient(adapter: Adapter, workerData: Record<string, unknown>, ...plugins: AnySeyfertPlugin[]) {
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

const guild = { id: '100', name: 'guild', roles: [{ id: '101', name: 'role' }] };

describe('feasibility on public Seyfert APIs', () => {
	it('installs the wrapper in setup, before the backing adapter starts, and starts it exactly once', async () => {
		const original = new CountingAdapter();
		const atReady: { wrapped: boolean; starts: number }[] = [];
		const observer = createPlugin({
			name: 'ready-observer',
			register(api) {
				api.hooks.on('plugins:ready', client => {
					atReady.push({ wrapped: client.cache.adapter instanceof ReconciledAdapter, starts: original.starts });
				});
			},
		});
		const client = realClient(original, cacheReconciler({ coordinator: memoryCoordinator() }), observer);

		await client.start({}, false);

		expect(atReady).toEqual([{ wrapped: true, starts: 0 }]);
		expect((client.cache.adapter as ReconciledAdapter).inner).toBe(original);
		expect(original.starts).toBe(1);
		expect(client.cacheReconciler.status()).toEqual({ coordinator: 'memory', adapter: 'installed' });

		await client.close();
		expect(client.cache.adapter).toBe(original);
		expect(original.starts).toBe(1);
	});

	it('cache resources resolve the adapter on every call instead of capturing it', async () => {
		const original = new MemoryAdapter();
		const { bot, client } = await startBot(original, cacheReconciler({ coordinator: memoryCoordinator() }));
		const users = client.cache.users!;
		const wrapper = client.cache.adapter;

		expect(users.adapter).toBe(wrapper);
		await users.set(CacheFrom.Test, '7', { id: '7', username: 'user' } as never);
		expect(original.get('user.7')).toMatchObject({ id: '7' });

		// The same resource instance follows the adapter once the wrapper is gone.
		await bot.close();
		expect(users.adapter).toBe(original);
	});

	it('the interceptor sees packet.s and shardId before core cache, and rawGuildCreate listeners run after it', async () => {
		const original = new MemoryAdapter();
		const order: string[] = [];
		const probe = createPlugin({
			name: 'order-probe',
			register(api) {
				api.gateway.onDispatch(
					async (packet, next, meta) => {
						if (packet.t === 'RAW_GUILD_CREATE') {
							order.push(`interceptor s=${packet.s} shard=${meta.shardId} cached=${original.get('role.101') !== null}`);
						}
						await next();
						if (packet.t === 'RAW_GUILD_CREATE')
							order.push(`next-resolved cached=${original.get('role.101') !== null}`);
					},
					{ order: PluginOrder.Before },
				);
				api.cache.resource('reconcilerProbe', ProbeResource, {
					onPacket(packet) {
						if (packet.t !== 'RAW_GUILD_CREATE') return;
						order.push(`resource has-s=${'s' in packet} cached=${original.get('role.101') !== null}`);
					},
				});
				api.events.on('RAW_GUILD_CREATE', (_guild, _client, shardId) => {
					order.push(`listener shard=${shardId} cached=${original.get('role.101') !== null}`);
				});
			},
		});
		const { bot, dispatch } = await startBot(original, probe);

		await dispatch(guildPacket('RAW_GUILD_CREATE', 7, guild), 3);

		expect(order).toEqual([
			'interceptor s=7 shard=3 cached=false',
			// next() only advances the interceptor chain; core cache has not run yet.
			'next-resolved cached=false',
			'resource has-s=false cached=true',
			'listener shard=3 cached=true',
		]);
		await bot.close();
	});

	it('payload identity reaches the plugin cache resource but not a transformed event listener', async () => {
		const seen = new WeakSet<object>();
		const hits: string[] = [];
		const probe = createPlugin({
			name: 'identity-probe',
			register(api) {
				api.gateway.onDispatch(
					async (packet, next) => {
						if (packet.t === 'RAW_GUILD_CREATE') seen.add(packet.d);
						await next();
					},
					{ order: PluginOrder.Before },
				);
				api.cache.resource('reconcilerProbe', ProbeResource, {
					onPacket(packet) {
						if (packet.t === 'RAW_GUILD_CREATE') hits.push(`resource ${seen.has(packet.d)}`);
					},
				});
				api.events.on('RAW_GUILD_CREATE', structure => {
					hits.push(`listener ${seen.has(structure)}`);
				});
			},
		});
		const { bot, dispatch } = await startBot(new MemoryAdapter(), probe);

		await dispatch(guildPacket('RAW_GUILD_CREATE', 2, guild));

		expect(hits).toEqual(['resource true', 'listener false']);
		await bot.close();
	});

	it('follows a later interceptor that clones the packet and its payload', async () => {
		const log = correlationLog();
		const { bot, dispatch } = await startBot(new MemoryAdapter(), correlationProbe('GUILD_UPDATE', log), innerCloner());

		await dispatch(guildPacket('GUILD_UPDATE', 11, guild), 2);

		expect(log).toEqual({ resolved: [{ s: 11, shardId: 2 }], ambiguous: [] });
		await bot.close();
	});

	it('uses the structured key when an earlier interceptor swaps the payload after the chain', async () => {
		const log = correlationLog();
		const { bot, dispatch } = await startBot(new MemoryAdapter(), outerCloner(), correlationProbe('GUILD_UPDATE', log));

		await dispatch(guildPacket('GUILD_UPDATE', 12, guild), 4);

		expect(log).toEqual({ resolved: [{ s: 12, shardId: 4 }], ambiguous: [] });
		await bot.close();
	});

	it.each([
		['with the original payloads', false],
		['through a cloning interceptor', true],
	])('keeps overlapping packets for the same guild apart when cache work completes in reverse order %s', async (_label, clone) => {
		const adapter = new GatedAdapter();
		const log = correlationLog();
		const plugins = clone
			? [correlationProbe('GUILD_UPDATE', log), innerCloner()]
			: [correlationProbe('GUILD_UPDATE', log)];
		const { bot, dispatch } = await startBot(adapter, ...plugins);
		const firstWrite = deferred();
		adapter.patchGates.push(firstWrite.promise);

		// Each Gateway packet is parsed into its own payload object.
		const first = dispatch(guildPacket('GUILD_UPDATE', 20, { ...guild }));
		const second = dispatch(guildPacket('GUILD_UPDATE', 21, { ...guild }));
		await second;
		expect(log.resolved).toEqual([{ s: 21, shardId: 0 }]);

		firstWrite.resolve();
		await first;
		expect(log).toEqual({
			resolved: [
				{ s: 21, shardId: 0 },
				{ s: 20, shardId: 0 },
			],
			ambiguous: [],
		});
		await bot.close();
	});

	it('refuses to pair overlapping same-guild packets once their payload identity is lost', async () => {
		const adapter = new GatedAdapter();
		const log = correlationLog();
		const { bot, dispatch } = await startBot(adapter, outerCloner(), correlationProbe('GUILD_UPDATE', log));
		const firstWrite = deferred();
		adapter.patchGates.push(firstWrite.promise);

		const first = dispatch(guildPacket('GUILD_UPDATE', 20, { ...guild }));
		const second = dispatch(guildPacket('GUILD_UPDATE', 21, { ...guild }));
		await second;
		firstWrite.resolve();
		await first;

		// The packet that finished first cannot be told apart, so neither is resolved by completion order.
		expect(log).toEqual({
			resolved: [undefined, undefined],
			ambiguous: [
				[
					{ s: 20, shardId: 0 },
					{ s: 21, shardId: 0 },
				],
			],
		});
		await bot.close();
	});
});

describe('installation', () => {
	it('requires a coordinator', () => {
		expect(() => cacheReconciler(undefined as never)).toThrow('requires a coordinator');
		expect(() => cacheReconciler({ coordinator: {} as never })).toThrow('requires a coordinator');
	});

	it('refuses WorkerAdapter before replacing it', async () => {
		const original = new WorkerAdapter({} as never);
		const client = new Client({ plugins: definePlugins(cacheReconciler({ coordinator: memoryCoordinator() })) });
		client.setServices({ cache: { adapter: original } });

		await expect(createMockBot({ client })).rejects.toThrow('cannot wrap WorkerAdapter');
		expect(client.cache.adapter).toBe(original);
		expect(client.cacheReconciler.status().adapter).toBe('pending');
	});

	it('keeps a WorkerClient that owns a real adapter viable through its own packet path', async () => {
		const original = new MemoryAdapter();
		const log = correlationLog();
		const client = workerClient(
			original,
			{},
			cacheReconciler({ coordinator: memoryCoordinator() }),
			correlationProbe('GUILD_UPDATE', log),
		);
		const bot = await createMockBot({ client: client as never });
		// WorkerClient routes shard payloads through this protected method; it has no public entry without a socket.
		const onPacket = Reflect.get(client, 'onPacket') as (packet: unknown, shardId: number) => Promise<unknown>;

		await onPacket.call(client, readyPacket({ guilds: [] }), 0);
		await onPacket.call(client, guildPacket('GUILD_UPDATE', 2, guild), 0);

		expect(client.cache.adapter).toBeInstanceOf(ReconciledAdapter);
		expect(original.get(`user.${BOT_ID}`)).toMatchObject({ id: BOT_ID });
		expect(original.get('role.101')).toMatchObject({ id: '101' });
		expect(log).toEqual({ resolved: [{ s: 2, shardId: 0 }], ambiguous: [] });
		await bot.close();
		expect(client.cache.adapter).toBe(original);
	});

	it('refuses a hot-reload replacement worker before replacing its adapter', async () => {
		const original = new MemoryAdapter();
		const client = workerClient(original, { hotReload: true }, cacheReconciler({ coordinator: memoryCoordinator() }));

		try {
			await expect(createMockBot({ client: client as never })).rejects.toThrow('hotReload replacement workers');
			expect(client.cache.adapter).toBe(original);
		} finally {
			// Worker data is module state inside Seyfert, shared by every WorkerClient in this process.
			client.setWorkerData({ workerId: 0, shards: [0], intents: 1, totalShards: 1, mode: 'custom' } as never);
		}
	});

	it('restores the exact original adapter on teardown', async () => {
		const original = new MemoryAdapter();
		const { bot, client } = await startBot(original, cacheReconciler({ coordinator: memoryCoordinator() }));

		await bot.close();

		expect(client.cache.adapter).toBe(original);
		expect(client.cacheReconciler.status().adapter).toBe('restored');
	});

	it('reports an adapter replaced after setup and never clobbers it', async () => {
		const { bot, client } = await startBot(new MemoryAdapter(), cacheReconciler({ coordinator: memoryCoordinator() }));
		const replacement = new MemoryAdapter();
		client.cache.adapter = replacement;

		expect(client.cacheReconciler.status().adapter).toBe('replaced');
		const diagnostics = client.plugins.diagnostics.flatMap(plugin => plugin.messages);
		expect(diagnostics).toContainEqual(expect.objectContaining({ code: 'cache-reconciler-adapter-replaced' }));

		await bot.close();
		expect(client.cache.adapter).toBe(replacement);
		expect(client.cacheReconciler.status().adapter).toBe('replaced');
	});

	it('exposes only observability on client.cacheReconciler', async () => {
		const { bot, client } = await startBot(new MemoryAdapter(), cacheReconciler({ coordinator: memoryCoordinator() }));
		const manager = client.cacheReconciler;

		expect(Object.getOwnPropertyNames(Object.getPrototypeOf(manager)).sort()).toEqual([
			'constructor',
			'status',
			'waitForIdle',
		]);
		expect(Object.keys(manager)).toEqual([]);
		await bot.close();
	});
});

describe('ReconciledAdapter increment capability', () => {
	it('mirrors whether the backing adapter can increment, including a capability learned at start', async () => {
		const fixed = new ReconciledAdapter(new MemoryAdapter());
		expect(fixed.increment).toBeTypeOf('function');

		const late = new GatedAdapter() as GatedAdapter & { increment?: Adapter['increment'] };
		late.start = async () => {
			late.increment = async () => 5;
		};
		const wrapper = new ReconciledAdapter(late);
		expect(wrapper.increment).toBeUndefined();

		await wrapper.start();
		expect(await wrapper.increment!('guild.1', 'member_count', 1)).toBe(5);
	});
});
