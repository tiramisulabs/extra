import { createMockBot } from '@slipher/testing';
import { type Adapter, BaseResource, CacheFrom, Client, createPlugin, definePlugins, MemoryAdapter } from 'seyfert';
import { describe, expect, it, vi } from 'vitest';
import { type CacheReconcilerManager, cacheReconciler, memoryCoordinator } from '../src';
import { startReconciled } from './clients';
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

function storeOf(adapter: Adapter): MemoryAdapter<unknown> {
	return adapter instanceof AsyncAdapter ? adapter.memory : (adapter as MemoryAdapter<unknown>);
}

/** Files an entry straight into the store, the way a previous process left it. */
function leftover(store: MemoryAdapter<unknown>, key: string, to: string, value: object = {}): void {
	const id = key.slice(key.lastIndexOf('.') + 1);
	store.set(key, Array.isArray(value) ? value : { id, ...value }, [to, id]);
}

/** A complete startup guild payload: every collection is present, empty unless overridden. */
function snapshot(guildId: string, overrides: Partial<GuildPayload> = {}): GuildPayload {
	return {
		id: guildId,
		name: 'guild',
		roles: [],
		channels: [],
		threads: [],
		emojis: [],
		stickers: [],
		members: [],
		voice_states: [],
		presences: [],
		stage_instances: [],
		...overrides,
	};
}

async function startup(dispatch: Dispatch, manager: CacheReconcilerManager, payload: GuildPayload) {
	await dispatch(readyPacket({ guilds: [payload.id] }));
	await dispatch(guildPacket('RAW_GUILD_CREATE', 2, payload));
	await dispatch(guildsReadyPacket(2));
	await manager.waitForIdle();
}

/** Every key the store holds. */
function stored(store: MemoryAdapter<unknown>): string[] {
	return [...store.scan('*.*', true), ...store.scan('*.*.*', true)].sort();
}

const variants = [
	['synchronous', (): Adapter => new MemoryAdapter()],
	['asynchronous', (): Adapter => new AsyncAdapter()],
] as const;

