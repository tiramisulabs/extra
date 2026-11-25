import { createMockBot } from '@slipher/testing';
import { type Adapter, CacheFrom, Client, createPlugin, definePlugins, MemoryAdapter, PluginOrder } from 'seyfert';
import { describe, expect, it, vi } from 'vitest';
import { type CacheReconcilerCoordinator, cacheReconciler, memoryCoordinator } from '../src';
import { ReconciledAdapter } from '../src/adapter';
import {
	innerCloner,
	managerOf,
	outerCloner,
	packetEntry,
	realClient,
	startBot,
	startReconciled,
	workerClient,
} from './clients';
import {
	AsyncAdapter,
	BOT_ID,
	type Dispatch,
	deferred,
	type GuildPayload,
	gatewayDispatch,
	guildDeletePacket,
	guildOn,
	guildPacket,
	guildsReadyPacket,
	readyPacket,
	settleMicrotasks,
} from './support';

const G = guildOn(2);
const ROLE = '501';

function guild(id = G): GuildPayload {
	return { id, name: 'guild', roles: [{ id: `${id}-role`, name: 'role' }] };
}

function storeOf(adapter: Adapter): MemoryAdapter<unknown> {
	return adapter instanceof AsyncAdapter ? adapter.memory : (adapter as MemoryAdapter<unknown>);
}

/** Runs a shard through READY, one startup guild, and GUILDS_READY. */
async function startShard(dispatch: Dispatch, guildId = G) {
	await dispatch(readyPacket({ guilds: [guildId] }));
	await dispatch(guildPacket('RAW_GUILD_CREATE', 2, { id: guildId, name: 'guild', roles: [{ id: ROLE }] }));
	await dispatch(guildsReadyPacket(2));
}

const variants = [
	['synchronous', (): Adapter => new MemoryAdapter()],
	['asynchronous', (): Adapter => new AsyncAdapter()],
] as const;

