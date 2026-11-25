import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { createMockBot } from '@slipher/testing';
import {
	BaseResource,
	CacheFrom,
	Client,
	createPlugin,
	definePlugins,
	MemoryAdapter,
	PluginOrder,
	WorkerAdapter,
} from 'seyfert';
import { describe, expect, it } from 'vitest';
import { cacheReconciler, memoryCoordinator } from '../src';
import { ReconciledAdapter } from '../src/adapter';
import { PacketCorrelation } from '../src/correlation';
import { innerCloner, outerCloner, packetEntry, realClient, startBot, workerClient } from './clients';
import { AsyncAdapter, BOT_ID, deferred, guildPacket, readyPacket } from './support';

const SOURCE = resolve(__dirname, '../src');

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
		expect(client.cacheReconciler.status()).toMatchObject({
			coordinator: 'memory',
			adapter: 'installed',
			lifecycle: 'active',
		});

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
		const adapter = new AsyncAdapter();
		const log = correlationLog();
		const plugins = clone
			? [correlationProbe('GUILD_UPDATE', log), innerCloner()]
			: [correlationProbe('GUILD_UPDATE', log)];
		const { bot, dispatch } = await startBot(adapter, ...plugins);
		const firstWrite = deferred();
		adapter.gate('bulkPatch', firstWrite.promise);

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
		const adapter = new AsyncAdapter();
		const log = correlationLog();
		const { bot, dispatch } = await startBot(adapter, outerCloner(), correlationProbe('GUILD_UPDATE', log));
		const firstWrite = deferred();
		adapter.gate('bulkPatch', firstWrite.promise);

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
		const dispatch = packetEntry(client, 'packet-first');

		await dispatch(readyPacket({ guilds: [] }));
		await dispatch(guildPacket('GUILD_UPDATE', 2, guild));

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

/** Every source file reachable from `entry` through relative imports, and every package any of them names. */
function importGraph(entry: string): { files: string[]; packages: string[] } {
	const files = new Set<string>();
	const packages = new Set<string>();
	const visit = (file: string) => {
		if (files.has(file)) return;
		files.add(file);
		// Every way a module names another one: `from`, a bare or dynamic `import`, and `require`. Type-only imports
		// count too, because a consumer's compiler has to resolve them.
		for (const [, specifier] of readFileSync(file, 'utf8').matchAll(
			/(?:\bfrom\s+|\bimport\s*\(?\s*|\brequire\s*\(\s*)'([^']+)'/g,
		)) {
			if (specifier!.startsWith('.')) visit(resolve(dirname(file), `${specifier}.ts`));
			else packages.add(specifier!);
		}
	};
	visit(entry);
	return { files: [...files].map(file => relative(SOURCE, file)).sort(), packages: [...packages].sort() };
}

describe('package entry points', () => {
	it('keeps Redis out of the package root', () => {
		const root = importGraph(resolve(SOURCE, 'index.ts'));
		const redis = importGraph(resolve(SOURCE, 'coordinators/redis.ts'));

		expect(root.files).toContain('coordinators/memory.ts');
		expect(root.files).not.toContain('coordinators/redis.ts');
		expect(root.packages).toEqual(['node:async_hooks', 'seyfert']);
		// The same walk does find Redis where it belongs.
		expect(redis.packages).toEqual(expect.arrayContaining(['@redis/client', '@slipher/redis-adapter']));
	});

	it('publishes the Redis coordinator on its own subpath, with optional peers pinned to what it was tested with', () => {
		const manifest = JSON.parse(readFileSync(resolve(SOURCE, '../package.json'), 'utf8'));
		// The adapter the Redis suite runs against is the workspace's own.
		const tested = JSON.parse(readFileSync(resolve(SOURCE, '../../redis-adapter/package.json'), 'utf8'));
		const entry = (file: string) => ({
			types: `./lib/${file}.d.ts`,
			import: `./lib/${file}.js`,
			require: `./lib/${file}.js`,
			default: `./lib/${file}.js`,
		});

		expect(manifest.exports).toEqual({
			'.': entry('index'),
			'./coordinators/redis': entry('coordinators/redis'),
			'./package.json': './package.json',
		});
		// The coordinator's scripts follow this adapter's storage layout. A new adapter version has to pass the
		// Redis suite before the pin moves to it.
		expect(manifest.peerDependencies['@slipher/redis-adapter']).toBe(tested.version);
		expect(Object.keys(manifest.peerDependencies).sort()).toEqual([
			'@redis/client',
			'@slipher/redis-adapter',
			'seyfert',
		]);
		expect(manifest.peerDependenciesMeta).toEqual({
			'@redis/client': { optional: true },
			'@slipher/redis-adapter': { optional: true },
		});
		expect(manifest.dependencies).toBeUndefined();
	});
});