describe('startup guild snapshot', () => {
	it.each(variants)('removes what the guild no longer has from a %s adapter', async (_kind, create) => {
		const adapter = create();
		const store = storeOf(adapter);
		for (const [namespace, kept, gone] of [
			['role', 'r-kept', 'r-gone'],
			['channel', 'c-kept', 'c-gone'],
			['emoji', 'e-kept', 'e-gone'],
			['sticker', 's-kept', 's-gone'],
		]) {
			leftover(store, `${namespace}.${kept}`, `${namespace}.${G}`, { type: 0 });
			leftover(store, `${namespace}.${gone}`, `${namespace}.${G}`, { type: 0 });
		}
		const { bot, client, dispatch, manager } = await startReconciled(adapter);

		await dispatch(readyPacket({ guilds: [G] }));
		// From READY on the leftovers are unreadable, long before anything is deleted.
		expect(await client.cache.roles!.keys(G)).toEqual([]);
		expect(store.get('role.r-gone')).not.toBeNull();

		await dispatch(
			guildPacket(
				'RAW_GUILD_CREATE',
				2,
				snapshot(G, {
					roles: [{ id: 'r-kept' }],
					channels: [{ id: 'c-kept', type: 0 }],
					emojis: [{ id: 'e-kept' }],
					stickers: [{ id: 's-kept' }],
				}),
			),
		);
		await dispatch(guildsReadyPacket(2));
		await manager.waitForIdle();

		expect(stored(store)).toEqual([
			'channel.c-kept',
			'emoji.e-kept',
			`guild.${G}`,
			'role.r-kept',
			'sticker.s-kept',
			`user.${BOT_ID}`,
		]);
		expect(store.getToRelationship(`role.${G}`)).toEqual(['r-kept']);
		expect(manager.status()).toMatchObject({
			pending: { deletions: 0, tasks: 0 },
			shards: [{ startup: 'committed', outcomes: { reconciled: 1 } }],
			failures: [],
		});
		await bot.close();
	});

	it('drops the overwrites of a channel that now has none', async () => {
		const adapter = new MemoryAdapter();
		adapter.set('overwrite.c-cleared', [{ id: 'r', type: 0, allow: '0', deny: '8' }], [`overwrite.${G}`, 'c-cleared']);
		adapter.set('overwrite.c-deleted', [{ id: 'r', type: 0, allow: '0', deny: '8' }], [`overwrite.${G}`, 'c-deleted']);
		const { bot, client, dispatch, manager } = await startReconciled(adapter);

		await startup(
			dispatch,
			manager,
			snapshot(G, {
				channels: [
					{ id: 'c-cleared', type: 0, permission_overwrites: [] },
					{ id: 'c-kept', type: 0, permission_overwrites: [{ id: 'r', type: 0, allow: '8', deny: '0' }] },
				],
			}),
		);

		// The cached value is an array: an empty one is a replacement, not a patch that changes nothing.
		expect(adapter.getToRelationship(`overwrite.${G}`)).toEqual(['c-kept']);
		expect(await client.cache.overwrites!.raw('c-kept')).toMatchObject([{ allow: '8' }]);
		await bot.close();
	});

	it('clears voice states and stage instances an empty list no longer contains', async () => {
		const adapter = new MemoryAdapter();
		leftover(adapter, `voice_state.${G}.u-left`, `voice_state.${G}`);
		leftover(adapter, 'stage_instance.c-ended', `stage_instance.${G}`);
		const { bot, dispatch, manager } = await startReconciled(adapter);

		await startup(dispatch, manager, snapshot(G));

		expect(adapter.getToRelationship(`voice_state.${G}`)).toEqual([]);
		expect(adapter.getToRelationship(`stage_instance.${G}`)).toEqual([]);
		await bot.close();
	});

	it('preserves a resource whose list the snapshot did not carry', async () => {
		const adapter = new MemoryAdapter();
		leftover(adapter, 'sticker.s-unknown', `sticker.${G}`);
		const payload = snapshot(G);
		delete payload.stickers;
		const { bot, client, dispatch, manager } = await startReconciled(adapter);

		await startup(dispatch, manager, payload);

		// Absent is not empty: nothing says the sticker is gone, and nothing confirmed it either.
		expect(adapter.get('sticker.s-unknown')).not.toBeNull();
		expect(await client.cache.stickers!.keys(G)).toEqual([]);
		await bot.close();
	});

	it('replaces channels by type and only removes threads that were active', async () => {
		const adapter = new MemoryAdapter();
		const channels = `channel.${G}`;
		leftover(adapter, 'channel.t-live', channels, { type: 11, thread_metadata: { archived: false } });
		leftover(adapter, 'channel.t-gone', channels, { type: 11, thread_metadata: { archived: false } });
		leftover(adapter, 'channel.t-archived', channels, { type: 12, thread_metadata: { archived: true } });
		leftover(adapter, 'channel.c-untyped', channels);
		leftover(adapter, 'channel.c-gone', channels, { type: 0 });
		const { bot, dispatch, manager } = await startReconciled(adapter);

		await startup(
			dispatch,
			manager,
			snapshot(G, { threads: [{ id: 't-live', type: 11, thread_metadata: { archived: false } }] }),
		);

		// Discord lists active threads only, so an archived or unclassified entry is left alone.
		expect(adapter.getToRelationship(channels).sort()).toEqual(['c-untyped', 't-archived', 't-live']);
		await bot.close();
	});

	it('keeps a member the snapshot did not list stored but unreadable until it is observed again', async () => {
		const adapter = new MemoryAdapter();
		leftover(adapter, `member.${G}.u-1`, `member.${G}`, { nick: 'old' });
		leftover(adapter, `presence.${G}.u-1`, `presence.${G}`);
		leftover(adapter, `ban.${G}.u-2`, `ban.${G}`);
		const { bot, client, dispatch, manager } = await startReconciled(adapter);

		await startup(dispatch, manager, snapshot(G));

		expect(adapter.get(`member.${G}.u-1`)).toMatchObject({ nick: 'old' });
		expect(adapter.get(`presence.${G}.u-1`)).not.toBeNull();
		expect(adapter.get(`ban.${G}.u-2`)).not.toBeNull();
		expect(await client.cache.members!.keys(G)).toEqual([]);
		expect(await client.cache.bans!.keys(G)).toEqual([]);
		expect(manager.status().pending.deletions).toBe(0);

		await dispatch({
			op: 0,
			t: 'GUILD_MEMBER_UPDATE',
			s: 3,
			d: { guild_id: G, user: { id: 'u-1', username: 'user' }, roles: [], nick: 'current' },
		});
		expect(await client.cache.members!.keys(G)).toEqual([`member.${G}.u-1`]);
		expect(await client.cache.members!.raw('u-1', G)).toMatchObject({ nick: 'current' });
		await bot.close();
	});

	it('preserves everything of a guild that is unavailable', async () => {
		const adapter = new MemoryAdapter();
		leftover(adapter, 'role.r-1', `role.${G}`);
		leftover(adapter, 'channel.c-1', `channel.${G}`, { type: 0 });
		const { bot, client, dispatch, manager } = await startReconciled(adapter);

		await startup(dispatch, manager, { id: G, unavailable: true });

		// The outage payload has no collections; that says nothing about what the guild contains.
		expect(adapter.get('role.r-1')).not.toBeNull();
		expect(adapter.get('channel.c-1')).not.toBeNull();
		expect(await client.cache.roles!.keys(G)).toEqual([]);
		expect(manager.status().shards).toMatchObject([{ outcomes: { 'unavailable-preserved': 1 } }]);
		await bot.close();
	});

	it('skips resources the client does not cache', async () => {
		const adapter = new MemoryAdapter();
		leftover(adapter, 'role.r-legacy', `role.${G}`);
		leftover(adapter, 'emoji.e-gone', `emoji.${G}`);
		const client = new Client({ plugins: definePlugins(cacheReconciler({ coordinator: memoryCoordinator() })) });
		client.setServices({ cache: { adapter, disabledCache: { roles: true, voiceStates: true, channels: true } } });
		const bot = await createMockBot({ client });

		await startup(gatewayDispatch(bot), client.cacheReconciler, snapshot(G));

		expect(adapter.get('role.r-legacy')).not.toBeNull();
		expect(adapter.get('emoji.e-gone')).toBeNull();
		expect(client.cacheReconciler.status().failures).toEqual([]);
		await bot.close();
	});

	it('keeps a candidate hidden when its removal fails and removes it after the next READY', async () => {
		const adapter = new AsyncAdapter();
		leftover(adapter.memory, 'role.r-gone', `role.${G}`);
		const failure = new Error('remove failed');
		adapter.failNext('remove', failure);
		const { bot, client, dispatch, manager } = await startReconciled(adapter);

		await startup(dispatch, manager, snapshot(G));

		expect(adapter.memory.get('role.r-gone')).not.toBeNull();
		expect(await client.cache.roles!.keys(G)).toEqual([]);
		expect(manager.status()).toMatchObject({
			pending: { deletions: 1 },
			shards: [{ outcomes: { failed: 1 } }],
			failures: [
				{ kind: 'removal', cause: failure },
				{ kind: 'guild', guildId: G },
			],
		});

		// There is no retry scheduler: the next authoritative snapshot claims the key again.
		await dispatch(readyPacket({ guilds: [G], sessionId: 'session-2' }));
		await dispatch(guildPacket('RAW_GUILD_CREATE', 2, snapshot(G)));
		await dispatch(guildsReadyPacket(2));
		await manager.waitForIdle();

		expect(adapter.memory.get('role.r-gone')).toBeNull();
		expect(manager.status()).toMatchObject({ pending: { deletions: 0 }, shards: [{ outcomes: { reconciled: 1 } }] });
		await bot.close();
	});
});