describe('startup guild stream', () => {
	it.each(
		variants,
	)('hides a shard at READY and validates each guild from its own packet over a %s adapter', async (_kind, create) => {
		const adapter = create();
		const store = storeOf(adapter);
		store.set('role.ghost', { id: 'ghost' }, [`role.${G}`, 'ghost']);
		store.set(`member.${G}.5`, { id: '5' }, [`member.${G}`, '5']);
		const { bot, client, dispatch, manager } = await startReconciled(adapter);

		await dispatch(readyPacket({ guilds: [G] }));
		expect(manager.status()).toMatchObject({
			idle: false,
			shards: [{ shardId: 0, sessionId: 'session-1', startup: 'awaiting-guilds', expectedGuilds: 1, settledGuilds: 0 }],
		});

		await dispatch(guildPacket('RAW_GUILD_CREATE', 2, { id: G, name: 'guild', roles: [{ id: ROLE }] }));
		expect(await client.cache.guilds!.raw(G)).toMatchObject({ id: G, name: 'guild' });
		expect(await client.cache.roles!.keys(G)).toEqual([`role.${ROLE}`]);
		// What the previous process left behind is not served, whether or not the snapshot could list it.
		expect(await client.cache.roles!.raw('ghost')).toBeNull();
		expect(await client.cache.members!.keys(G)).toEqual([]);
		expect(store.get(`member.${G}.5`)).not.toBeNull();

		await dispatch(guildsReadyPacket(2));
		await manager.waitForIdle();
		expect(manager.status()).toMatchObject({
			lifecycle: 'active',
			idle: true,
			pending: { guilds: 0 },
			shards: [{ startup: 'committed', settledGuilds: 1, outcomes: { reconciled: 1 } }],
			failures: [],
		});
		await bot.close();
	});

	it('keeps shards independent when one of them starts a new session', async () => {
		const onShard0 = guildOn(2);
		const onShard1 = guildOn(3);
		const { bot, client, dispatch, manager } = await startReconciled(new MemoryAdapter());
		await dispatch(readyPacket({ guilds: [onShard0], shard: [0, 2], sessionId: 'a' }), 0);
		await dispatch(readyPacket({ guilds: [onShard1], shard: [1, 2], sessionId: 'b' }), 1);
		await dispatch(guildPacket('RAW_GUILD_CREATE', 2, guild(onShard0)), 0);
		await dispatch(guildPacket('RAW_GUILD_CREATE', 2, guild(onShard1)), 1);
		await dispatch(guildsReadyPacket(2), 0);
		await dispatch(guildsReadyPacket(2), 1);
		expect(manager.status().shards).toMatchObject([
			{ shardId: 0, startup: 'committed' },
			{ shardId: 1, startup: 'committed' },
		]);

		await dispatch(readyPacket({ guilds: [onShard1], shard: [1, 2], sessionId: 'c' }), 1);

		expect(await client.cache.roles!.keys(onShard0)).toEqual([`role.${onShard0}-role`]);
		expect(await client.cache.roles!.keys(onShard1)).toEqual([]);
		expect(manager.status().shards).toMatchObject([
			{ shardId: 0, sessionId: 'a', startup: 'committed' },
			{ shardId: 1, sessionId: 'c', startup: 'awaiting-guilds', settledGuilds: 0 },
		]);
		await bot.close();
	});

	it('commits a zero-guild READY at GUILDS_READY', async () => {
		const { bot, dispatch, manager } = await startReconciled(new MemoryAdapter());

		await dispatch(readyPacket({ guilds: [] }));
		expect(manager.status().idle).toBe(false);
		await dispatch(guildsReadyPacket(1));
		await manager.waitForIdle();

		expect(manager.status()).toMatchObject({
			idle: true,
			pending: { guilds: 0, tasks: 0 },
			shards: [{ startup: 'committed', expectedGuilds: 0 }],
		});
		await bot.close();
	});

	it('does not commit while the last guild is still being cached when GUILDS_READY arrives', async () => {
		const first = guildOn(2);
		const last = guildOn(4);
		const adapter = new AsyncAdapter();
		const { bot, dispatch, manager } = await startReconciled(adapter);
		await dispatch(readyPacket({ guilds: [first, last] }));
		await dispatch(guildPacket('RAW_GUILD_CREATE', 2, guild(first)));
		const caching = deferred();
		// A snapshot of entries nobody could read yet is written as a replace.
		adapter.gate('bulkSet', caching.promise);

		const lastGuild = dispatch(guildPacket('RAW_GUILD_CREATE', 3, guild(last)));
		await dispatch(guildsReadyPacket(3));
		let idle = false;
		const waiting = manager.waitForIdle().then(() => {
			idle = true;
		});
		await Promise.resolve();

		expect(idle).toBe(false);
		expect(manager.status()).toMatchObject({
			idle: false,
			pending: { guilds: 1 },
			shards: [{ startup: 'awaiting-guilds', settledGuilds: 1 }],
		});

		caching.resolve();
		await lastGuild;
		await waiting;
		expect(manager.status().shards).toMatchObject([{ startup: 'committed', settledGuilds: 2 }]);
		await bot.close();
	});

	it('does not commit when GUILDS_READY is observed before the last guild packet registered', async () => {
		const first = guildOn(2);
		const last = guildOn(4);
		const { bot, dispatch, manager } = await startReconciled(new MemoryAdapter());
		await dispatch(readyPacket({ guilds: [first, last] }));
		await dispatch(guildPacket('RAW_GUILD_CREATE', 2, guild(first)));

		await dispatch(guildsReadyPacket(2));
		expect(manager.status()).toMatchObject({
			idle: false,
			pending: { guilds: 0 },
			shards: [{ startup: 'awaiting-guilds' }],
		});

		await dispatch(guildDeletePacket('RAW_GUILD_DELETE', 3, { id: last }));
		await manager.waitForIdle();
		expect(manager.status().shards).toMatchObject([{ startup: 'committed', outcomes: { reconciled: 1, deleted: 1 } }]);
		await bot.close();
	});

	it('preserves an unavailable startup guild', async () => {
		const outage = guildOn(4);
		const { bot, client, dispatch, manager } = await startReconciled(new MemoryAdapter());
		await dispatch(readyPacket({ guilds: [G, outage] }));

		await dispatch(guildPacket('RAW_GUILD_CREATE', 2, { id: G, unavailable: true }));
		await dispatch(guildDeletePacket('RAW_GUILD_DELETE', 3, { id: outage, unavailable: true }));
		await dispatch(guildsReadyPacket(3));

		expect(manager.status().shards).toMatchObject([{ startup: 'committed', outcomes: { 'unavailable-preserved': 2 } }]);
		expect(await client.cache.guilds!.raw(G)).toMatchObject({ id: G, unavailable: true });
		await bot.close();
	});
});