describe('snapshot sweep bookkeeping', () => {
	it('uses the payload Seyfert cached, not the one the plugin first saw', async () => {
		const adding = createPlugin({
			name: 'adding',
			register(api) {
				api.gateway.onDispatch((packet, next) =>
					packet.t === 'RAW_GUILD_CREATE'
						? next({ ...packet, d: { ...packet.d, roles: [...packet.d.roles, { id: 'r-added' }] } } as never)
						: undefined,
				);
			},
		});
		const adapter = new MemoryAdapter();
		const { bot, client, dispatch, manager } = await startReconciled(adapter, { after: [adding] });

		await startup(dispatch, manager, snapshot(G, { roles: [{ id: 'r-original' }] }));

		expect(adapter.getToRelationship(`role.${G}`).sort()).toEqual(['r-added', 'r-original']);
		expect(await client.cache.roles!.keys(G)).toHaveLength(2);
		await bot.close();
	});

	it('settles the guild as failed when it cannot read what is stored', async () => {
		const adapter = new AsyncAdapter();
		leftover(adapter.memory, 'role.r-gone', `role.${G}`);
		const failure = new Error('getToRelationship failed');
		const { bot, dispatch, manager } = await startReconciled(adapter);
		await dispatch(readyPacket({ guilds: [G] }));
		adapter.failNext('getToRelationship', failure);

		await dispatch(guildPacket('RAW_GUILD_CREATE', 2, snapshot(G)));
		await dispatch(guildsReadyPacket(2));
		await manager.waitForIdle();

		expect(adapter.memory.get('role.r-gone')).not.toBeNull();
		expect(manager.status()).toMatchObject({
			idle: true,
			shards: [{ startup: 'committed', outcomes: { failed: 1 } }],
			failures: [{ kind: 'guild', guildId: G, cause: failure }],
		});
		await bot.close();
	});

	it('does not blame a snapshot that was already cached for a later failed write of its guild record', async () => {
		const adapter = new AsyncAdapter();
		const { bot, client, dispatch, manager } = await startReconciled(adapter);
		await dispatch(readyPacket({ guilds: [G] }));
		const discovery = deferred();
		adapter.gate('getToRelationship', discovery.promise);
		await dispatch(guildPacket('RAW_GUILD_CREATE', 2, snapshot(G)));
		adapter.failNext('bulkSet', new Error('guild write failed'));

		await expect(client.cache.guilds!.set(CacheFrom.Rest, G, { id: G, name: 'fetched' })).rejects.toThrow(
			'guild write failed',
		);
		discovery.resolve();
		await dispatch(guildsReadyPacket(2));
		await manager.waitForIdle();

		expect(manager.status().shards).toMatchObject([{ outcomes: { reconciled: 1, failed: 0 } }]);
		await bot.close();
	});

	it('gives up the keys of a sweep a newer READY superseded, so the next snapshot removes them', async () => {
		const adapter = new AsyncAdapter();
		for (let index = 0; index < 150; index++) leftover(adapter.memory, `role.r-${index}`, `role.${G}`);
		const { bot, dispatch, manager } = await startReconciled(adapter);
		await dispatch(readyPacket({ guilds: [G] }));
		const firstGroup = deferred();
		adapter.gate('remove', firstGroup.promise);
		await dispatch(guildPacket('RAW_GUILD_CREATE', 2, snapshot(G)));
		await vi.waitFor(() => expect(adapter.calls).toContain('remove'));

		// The shard starts a new session while the first group of removals is still in flight.
		await dispatch(readyPacket({ guilds: [G], sessionId: 'session-2' }));
		firstGroup.resolve();
		await vi.waitFor(() => expect(manager.status().pending.tasks).toBe(0));
		expect(adapter.memory.getToRelationship(`role.${G}`)).toHaveLength(50);

		await dispatch(guildPacket('RAW_GUILD_CREATE', 2, snapshot(G)));
		await dispatch(guildsReadyPacket(2));
		await manager.waitForIdle();

		expect(adapter.memory.getToRelationship(`role.${G}`)).toEqual([]);
		expect(manager.status()).toMatchObject({ pending: { deletions: 0 }, failures: [] });
		await bot.close();
	});
});