describe('guilds after startup', () => {
	it('opens a guild the bot joins and closes it when the bot is removed', async () => {
		const joined = guildOn(4);
		const removed: unknown[] = [];
		const listener = createPlugin({
			name: 'guild-delete-listener',
			register(api) {
				api.events.on('GUILD_DELETE', structure => {
					removed.push(structure);
				});
			},
		});
		const { bot, client, dispatch, manager } = await startReconciled(new MemoryAdapter(), { after: [listener] });
		await startShard(dispatch);

		await dispatch(guildPacket('GUILD_CREATE', 5, guild(joined)));
		expect(await client.cache.roles!.keys(joined)).toEqual([`role.${joined}-role`]);

		// An outage is not a removal.
		await dispatch(guildDeletePacket('GUILD_DELETE', 6, { id: joined, unavailable: true }));
		expect(await client.cache.roles!.keys(joined)).toEqual([`role.${joined}-role`]);

		await dispatch(guildDeletePacket('GUILD_DELETE', 7, { id: joined }));
		expect(await client.cache.guilds!.raw(joined)).toBeUndefined();
		expect(await client.cache.roles!.keys(joined)).toEqual([]);
		// Seyfert resolves the removed guild from the cache before it removes it; that read still worked.
		expect(removed.at(-1)).toMatchObject({ id: joined, name: 'guild' });
		expect(manager.status()).toMatchObject({ idle: true, pending: { guilds: 0 }, failures: [] });
		await bot.close();
	});

	it('closes a removed guild even when the client does not cache guild records', async () => {
		const client = new Client({ plugins: definePlugins(cacheReconciler({ coordinator: memoryCoordinator() })) });
		client.setServices({ cache: { adapter: new MemoryAdapter(), disabledCache: { guilds: true } } });
		const bot = await createMockBot({ client });
		const dispatch = gatewayDispatch(bot);
		await startShard(dispatch);
		await dispatch({ op: 0, t: 'GUILD_ROLE_CREATE', s: 3, d: { guild_id: G, role: { id: ROLE, name: 'role' } } });
		expect(await client.cache.roles!.keys(G)).toEqual([`role.${ROLE}`]);

		// Seyfert removes nothing here, so only the reconciler can stop serving the guild's entries.
		await dispatch(guildDeletePacket('GUILD_DELETE', 4, { id: G }));

		expect(await client.cache.roles!.keys(G)).toEqual([]);
		expect(client.cacheReconciler.status()).toMatchObject({ pending: { guilds: 0 }, failures: [] });
		await bot.close();
	});

	it('fails closed on a RESUMED it holds no generation for', async () => {
		const { bot, client, dispatch, manager } = await startReconciled(new MemoryAdapter());
		await client.cache.roles!.set(CacheFrom.Test, ROLE, G, { id: ROLE } as never);
		expect(await client.cache.roles!.keys(G)).toEqual([`role.${ROLE}`]);

		await dispatch({ op: 0, t: 'RESUMED', s: 40 });

		expect(await client.cache.roles!.keys(G)).toEqual([]);
		expect(manager.status()).toMatchObject({
			shards: [{ shardId: 0, startup: 'awaiting-ready' }],
			failures: [{ kind: 'session', shardId: 0 }],
		});

		await startShard(dispatch);
		expect(await client.cache.roles!.keys(G)).toEqual([`role.${ROLE}`]);
		await bot.close();
	});
});

describe('correlation with other interceptors', () => {
	it.each([
		['after the reconciler', { after: [innerCloner()] }],
		['around the reconciler', { before: [outerCloner()] }],
	])('reconciles a guild whose packet another plugin cloned %s', async (_where, plugins) => {
		const { bot, client, dispatch, manager } = await startReconciled(new MemoryAdapter(), plugins);

		await startShard(dispatch);

		expect(manager.status()).toMatchObject({
			shards: [{ startup: 'committed', outcomes: { reconciled: 1 } }],
			failures: [],
		});
		expect(await client.cache.roles!.keys(G)).toEqual([`role.${ROLE}`]);
		await bot.close();
	});

	it.each([
		['with the original payloads', {}],
		['through a later interceptor that clones them', { after: [innerCloner()] }],
	])('settles overlapping deletes of the same guild as each one finishes %s', async (_label, plugins) => {
		const adapter = new AsyncAdapter();
		const { bot, dispatch, manager } = await startReconciled(adapter, plugins);
		await startShard(dispatch);
		const firstRemoval = deferred();
		adapter.gate('bulkRemove', firstRemoval.promise);

		// The packet dispatched first finishes last.
		const first = dispatch(guildDeletePacket('GUILD_DELETE', 10, { id: G }));
		const second = dispatch(guildDeletePacket('GUILD_DELETE', 11, { id: G }));
		await second;
		await vi.waitFor(() => expect(manager.status()).toMatchObject({ pending: { guilds: 1 }, failures: [] }));

		firstRemoval.resolve();
		await first;
		await manager.waitForIdle();
		expect(manager.status()).toMatchObject({ pending: { guilds: 0 }, failures: [] });
		await bot.close();
	});

	it('forgets the previous session work, so its leftovers cannot make a new packet ambiguous', async () => {
		const adapter = new AsyncAdapter();
		const { bot, dispatch, manager } = await startReconciled(adapter, { before: [outerCloner()] });
		await dispatch(readyPacket({ guilds: [G] }));
		const caching = deferred();
		adapter.gate('bulkSet', caching.promise);
		const previous = dispatch(guildPacket('RAW_GUILD_CREATE', 2, guild()));
		await settleMicrotasks();

		await dispatch(readyPacket({ guilds: [G], sessionId: 'session-2' }));
		await dispatch(guildPacket('RAW_GUILD_CREATE', 2, guild()));

		await vi.waitFor(() =>
			expect(manager.status()).toMatchObject({
				shards: [{ sessionId: 'session-2', outcomes: { reconciled: 1 } }],
				failures: [],
			}),
		);
		caching.resolve();
		await previous;
		expect(manager.status().failures).toEqual([]);
		await bot.close();
	});

	it('fails overlapping deletes closed when their payload identity was replaced', async () => {
		const adapter = new AsyncAdapter();
		const { bot, dispatch, manager } = await startReconciled(adapter, { before: [outerCloner()] });
		await startShard(dispatch);
		const firstRemoval = deferred();
		adapter.gate('bulkRemove', firstRemoval.promise);

		const first = dispatch(guildDeletePacket('GUILD_DELETE', 10, { id: G }));
		const second = dispatch(guildDeletePacket('GUILD_DELETE', 11, { id: G }));
		await second;

		// Nothing says which packet finished, so neither is paired by completion order.
		expect(manager.status()).toMatchObject({
			pending: { guilds: 0 },
			failures: [
				{ kind: 'guild', guildId: G },
				{ kind: 'guild', guildId: G },
			],
		});
		firstRemoval.resolve();
		await first;
		expect(manager.status().failureCount).toBe(2);
		await bot.close();
	});
});