describe('later evidence against an older sweep', () => {
	it('keeps an entry a later packet wrote before the sweep reached it', async () => {
		const adapter = new AsyncAdapter();
		leftover(adapter.memory, 'role.r-gone', `role.${G}`);
		const { bot, client, dispatch, manager } = await startReconciled(adapter);
		await dispatch(readyPacket({ guilds: [G] }));
		const discovery = deferred();
		adapter.gate('getToRelationship', discovery.promise);

		// The sweep of the snapshot at sequence 2 is held while it reads what is stored.
		await dispatch(guildPacket('RAW_GUILD_CREATE', 2, snapshot(G)));
		await dispatch({ op: 0, t: 'GUILD_ROLE_CREATE', s: 3, d: { guild_id: G, role: { id: 'r-new', name: 'new' } } });
		discovery.resolve();
		await dispatch(guildsReadyPacket(3));
		await manager.waitForIdle();

		// The snapshot does not list the role, but a packet after it does.
		expect(adapter.memory.get('role.r-new')).toMatchObject({ name: 'new' });
		expect(adapter.memory.get('role.r-gone')).toBeNull();
		expect(await client.cache.roles!.keys(G)).toEqual(['role.r-new']);
		await bot.close();
	});

	it('keeps an entry a later packet wrote after the sweep already issued its removal', async () => {
		const adapter = new AsyncAdapter({ serial: true });
		leftover(adapter.memory, 'role.r-back', `role.${G}`, { name: 'stale' });
		const { bot, client, dispatch, manager } = await startReconciled(adapter);
		await dispatch(readyPacket({ guilds: [G] }));
		const removal = deferred();
		adapter.gate('remove', removal.promise);
		await dispatch(guildPacket('RAW_GUILD_CREATE', 2, snapshot(G)));
		await vi.waitFor(() => expect(adapter.calls).toContain('remove'));

		// The store applies commands in order: this write is queued behind the removal it outlives.
		const recreated = dispatch({
			op: 0,
			t: 'GUILD_ROLE_CREATE',
			s: 3,
			d: { guild_id: G, role: { id: 'r-back', name: 'recreated' } },
		});
		await settleMicrotasks();
		removal.resolve();
		await recreated;
		await dispatch(guildsReadyPacket(3));
		await manager.waitForIdle();

		expect(adapter.memory.get('role.r-back')).toMatchObject({ name: 'recreated' });
		expect(await client.cache.roles!.raw('r-back')).toMatchObject({ name: 'recreated' });
		expect(manager.status()).toMatchObject({ pending: { deletions: 0 }, failures: [] });
		await bot.close();
	});
});