describe('packets Seyfert never caches', () => {
	it('settles a vetoed READY guild as failed and preserves the veto', async () => {
		const veto = createPlugin({
			name: 'veto',
			register(api) {
				api.gateway.onDispatch(packet => (packet.t === 'RAW_GUILD_CREATE' ? null : undefined));
			},
		});
		const adapter = new MemoryAdapter();
		const { bot, client, dispatch, manager } = await startReconciled(adapter, { after: [veto] });
		await dispatch(readyPacket({ guilds: [G] }));

		await dispatch(guildPacket('RAW_GUILD_CREATE', 2, guild()));
		await dispatch(guildsReadyPacket(2));
		await manager.waitForIdle();

		// Seyfert still saw a veto: it never cached the guild and recorded who dropped the packet.
		expect(adapter.get(`guild.${G}`)).toBeNull();
		const diagnostics = client.plugins.diagnostics.flatMap(plugin => plugin.messages);
		expect(diagnostics).toContainEqual(expect.objectContaining({ plugin: 'veto', code: 'gateway-dispatch-veto' }));
		expect(manager.status()).toMatchObject({
			idle: true,
			shards: [{ startup: 'committed', outcomes: { failed: 1 } }],
			failures: [{ kind: 'guild', guildId: G, shardId: 0 }],
		});
		await bot.close();
	});

	it('settles a READY guild as failed when a later interceptor rejects, and rethrows', async () => {
		const failure = new Error('interceptor failed');
		const rejecting = createPlugin({
			name: 'rejecting',
			register(api) {
				api.gateway.onDispatch(packet => {
					if (packet.t === 'RAW_GUILD_CREATE') throw failure;
				});
			},
		});
		const { bot, dispatch, manager } = await startReconciled(new MemoryAdapter(), { after: [rejecting] });
		await dispatch(readyPacket({ guilds: [G] }));

		await expect(dispatch(guildPacket('RAW_GUILD_CREATE', 2, guild()))).rejects.toThrow('interceptor failed');
		await dispatch(guildsReadyPacket(2));
		await manager.waitForIdle();

		expect(manager.status().shards).toMatchObject([{ startup: 'committed', outcomes: { failed: 1 } }]);
		await bot.close();
	});

	it.each(
		variants,
	)('settles a READY guild as failed when the core cache write fails over a %s adapter', async (_kind, create) => {
		const adapter = create();
		const { bot, client, dispatch, manager } = await startReconciled(adapter);
		const failure = new Error('bulkSet failed');
		await dispatch(readyPacket({ guilds: [G] }));
		if (adapter instanceof AsyncAdapter) adapter.failNext('bulkSet', failure);
		else {
			adapter.bulkSet = () => {
				throw failure;
			};
		}

		await expect(dispatch(guildPacket('RAW_GUILD_CREATE', 2, guild()))).rejects.toBe(failure);
		await dispatch(guildsReadyPacket(2));
		await manager.waitForIdle();

		expect(await client.cache.roles!.keys(G)).toEqual([]);
		expect(manager.status()).toMatchObject({
			idle: true,
			shards: [{ startup: 'committed', outcomes: { failed: 1 } }],
			failures: [
				{ kind: 'write', cause: failure },
				{ kind: 'guild', guildId: G, cause: failure },
			],
		});
		await bot.close();
	});

	it('settles a READY guild as failed when only the merged half of its write fails', async () => {
		const adapter = new AsyncAdapter();
		const { bot, dispatch, manager } = await startReconciled(adapter);
		const failure = new Error('bulkPatch failed');
		// READY made the bot user readable, so the guild's own member entry for it is merged, not replaced:
		// Seyfert's single write reaches the store as a replace followed by a patch.
		await dispatch(readyPacket({ guilds: [G] }));
		adapter.failNext('bulkPatch', failure);

		await expect(
			dispatch(
				guildPacket('RAW_GUILD_CREATE', 2, { ...guild(), members: [{ user: { id: BOT_ID, username: 'bot' } }] }),
			),
		).rejects.toBe(failure);
		await dispatch(guildsReadyPacket(2));
		await manager.waitForIdle();

		expect(adapter.calls.filter(call => call === 'bulkSet' || call === 'bulkPatch')).toEqual(['bulkSet', 'bulkPatch']);
		expect(manager.status().shards).toMatchObject([{ startup: 'committed', outcomes: { failed: 1 } }]);
		await bot.close();
	});

	it('settles a removed guild as failed when Seyfert cannot remove it, and keeps what it tried hidden', async () => {
		const adapter = new AsyncAdapter();
		const { bot, client, dispatch, manager } = await startReconciled(adapter);
		await startShard(dispatch);
		const failure = new Error('bulkRemove failed');
		adapter.failNext('bulkRemove', failure);

		await expect(dispatch(guildDeletePacket('GUILD_DELETE', 5, { id: G }))).rejects.toBe(failure);
		await manager.waitForIdle();

		expect(adapter.memory.get(`role.${ROLE}`)).not.toBeNull();
		expect(await client.cache.roles!.keys(G)).toEqual([]);
		// Discord said the guild is gone: the record Seyfert never got to remove is not served either.
		expect(adapter.memory.get(`guild.${G}`)).not.toBeNull();
		expect(await client.cache.guilds!.raw(G)).toBeUndefined();
		expect(manager.status()).toMatchObject({
			idle: true,
			pending: { guilds: 0 },
			failures: [{ kind: 'removal' }, { kind: 'guild', guildId: G, cause: failure }],
		});
		await bot.close();
	});

	it('settles a removed guild when the coordinator names a guild the failed keys do not', async () => {
		const failure = new Error('removal failed');
		// Stands in for a coordinator that learns the guild from the relationship it was asked to remove.
		const coordinator: CacheReconcilerCoordinator = {
			kind: 'memory',
			bind(host) {
				const binding = memoryCoordinator().bind(host);
				binding.remove = () => {
					host.mutationFailed?.([], failure, [undefined, G]);
					throw failure;
				};
				return binding;
			},
		};
		const { bot, client, dispatch } = await startBot(new MemoryAdapter(), cacheReconciler({ coordinator }));
		const manager = managerOf(client);
		await startShard(dispatch);

		await expect(dispatch(guildDeletePacket('GUILD_DELETE', 5, { id: G }))).rejects.toBe(failure);
		await manager.waitForIdle();

		expect(manager.status()).toMatchObject({
			idle: true,
			pending: { guilds: 0 },
			failures: [{ kind: 'guild', guildId: G, cause: failure }],
		});
		expect(await client.cache.roles!.keys(G)).toEqual([]);
		await bot.close();
	});

	it('does not blame a guild snapshot for an unrelated failed write in the same guild', async () => {
		const adapter = new AsyncAdapter();
		const { bot, client, dispatch, manager } = await startReconciled(adapter);
		await dispatch(readyPacket({ guilds: [G] }));
		const caching = deferred();
		adapter.gate('bulkSet', caching.promise);
		const snapshot = dispatch(guildPacket('RAW_GUILD_CREATE', 2, guild()));
		await settleMicrotasks();
		await client.cache.roles!.set(CacheFrom.Rest, 'other', G, { id: 'other' } as never);
		adapter.failNext('bulkSet', new Error('role write failed'));

		await expect(client.cache.roles!.set(CacheFrom.Rest, 'other', G, { id: 'other' } as never)).rejects.toThrow(
			'role write failed',
		);
		expect(manager.status()).toMatchObject({ pending: { guilds: 1 }, failures: [{ kind: 'write' }] });

		caching.resolve();
		await snapshot;
		await dispatch(guildsReadyPacket(2));
		await manager.waitForIdle();
		expect(manager.status().shards).toMatchObject([{ outcomes: { reconciled: 1, failed: 0 } }]);
		await bot.close();
	});

	it('does not settle a guild from a failed write before Seyfert was handed its packet', async () => {
		const held = deferred();
		const holding = createPlugin({
			name: 'holding',
			register(api) {
				api.gateway.onDispatch(async (packet, next) => {
					if (packet.t === 'RAW_GUILD_CREATE') await held.promise;
					return next();
				});
			},
		});
		const adapter = new AsyncAdapter();
		const { bot, client, dispatch, manager } = await startReconciled(adapter, { after: [holding] });
		await dispatch(readyPacket({ guilds: [G] }));
		const snapshot = dispatch(guildPacket('RAW_GUILD_CREATE', 2, guild()));
		await settleMicrotasks();
		adapter.failNext('bulkSet', new Error('guild write failed'));

		// A REST-sourced write of the same guild record fails while the packet is still in the interceptor chain.
		await expect(client.cache.guilds!.set(CacheFrom.Rest, G, { id: G } as never)).rejects.toThrow('guild write failed');
		expect(manager.status().pending.guilds).toBe(1);

		held.resolve();
		await snapshot;
		await dispatch(guildsReadyPacket(2));
		await manager.waitForIdle();
		expect(manager.status().shards).toMatchObject([{ outcomes: { reconciled: 1, failed: 0 } }]);
		await bot.close();
	});

	it('settles a guild packet a later interceptor turned into a different event', async () => {
		const renaming = createPlugin({
			name: 'renaming',
			register(api) {
				api.gateway.onDispatch((packet, next) =>
					packet.t === 'RAW_GUILD_CREATE' ? next({ ...packet, t: 'GUILD_CREATE' } as never) : undefined,
				);
			},
		});
		const { bot, dispatch, manager } = await startReconciled(new MemoryAdapter(), { after: [renaming] });

		await startShard(dispatch);
		await manager.waitForIdle();

		expect(manager.status()).toMatchObject({
			shards: [{ startup: 'committed', outcomes: { failed: 1 } }],
			failures: [{ kind: 'guild', guildId: G, message: expect.stringContaining('different event') }],
		});
		await bot.close();
	});

	it('still observes a packet that a plugin registered earlier drops', async () => {
		const veto = createPlugin({
			name: 'early-veto',
			register(api) {
				api.gateway.onDispatch(packet => (packet.t === 'RAW_GUILD_CREATE' ? null : undefined));
			},
		});
		const { bot, dispatch, manager } = await startReconciled(new MemoryAdapter(), { before: [veto] });

		await startShard(dispatch);

		// Running ahead of ordinary interceptors is what lets the startup snapshot settle instead of waiting.
		expect(manager.status().shards).toMatchObject([{ startup: 'committed', outcomes: { failed: 1 } }]);
		await bot.close();
	});

	it('fails a shard closed while a hot reload has the worker stopped, and keeps it closed when reactivated', async () => {
		const original = new MemoryAdapter();
		const client = workerClient(original, {}, cacheReconciler({ coordinator: memoryCoordinator() }));
		const bot = await createMockBot({ client: client as never });
		const dispatch = packetEntry(client, 'packet-first');
		const manager = managerOf(client);
		await startShard(dispatch);
		expect(await client.cache.roles!.keys(G)).toEqual([`role.${ROLE}`]);

		await client.handleManagerMessages({ type: 'HOT_RELOAD_STOP', nonce: 'stop' } as never);
		expect(client.hotReloadState).toBe('stopped');
		// Seyfert does not apply this to a cache it does not recognize, so the role stays stored.
		await dispatch({ op: 0, t: 'GUILD_ROLE_DELETE', s: 3, d: { guild_id: G, role_id: ROLE } });
		await client.handleManagerMessages({ type: 'HOT_RELOAD_ACTIVATE', nonce: 'activate', botReady: false } as never);
		expect(client.hotReloadState).toBe('active');

		expect(original.get(`role.${ROLE}`)).not.toBeNull();
		expect(await client.cache.roles!.keys(G)).toEqual([]);
		expect(manager.status()).toMatchObject({
			idle: true,
			shards: [{ shardId: 0, startup: 'awaiting-ready' }],
			failures: [{ kind: 'session', shardId: 0, message: expect.stringContaining('not the active dispatcher') }],
		});

		// A new session is the next authoritative evidence for the shard.
		await dispatch(readyPacket({ guilds: [G], sessionId: 'session-2' }));
		await dispatch(guildPacket('RAW_GUILD_CREATE', 2, { id: G, name: 'guild', roles: [] }));
		expect(await client.cache.roles!.keys(G)).toEqual([]);
		expect(await client.cache.guilds!.raw(G)).toMatchObject({ id: G });
		await bot.close();
	});

	it('does not register guild packets that arrive while the worker is stopped', async () => {
		const original = new MemoryAdapter();
		const client = workerClient(original, {}, cacheReconciler({ coordinator: memoryCoordinator() }));
		const bot = await createMockBot({ client: client as never });
		const dispatch = packetEntry(client, 'packet-first');
		await client.handleManagerMessages({ type: 'HOT_RELOAD_STOP', nonce: 'stop' } as never);

		await startShard(dispatch);

		expect(original.get(`guild.${G}`)).toBeNull();
		expect(managerOf(client).status()).toMatchObject({
			idle: true,
			pending: { guilds: 0 },
			shards: [{ startup: 'awaiting-ready' }],
		});
		await bot.close();
	});

	it('records a core cache failure that never reached the adapter, and recovers at the next READY', async () => {
		const failure = new Error('filter failed');
		const listener = createPlugin({
			name: 'raw-guild-listener',
			register(api) {
				api.events.on('RAW_GUILD_CREATE', () => undefined);
			},
		});
		const client = realClient(new MemoryAdapter(), cacheReconciler({ coordinator: memoryCoordinator() }), listener);
		await client.start({}, false);
		const dispatch = packetEntry(client, 'shard-first');
		client.cache.guilds!.filter = () => {
			throw failure;
		};

		await dispatch(readyPacket({ guilds: [G] }));
		await dispatch(guildPacket('RAW_GUILD_CREATE', 2, guild()));

		expect(client.cacheReconciler.status()).toMatchObject({
			pending: { guilds: 1 },
			failures: [{ kind: 'dispatch', cause: failure }],
		});

		await dispatch(readyPacket({ guilds: [G], sessionId: 'session-2' }));
		expect(client.cacheReconciler.status()).toMatchObject({
			pending: { guilds: 0 },
			shards: [{ sessionId: 'session-2' }],
		});
		await client.close();
	});
});

describe('own failures', () => {
	it('never lets interceptor bookkeeping break the dispatch', async () => {
		const adapter = new MemoryAdapter();
		const { bot, dispatch, manager } = await startReconciled(adapter);
		const malformed = readyPacket({ guilds: [] });
		Reflect.deleteProperty(malformed.d as object, 'guilds');

		await dispatch(malformed);

		// Seyfert still cached the packet.
		expect(adapter.get(`user.${BOT_ID}`)).toMatchObject({ id: BOT_ID });
		expect(manager.status()).toMatchObject({ shards: [], failures: [{ kind: 'observation', shardId: 0 }] });
		await bot.close();
	});

	it('records a post-cache failure in status before Seyfert logs it', async () => {
		const client = new Client({ plugins: definePlugins(cacheReconciler({ coordinator: memoryCoordinator() })) });
		client.setServices({ cache: { adapter: new MemoryAdapter(), disabledCache: { guilds: true } } });
		const bot = await createMockBot({ client });
		const logged: unknown[][] = [];
		const statusAtLog: number[] = [];
		client.logger.error = (...args: unknown[]) => {
			logged.push(args);
			statusAtLog.push(client.cacheReconciler.status().failureCount);
		};

		// With guilds uncached Seyfert skips its own handling, so the malformed payload reaches the plugin.
		await client.cache.onPacket({ t: 'RAW_GUILD_CREATE', d: null } as never);

		expect(logged).toEqual([[expect.stringContaining('cache.resource.onPacket failed'), expect.any(TypeError)]]);
		expect(statusAtLog).toEqual([1]);
		expect(client.cacheReconciler.status().failures).toMatchObject([{ kind: 'observation' }]);
		await bot.close();
	});

	it('records a dispatch failure only when it may be an unsettled cache failure', async () => {
		const adapter = new AsyncAdapter();
		const listeners = createPlugin({
			name: 'listeners',
			register(api) {
				api.events.on('RAW_GUILD_CREATE', () => undefined);
				api.events.on('GUILD_DELETE', () => {
					throw new Error('listener failed');
				});
			},
		});
		const client = realClient(adapter, cacheReconciler({ coordinator: memoryCoordinator() }), listeners);
		await client.start({}, false);
		const dispatch = packetEntry(client, 'shard-first');
		const manager = managerOf(client);
		const first = guildOn(4);
		const second = guildOn(6);
		await dispatch(readyPacket({ guilds: [G] }));

		// A failed adapter write was already settled for its guild; Seyfert reporting it again adds nothing.
		adapter.failNext('bulkSet', new Error('bulkSet failed'));
		await dispatch(guildPacket('RAW_GUILD_CREATE', 2, guild()));
		expect(manager.status().failures.map(failure => failure.kind)).toEqual(['write', 'guild']);

		// Another plugin's listener fails after its own packet was cached, while a second delete is still caching.
		await dispatch(guildPacket('GUILD_CREATE', 3, guild(first)));
		await dispatch(guildPacket('GUILD_CREATE', 4, guild(second)));
		const removal = deferred();
		adapter.gate('bulkRemove', removal.promise);
		const caching = dispatch(guildDeletePacket('GUILD_DELETE', 5, { id: first }));
		await dispatch(guildDeletePacket('GUILD_DELETE', 6, { id: second }));
		await vi.waitFor(() => expect(manager.status()).toMatchObject({ pending: { guilds: 1 }, failureCount: 2 }));

		removal.resolve();
		await caching;
		await vi.waitFor(() => expect(manager.status()).toMatchObject({ pending: { guilds: 0 }, failureCount: 2 }));
		await client.close();
	});

	it('reports a replaced adapter as soon as a packet is observed', async () => {
		const { bot, client, dispatch } = await startReconciled(new MemoryAdapter());
		client.cache.adapter = new MemoryAdapter();

		await dispatch(readyPacket({ guilds: [] }));

		const diagnostics = client.plugins.diagnostics.flatMap(plugin => plugin.messages);
		expect(diagnostics).toContainEqual(expect.objectContaining({ code: 'cache-reconciler-adapter-replaced' }));
		await bot.close();
	});
});