describe('guilds the shard is no longer in', () => {
	it.each(
		variants,
	)('removes a guild the bot left while offline, hidden descendants included, from a %s adapter', async (_kind, create) => {
		const left = guildOn(4);
		const adapter = create();
		const store = storeOf(adapter);
		leftover(store, `guild.${left}`, 'guild');
		leftover(store, 'role.r-left', `role.${left}`);
		leftover(store, `member.${left}.u-1`, `member.${left}`);
		leftover(store, `presence.${left}.u-1`, `presence.${left}`);
		leftover(store, 'channel.c-left', `channel.${left}`, { type: 0 });
		leftover(store, 'message.m-1', 'message.c-left');
		store.set('overwrite.c-left', [{ id: 'r', type: 0 }], [`overwrite.${left}`, 'c-left']);
		const { bot, client, dispatch, manager } = await startReconciled(adapter);

		await dispatch(readyPacket({ guilds: [G] }));
		// The guild is gone from the first READY that does not list it.
		expect(await client.cache.guilds!.raw(left)).toBeUndefined();
		await dispatch(guildPacket('RAW_GUILD_CREATE', 2, snapshot(G, { roles: [{ id: 'r-kept' }] })));
		expect(store.get(`guild.${left}`)).not.toBeNull();
		await dispatch(guildsReadyPacket(2));
		await manager.waitForIdle();

		// Nothing of it is orphaned: values and relationships of every descendant went with the guild.
		expect(stored(store)).toEqual([`guild.${G}`, 'role.r-kept', `user.${BOT_ID}`]);
		expect(store.getToRelationship(`member.${left}`)).toEqual([]);
		expect(store.getToRelationship('message.c-left')).toEqual([]);
		expect(manager.status()).toMatchObject({ idle: true, pending: { deletions: 0, tasks: 0 }, failures: [] });
		await bot.close();
	});

	it('never touches a guild another shard owns', async () => {
		const mine = guildOn(2);
		const theirs = guildOn(3);
		const adapter = new MemoryAdapter();
		leftover(adapter, `guild.${theirs}`, 'guild');
		leftover(adapter, 'role.r-theirs', `role.${theirs}`);
		const { bot, dispatch, manager } = await startReconciled(adapter);

		await dispatch(readyPacket({ guilds: [mine], shard: [0, 2] }));
		await dispatch(guildPacket('RAW_GUILD_CREATE', 2, snapshot(mine)));
		await dispatch(guildsReadyPacket(2));
		await manager.waitForIdle();

		// This process only ran shard 0; shard 1's READY is the only evidence about its guilds.
		expect(adapter.get(`guild.${theirs}`)).not.toBeNull();
		expect(adapter.get('role.r-theirs')).not.toBeNull();
		await bot.close();
	});

	it('stops the cleanup of a guild the bot joined again while it was running', async () => {
		const rejoined = guildOn(4);
		const adapter = new AsyncAdapter();
		leftover(adapter.memory, `guild.${rejoined}`, 'guild', { name: 'before' });
		leftover(adapter.memory, 'role.r-old', `role.${rejoined}`);
		const { bot, client, dispatch, manager } = await startReconciled(adapter);
		await dispatch(readyPacket({ guilds: [G] }));
		await dispatch(guildPacket('RAW_GUILD_CREATE', 2, snapshot(G)));
		await vi.waitFor(() => expect(manager.status().pending.guilds).toBe(0));
		const cascadeRead = deferred();
		// The first read lists the stored guilds; the second belongs to the cascade, after it took its claim.
		adapter.gate('getToRelationship', Promise.resolve());
		adapter.gate('getToRelationship', cascadeRead.promise);
		const readsBefore = adapter.calls.filter(call => call === 'getToRelationship').length;
		await dispatch(guildsReadyPacket(2));
		await vi.waitFor(() =>
			expect(adapter.calls.filter(call => call === 'getToRelationship').length).toBe(readsBefore + 2),
		);

		await dispatch(guildPacket('GUILD_CREATE', 3, snapshot(rejoined, { name: 'after', roles: [{ id: 'r-new' }] })));
		cascadeRead.resolve();
		await manager.waitForIdle();

		// The claim died with the new GUILD_CREATE, so the cascade removed nothing of the guild.
		expect(adapter.memory.get(`guild.${rejoined}`)).toMatchObject({ name: 'after' });
		expect(adapter.memory.get('role.r-new')).not.toBeNull();
		expect(await client.cache.roles!.keys(rejoined)).toEqual(['role.r-new']);
		expect(adapter.calls).not.toContain('bulkRemove');
		expect(manager.status().failures).toEqual([]);
		await bot.close();
	});

	it('removes a stale guild when the startup commits at GUILDS_READY, after every guild already settled', async () => {
		const left = guildOn(4);
		const adapter = new AsyncAdapter();
		leftover(adapter.memory, `guild.${left}`, 'guild');
		leftover(adapter.memory, 'role.r-left', `role.${left}`);
		const { bot, dispatch, manager } = await startReconciled(adapter);
		await dispatch(readyPacket({ guilds: [G] }));
		await dispatch(guildPacket('RAW_GUILD_CREATE', 2, snapshot(G)));
		await vi.waitFor(() => expect(manager.status().shards[0]!.settledGuilds).toBe(1));
		expect(adapter.memory.get(`guild.${left}`)).not.toBeNull();

		await dispatch(guildsReadyPacket(2));
		await manager.waitForIdle();

		expect(stored(adapter.memory)).toEqual([`guild.${G}`, `user.${BOT_ID}`]);
		await bot.close();
	});

	it('leaves a guild alone when the bot joined it again before its delete was cleaned up', async () => {
		const held = deferred();
		// Seyfert runs cache-resource callbacks in registration order, so this one delays the reconciler's.
		const slow = createPlugin({
			name: 'slow-observer',
			register(api) {
				api.cache.resource('slowObserver', BaseResource, {
					async onPacket(packet) {
						if (packet.t === 'GUILD_DELETE') await held.promise;
					},
				});
			},
		});
		const adapter = new MemoryAdapter();
		const { bot, client, dispatch, manager } = await startReconciled(adapter, { before: [slow] });
		await startup(dispatch, manager, snapshot(G, { roles: [{ id: 'r-old' }] }));

		const removal = dispatch(guildDeletePacket('GUILD_DELETE', 10, { id: G }));
		await settleMicrotasks();
		await dispatch(guildPacket('GUILD_CREATE', 11, snapshot(G, { name: 'rejoined', roles: [{ id: 'r-new' }] })));
		held.resolve();
		await removal;
		await manager.waitForIdle();

		// The delete at sequence 10 says nothing about the guild Discord reported at sequence 11.
		expect(adapter.get(`guild.${G}`)).toMatchObject({ name: 'rejoined' });
		expect(await client.cache.roles!.keys(G)).toEqual(['role.r-new']);
		expect(manager.status()).toMatchObject({ pending: { guilds: 0, deletions: 0 }, failures: [] });
		await bot.close();
	});

	it('does not close a guild the bot joined again while Seyfert was still removing it', async () => {
		const adapter = new AsyncAdapter();
		const { bot, client, dispatch, manager } = await startReconciled(adapter);
		await startup(dispatch, manager, snapshot(G, { roles: [{ id: 'r-old' }] }));
		const seyfertRemoval = deferred();
		adapter.gate('bulkRemove', seyfertRemoval.promise);

		const removal = dispatch(guildDeletePacket('GUILD_DELETE', 10, { id: G }));
		await settleMicrotasks();
		await dispatch(guildPacket('GUILD_CREATE', 11, snapshot(G, { roles: [{ id: 'r-new' }] })));
		seyfertRemoval.resolve();
		await removal;
		await manager.waitForIdle();

		// Seyfert's own late removal still takes the guild record; the reconciler adds nothing to that.
		expect(adapter.memory.get('role.r-new')).not.toBeNull();
		expect(await client.cache.roles!.keys(G)).toEqual(['role.r-new']);
		expect(manager.status().failures).toEqual([]);
		await bot.close();
	});

	it('keeps a stale guild hidden and reports it when its cleanup fails', async () => {
		const left = guildOn(4);
		const adapter = new AsyncAdapter();
		leftover(adapter.memory, `guild.${left}`, 'guild');
		leftover(adapter.memory, 'role.r-left', `role.${left}`);
		const failure = new Error('bulkRemove failed');
		adapter.failNext('bulkRemove', failure);
		const { bot, client, dispatch, manager } = await startReconciled(adapter);

		await startup(dispatch, manager, snapshot(G));

		expect(adapter.memory.get('role.r-left')).not.toBeNull();
		expect(await client.cache.guilds!.raw(left)).toBeUndefined();
		expect(manager.status()).toMatchObject({
			idle: true,
			shards: [{ startup: 'committed', outcomes: { reconciled: 1 } }],
			failures: [
				{ kind: 'removal', cause: failure },
				{ kind: 'guild', guildId: left, cause: failure },
			],
		});
		await bot.close();
	});

	it('removes the hidden descendants of a guild Discord reports as removed', async () => {
		const adapter = new MemoryAdapter();
		leftover(adapter, `member.${G}.u-legacy`, `member.${G}`);
		const { bot, dispatch, manager } = await startReconciled(adapter);
		await startup(dispatch, manager, snapshot(G, { roles: [{ id: 'r-1' }] }));
		// Seyfert's own removal only sees what callers can read, which does not include the old member.
		expect(adapter.get(`member.${G}.u-legacy`)).not.toBeNull();

		await dispatch(guildDeletePacket('GUILD_DELETE', 5, { id: G }));
		await manager.waitForIdle();

		expect(stored(adapter)).toEqual([`user.${BOT_ID}`]);
		expect(manager.status()).toMatchObject({ pending: { guilds: 0, deletions: 0 }, failures: [] });
		await bot.close();
	});
});

describe('teardown during reconciliation', () => {
	it('waits for a running sweep, which then deletes nothing', async () => {
		const adapter = new AsyncAdapter();
		leftover(adapter.memory, 'role.r-gone', `role.${G}`);
		const { bot, client, dispatch, manager } = await startReconciled(adapter);
		await dispatch(readyPacket({ guilds: [G] }));
		const discovery = deferred();
		adapter.gate('getToRelationship', discovery.promise);
		await dispatch(guildPacket('RAW_GUILD_CREATE', 2, snapshot(G)));
		expect(manager.status().pending.tasks).toBe(1);

		let closed = false;
		const closing = bot.close().then(() => {
			closed = true;
		});
		await settleMicrotasks();
		expect(closed).toBe(false);
		expect(manager.status()).toMatchObject({ lifecycle: 'closing', adapter: 'installed', pending: { tasks: 1 } });

		// A packet that arrives while the instance drains still reaches Seyfert, but registers nothing.
		await dispatch(guildPacket('RAW_GUILD_CREATE', 3, snapshot(guildOn(4))));
		expect(manager.status().pending.guilds).toBe(0);

		discovery.resolve();
		await closing;

		// Closing fenced the claim before the sweep reached its destructive boundary.
		expect(adapter.memory.get('role.r-gone')).not.toBeNull();
		expect(adapter.calls).not.toContain('remove');
		expect(client.cache.adapter).toBe(adapter);
		expect(manager.status()).toMatchObject({ lifecycle: 'closed', adapter: 'restored', pending: { tasks: 0 } });
	});
});