describe('startup and teardown', () => {
	it('refuses to start when Seyfert does not process Gateway packets in the cache', async () => {
		const original = new MemoryAdapter();
		const client = new Client({ plugins: definePlugins(cacheReconciler({ coordinator: memoryCoordinator() })) });
		client.setServices({ cache: { adapter: original, disabledCache: { onPacket: true } } });
		let starts = 0;
		original.start = () => {
			starts++;
		};

		await expect(createMockBot({ client })).rejects.toThrow('needs Seyfert to process Gateway packets');

		expect(starts).toBe(0);
		expect(client.cacheReconciler.status()).toMatchObject({ lifecycle: 'installing', adapter: 'installed' });
		await client.close();
		expect(client.cache.adapter).toBe(original);
	});

	it('starts anyway when the probe could not complete', async () => {
		const breaking = createPlugin({
			name: 'breaking-cache',
			register(api) {
				api.hooks.on(
					'plugins:ready',
					client => {
						client.cache.onPacket = () => Promise.reject(new Error('cache packet path failed'));
					},
					{ order: PluginOrder.Before },
				);
			},
		});

		// Only a completed round trip without the callback proves packets are not processed.
		const { bot, manager } = await startReconciled(new MemoryAdapter(), { before: [breaking] });

		expect(manager.status().lifecycle).toBe('active');
		await bot.close();
	});

	it('can be set up again when another plugin failed setup before the adapter ever started', async () => {
		const original = new MemoryAdapter();
		let attempts = 0;
		const flaky = createPlugin({
			name: 'flaky',
			setup() {
				if (++attempts === 1) throw new Error('database not ready');
			},
		});
		const client = realClient(original, cacheReconciler({ coordinator: memoryCoordinator() }), flaky);

		// Seyfert tears this plugin down for the other plugin's failure and lets the caller retry.
		await expect(client.start({}, false)).rejects.toThrow('database not ready');
		expect(client.cache.adapter).toBe(original);
		expect(client.cacheReconciler.status()).toMatchObject({ lifecycle: 'closed', adapter: 'restored' });

		await client.start({}, false);
		expect(client.cache.adapter).toBeInstanceOf(ReconciledAdapter);
		expect(client.cacheReconciler.status()).toMatchObject({ lifecycle: 'active', adapter: 'installed' });

		await client.close();
		// Once the wrapped adapter was started, the instance is spent.
		await expect(client.start({}, false)).rejects.toThrow('cannot be set up again');
	});

	it('follows the startup stream with member count tracking, which reorders guild writes', async () => {
		const client = new Client({ plugins: definePlugins(cacheReconciler({ coordinator: memoryCoordinator() })) });
		client.setServices({ cache: { adapter: new AsyncAdapter(), trackMemberCount: true } });
		const bot = await createMockBot({ client });
		const dispatch = gatewayDispatch(bot);

		await startShard(dispatch);
		await client.cacheReconciler.waitForIdle();

		expect(client.cacheReconciler.status()).toMatchObject({
			shards: [{ startup: 'committed', outcomes: { reconciled: 1 } }],
			failures: [],
		});
		await bot.close();
	});

	it('makes a failed adapter start terminal for the client instance', async () => {
		const inner = new AsyncAdapter();
		const cause = new Error('connect failed');
		inner.failNext('start', cause);
		const client = realClient(inner, cacheReconciler({ coordinator: memoryCoordinator() }));

		await expect(client.start({}, false)).rejects.toBe(cause);
		await expect(client.start({}, false)).rejects.toBe(cause);

		expect(inner.calls.filter(call => call === 'start')).toHaveLength(1);
		expect(client.cacheReconciler.status()).toMatchObject({ lifecycle: 'failed', cause, adapter: 'installed' });
		expect(client.cache.adapter).toBeInstanceOf(ReconciledAdapter);

		await client.close();
		expect(client.cache.adapter).toBe(inner);
		expect(client.cacheReconciler.status()).toMatchObject({ lifecycle: 'closed', adapter: 'restored' });
		// Closing restores the adapter but does not make this plugin instance reusable.
		await expect(client.start({}, false)).rejects.toThrow('cannot be set up again');
		expect(client.cache.adapter).toBe(inner);
	});

	it('cancels a guild that is still being cached when the client closes, and ignores what arrives afterwards', async () => {
		const adapter = new AsyncAdapter();
		const { bot, client, dispatch, manager } = await startReconciled(adapter);
		await dispatch(readyPacket({ guilds: [G] }));
		const caching = deferred();
		adapter.gate('bulkSet', caching.promise);
		const inFlight = dispatch(guildPacket('RAW_GUILD_CREATE', 2, guild()));
		await Promise.resolve();
		expect(manager.status().pending.guilds).toBe(1);

		await bot.close();
		expect(manager.status()).toMatchObject({ lifecycle: 'closed', adapter: 'restored', pending: { guilds: 0 } });
		expect(client.cache.adapter).toBe(adapter);

		// The packet still completes through Seyfert and the backing adapter.
		caching.resolve();
		await inFlight;
		expect(adapter.memory.get(`guild.${G}`)).toMatchObject({ id: G });

		// Seyfert keeps calling the interceptor after teardown; nothing may revive the closed instance.
		await dispatch(readyPacket({ guilds: [G], sessionId: 'session-2' }));
		await dispatch(guildPacket('RAW_GUILD_CREATE', 2, guild()));
		await dispatch(guildsReadyPacket(2));
		expect(manager.status()).toMatchObject({
			lifecycle: 'closed',
			pending: { guilds: 0 },
			shards: [{ sessionId: 'session-1', startup: 'awaiting-guilds' }],
			failures: [],
		});
	});

	it('asks for the Guilds intent, which the startup guild stream depends on', async () => {
		const { bot, client } = await startReconciled(new MemoryAdapter());

		expect(client.cache.hasGuildsIntent).toBe(true);
		await bot.close();
	});

	it('runs the whole startup on a WorkerClient that owns a real adapter', async () => {
		const original = new MemoryAdapter();
		const client = workerClient(original, {}, cacheReconciler({ coordinator: memoryCoordinator() }));
		const bot = await createMockBot({ client: client as never });

		const manager = managerOf(client);
		await startShard(packetEntry(client, 'packet-first'));
		await manager.waitForIdle();

		expect(manager.status()).toMatchObject({
			idle: true,
			shards: [{ startup: 'committed', outcomes: { reconciled: 1 } }],
			failures: [],
		});
		expect(await client.cache.roles!.keys(G)).toEqual([`role.${ROLE}`]);
		await bot.close();
	});
});
