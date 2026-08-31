import {
	type Adapter,
	BaseResource,
	CacheFrom,
	Client,
	createPlugin,
	GatewayDispatchEvents,
	type GatewayDispatchPayload,
	type GatewayGuildMemberUpdateDispatch,
	type GatewayGuildsReadyDispatch,
	GatewayOpcodes,
	type GatewayRawGuildCreateDispatch,
	GuildDefaultMessageNotifications,
	GuildExplicitContentFilter,
	GuildMemberFlags,
	GuildMFALevel,
	GuildNSFWLevel,
	GuildPremiumTier,
	GuildSystemChannelFlags,
	GuildVerificationLevel,
	MemoryAdapter,
	PluginOrder,
	setupClientPlugins,
	teardownClientPlugins,
	WorkerAdapter,
	WorkerClient,
} from 'seyfert';
import { assert, describe, expect, test } from 'vitest';
import { type CacheIntegrity, cacheIntegrity, localCoordinator } from '../src';
import { deferred } from './deferred';

class DispatchClient extends Client {
	dispatch(shardId: number, packet: GatewayDispatchPayload) {
		return this.onPacket(shardId, packet);
	}
}

class ProbeResource extends BaseResource {
	namespace = 'cacheIntegrityProbe';
}

class CountingAdapter extends MemoryAdapter<unknown> {
	starts = 0;

	start() {
		this.starts++;
	}
}

class OrderedAdapter extends MemoryAdapter<unknown> {
	constructor(private readonly order: string[]) {
		super();
	}

	bulkPatch(entries: [string, any][]) {
		this.order.push('core');
		return super.bulkPatch(entries);
	}
}

class FailingAdapter extends MemoryAdapter<unknown> {
	bulkPatch(entries: [string, any][]) {
		if (entries.some(([key]) => key.startsWith('guild.'))) throw new Error('core mutation failed');
		return super.bulkPatch(entries);
	}
}

class RedisLikeMemoryAdapter extends MemoryAdapter<unknown> {
	namespace = 'redis-like';

	scan(query: string, keys?: false): unknown[];
	scan(query: string, keys: true): string[];
	scan(query: string, keys?: boolean): (string | unknown)[] {
		return keys ? super.scan(this.buildKey(query), true) : super.scan(this.buildKey(query));
	}

	bulkGet(keys: string[]): unknown[] {
		return super.bulkGet(keys.map(key => this.buildKey(key)));
	}

	get(key: string): unknown | null {
		return super.get(this.buildKey(key));
	}

	set(key: string, data: unknown): void {
		super.set(this.buildKey(key), data);
	}

	keys(to: string): string[] {
		return super.keys(to).map(key => this.buildKey(key));
	}

	protected buildKey(key: string): string {
		return key.startsWith(`${this.namespace}:`) ? key : `${this.namespace}:${key}`;
	}
}

class SemanticNamespaceMemoryAdapter extends MemoryAdapter<unknown> {
	namespace = 'tenant';
}

function guildPacket(sequence: number, marker = 'default'): GatewayRawGuildCreateDispatch {
	return {
		d: {
			afk_channel_id: null,
			afk_timeout: 60,
			application_id: null,
			banner: null,
			channels: [],
			default_message_notifications: GuildDefaultMessageNotifications.AllMessages,
			description: marker,
			discovery_splash: null,
			emojis: [],
			explicit_content_filter: GuildExplicitContentFilter.Disabled,
			features: [],
			guild_scheduled_events: [],
			hub_type: null,
			icon: null,
			id: '175928847299117063',
			incidents_data: null,
			joined_at: '2026-01-01T00:00:00.000Z',
			large: false,
			member_count: 0,
			members: [],
			mfa_level: GuildMFALevel.None,
			name: 'fixture guild',
			nsfw_level: GuildNSFWLevel.Default,
			owner_id: '175928847299117066',
			preferred_locale: 'en-US',
			premium_progress_bar_enabled: false,
			premium_tier: GuildPremiumTier.None,
			presences: [],
			public_updates_channel_id: null,
			roles: [],
			rules_channel_id: null,
			safety_alerts_channel_id: null,
			soundboard_sounds: [],
			splash: null,
			stage_instances: [],
			system_channel_flags: GuildSystemChannelFlags.SuppressJoinNotifications,
			system_channel_id: null,
			threads: [],
			unavailable: false,
			vanity_url_code: null,
			verification_level: GuildVerificationLevel.None,
			voice_states: [],
		},
		op: GatewayOpcodes.Dispatch,
		s: sequence,
		t: GatewayDispatchEvents.RawGuildCreate,
	};
}

function readyPacket(
	sequence: number,
	guildIds: readonly string[] = [],
	username = 'reconciler',
): GatewayDispatchPayload {
	return {
		d: {
			application: { flags: 0, id: '175928847299117060' },
			guilds: guildIds.map(id => ({ id, unavailable: true })),
			resume_gateway_url: 'wss://gateway.discord.gg',
			session_id: `session-${sequence}`,
			shard: [0, 1],
			user: {
				accent_color: null,
				avatar: null,
				banner: null,
				bot: true,
				discriminator: '0',
				global_name: null,
				id: '175928847299117061',
				username,
			},
			v: 10,
		},
		op: GatewayOpcodes.Dispatch,
		s: sequence,
		t: GatewayDispatchEvents.Ready,
	} as unknown as GatewayDispatchPayload;
}

async function activateShard(client: DispatchClient, shardId: number, guildIds: readonly string[] = []): Promise<void> {
	await client.dispatch(shardId, readyPacket(1, guildIds));
}

function memberUpdatePacket(sequence: number): GatewayGuildMemberUpdateDispatch {
	return {
		d: {
			avatar: null,
			communication_disabled_until: null,
			flags: GuildMemberFlags.DidRejoin,
			guild_id: '175928847299117063',
			joined_at: '2026-01-01T00:00:00.000Z',
			nick: null,
			pending: false,
			roles: [],
			user: {
				accent_color: null,
				avatar: null,
				banner: null,
				discriminator: '0',
				global_name: null,
				id: '175928847299117065',
				username: 'member',
			},
		},
		op: GatewayOpcodes.Dispatch,
		s: sequence,
		t: GatewayDispatchEvents.GuildMemberUpdate,
	};
}

function guildsReadyPacket(sequence: number): GatewayGuildsReadyDispatch {
	return { op: GatewayOpcodes.Dispatch, s: sequence, t: GatewayDispatchEvents.GuildsReady };
}

function resumedPacket(sequence: number): GatewayDispatchPayload {
	return {
		op: GatewayOpcodes.Dispatch,
		s: sequence,
		t: GatewayDispatchEvents.Resumed,
	} as unknown as GatewayDispatchPayload;
}

function dispatchPacket(event: string, sequence: number, data: object): GatewayDispatchPayload {
	return {
		d: data,
		op: GatewayOpcodes.Dispatch,
		s: sequence,
		t: event,
	} as unknown as GatewayDispatchPayload;
}

function clonePacket(packet: GatewayRawGuildCreateDispatch): GatewayRawGuildCreateDispatch {
	return { ...packet, d: { ...packet.d } };
}

function reconcilerOf(client: object): CacheIntegrity {
	return (client as { cacheIntegrity: CacheIntegrity }).cacheIntegrity;
}

async function setup(client: DispatchClient | WorkerClient) {
	await setupClientPlugins(client, client.plugins);
}

async function createStartedClient(adapter: Adapter, plugins: unknown[]): Promise<DispatchClient> {
	const client = new DispatchClient({ plugins: plugins as never, logger: { active: false } });
	client.setServices({ cache: { adapter } });
	await setup(client);
	await client.cache.adapter.start();
	return client;
}

async function teardown(client: DispatchClient | WorkerClient) {
	await teardownClientPlugins(client, client.plugins);
}

describe('cacheIntegrity plugin', () => {
	test('installs onPacket after the startup cache refresh and restores both cache hooks cleanly', async () => {
		const reconciler = cacheIntegrity({ coordinator: localCoordinator() });
		const adapter = new CountingAdapter();
		const client = new DispatchClient({ plugins: [reconciler] as never, logger: { active: false } });
		client.setServices({ cache: { adapter } });
		const guilds = client.cache.guilds!;
		const originalOnPacket = client.cache.onPacket;
		const originalMemberCheck = client.memberUpdateHandler.check;
		const originalPresenceCheck = client.presenceUpdateHandler.check;
		const originalBulkSet = client.cache.bulkSet;
		const originalBulkPatch = client.cache.bulkPatch;
		const originalOverwriteSet = client.cache.overwrites!.set;
		const originalOverwritePatch = client.cache.overwrites!.patch;

		await setup(client);

		assert.notEqual(client.cache.adapter, adapter);
		assert.equal(client.cache.onPacket, originalOnPacket);
		client.cache.buildCache({}, client as never);
		const refreshedOnPacket = client.cache.onPacket;
		assert.notEqual(refreshedOnPacket, originalOnPacket);
		await client.cache.adapter.start();
		await client.cache.adapter.start();
		assert.notEqual(client.cache.onPacket, refreshedOnPacket);
		assert.notEqual(client.memberUpdateHandler.check, originalMemberCheck);
		assert.notEqual(client.presenceUpdateHandler.check, originalPresenceCheck);
		assert.notEqual(client.cache.bulkSet, originalBulkSet);
		assert.notEqual(client.cache.bulkPatch, originalBulkPatch);
		assert.notEqual(client.cache.overwrites!.set, originalOverwriteSet);
		assert.notEqual(client.cache.overwrites!.patch, originalOverwritePatch);
		assert.equal(client.cache.guilds!.adapter, client.cache.adapter);
		assert.equal(guilds.adapter, client.cache.adapter);
		assert.equal(adapter.starts, 1);
		assert.equal(reconcilerOf(client).status().lifecycle, 'active');
		await activateShard(client, 1);
		await client.dispatch(1, guildPacket(80));
		assert.equal(reconcilerOf(client).status().correlation.matched, 2);
		const wrappedOnPacket = client.cache.onPacket;

		await teardown(client);
		assert.equal(client.cache.adapter, adapter);
		assert.notEqual(client.cache.onPacket, wrappedOnPacket);
		assert.equal(client.memberUpdateHandler.check, originalMemberCheck);
		assert.equal(client.presenceUpdateHandler.check, originalPresenceCheck);
		assert.equal(client.cache.bulkSet, originalBulkSet);
		assert.equal(client.cache.bulkPatch, originalBulkPatch);
		assert.equal(client.cache.overwrites!.set, originalOverwriteSet);
		assert.equal(client.cache.overwrites!.patch, originalOverwritePatch);
		const status = reconcilerOf(client).status();
		assert.equal(status.adapter, 'detached');
		assert.equal(status.lifecycle, 'closed');
		assert.notInclude(
			status.diagnostics.map(item => item.code),
			'adapter-replaced',
		);
	});

	test('filters Redis-like physical scan and keys output through the public plugin path', async () => {
		const visibleId = '175928847299117061';
		const ghostId = '175928847299117099';
		const adapter = new RedisLikeMemoryAdapter();
		const reconciler = cacheIntegrity({ coordinator: localCoordinator() });
		const client = await createStartedClient(adapter, [reconciler]);
		await activateShard(client, 0);

		adapter.set(`user.${ghostId}`, { id: ghostId, username: 'ghost' });
		adapter.addToRelationship('user', ghostId);
		const visibleKey = `${adapter.namespace}:user.${visibleId}`;
		const ghostKey = `${adapter.namespace}:user.${ghostId}`;
		assert.deepEqual(adapter.scan('user.*', true), [visibleKey, ghostKey]);
		assert.deepEqual(adapter.keys('user'), [visibleKey, ghostKey]);

		assert.deepEqual(await client.cache.adapter.scan('user.*', true), [visibleKey]);
		assert.deepEqual(await client.cache.users?.keys(), [visibleKey]);
		expect(await client.cache.users?.raw(visibleId)).toMatchObject({ id: visibleId, username: 'reconciler' });
		await teardown(client);
	});

	test('preserves colon-delimited custom keys when namespace is not a physical-prefix capability', async () => {
		const visibleId = '175928847299117061';
		const adapter = new SemanticNamespaceMemoryAdapter();
		const reconciler = cacheIntegrity({ coordinator: localCoordinator() });
		const client = await createStartedClient(adapter, [reconciler]);
		await activateShard(client, 0);

		const customKey = `tenant:user.${visibleId}`;
		await client.cache.adapter.set(customKey, { id: 'custom' });
		await client.cache.adapter.remove(customKey);

		expect(await client.cache.users?.raw(visibleId)).toMatchObject({ id: visibleId, username: 'reconciler' });
		await teardown(client);
	});

	test('teardown before adapter start closes a one-shot installation cleanly', async () => {
		let closes = 0;
		const reconciler = cacheIntegrity({
			coordinator: {
				kind: 'test',
				start() {},
				close() {
					closes++;
				},
			},
		});
		const adapter = new MemoryAdapter();
		const client = new DispatchClient({ plugins: [reconciler] as never, logger: { active: false } });
		client.setServices({ cache: { adapter } });
		await setup(client);
		const wrappedAdapter = client.cache.adapter;

		await teardown(client);

		assert.equal(client.cache.adapter, adapter);
		assert.equal(closes, 1);
		assert.equal(reconcilerOf(client).status().lifecycle, 'closed');
		expect(() => wrappedAdapter.start()).toThrow(/closed/);
	});

	test('rejects setup when an earlier resolved plugin contributes gateway.onDispatch', async () => {
		const earlier = createPlugin({
			name: 'earlier-interceptor',
			register(api) {
				api.gateway.onDispatch((_packet, next) => next(), { order: PluginOrder.Before });
			},
		});
		const reconciler = cacheIntegrity({ coordinator: localCoordinator() });
		const adapter = new MemoryAdapter();
		const client = new DispatchClient({ plugins: [earlier, reconciler] as never, logger: { active: false } });
		client.setServices({ cache: { adapter } });
		const originalOnPacket = client.cache.onPacket;

		expect(() => reconciler.setup?.(client as never)).toThrow(/must be the first resolved plugin.*earlier-interceptor/);
		assert.equal(client.cache.adapter, adapter);
		assert.equal(client.cache.onPacket, originalOnPacket);
	});

	test('runs core cache mutation before cache resources and transformed listeners', async () => {
		const order: string[] = [];
		let cachedGuild: unknown;
		const reconciler = cacheIntegrity({ coordinator: localCoordinator() });
		const probe = createPlugin({
			name: 'post-cache-order-probe',
			register(api) {
				api.cache.resource('cacheIntegrityProbe', ProbeResource, {
					intents: ['Guilds'],
					async onPacket(event, cache) {
						order.push('resource');
						cachedGuild = await cache.guilds?.raw((event.d as { id: string }).id);
					},
				});
				api.events.on('RAW_GUILD_CREATE', () => {
					order.push('listener');
				});
			},
		});
		const client = await createStartedClient(new OrderedAdapter(order), [reconciler, probe]);
		await activateShard(client, 7);
		order.length = 0;
		cachedGuild = undefined;

		await client.dispatch(7, guildPacket(91));

		assert.deepEqual(order, ['core', 'resource', 'listener']);
		expect(cachedGuild).toMatchObject({
			description: 'default',
			id: '175928847299117063',
			unavailable: false,
		});
		assert.equal(reconcilerOf(client).status().correlation.matched, 2);
		await teardown(client);
	});

	test('correlates downstream replacements with identical payloads in reverse completion', async () => {
		const firstGate = deferred();
		const secondGate = deferred();
		const firstEntered = deferred();
		const secondEntered = deferred();
		const reconciler = cacheIntegrity({ coordinator: localCoordinator() });
		const replacer = createPlugin({
			name: 'downstream-replacer',
			register(api) {
				api.gateway.onDispatch(
					async (packet, next) => {
						if (packet.t !== GatewayDispatchEvents.RawGuildCreate) return next();
						const marker = packet.d.description;
						(marker === 'first' ? firstEntered : secondEntered).resolve();
						await (marker === 'first' ? firstGate : secondGate).promise;
						const result = await next(clonePacket(packet));
						return result?.t === GatewayDispatchEvents.RawGuildCreate ? clonePacket(result) : result;
					},
					{ order: PluginOrder.Before },
				);
			},
		});
		const client = await createStartedClient(new MemoryAdapter(), [reconciler, replacer]);
		await activateShard(client, 4);

		const first = client.dispatch(4, guildPacket(100, 'first'));
		const second = client.dispatch(4, guildPacket(101, 'second'));
		await Promise.all([firstEntered.promise, secondEntered.promise]);
		secondGate.resolve();
		await second;
		firstGate.resolve();
		await first;

		assert.deepEqual(reconcilerOf(client).status().correlation, {
			failed: 0,
			matched: 3,
			pending: 0,
			settled: 3,
		});
		await teardown(client);
	});

	test('fails terminally and drains pending work when the adapter is replaced', async () => {
		const gate = deferred();
		const entered = deferred();
		const reconciler = cacheIntegrity({ coordinator: localCoordinator() });
		const delay = createPlugin({
			name: 'pending-packet-delay',
			register(api) {
				api.gateway.onDispatch(async (packet, next) => {
					if (packet.t !== GatewayDispatchEvents.RawGuildCreate) return next();
					entered.resolve();
					await gate.promise;
					return next();
				});
			},
		});
		const original = new MemoryAdapter();
		const replacement = new MemoryAdapter();
		const client = await createStartedClient(original, [reconciler, delay]);
		await activateShard(client, 1);
		const dispatch = client.dispatch(1, guildPacket(120));
		await entered.promise;

		client.cache.adapter = replacement;
		await reconcilerOf(client).waitForIdle();
		const status = reconcilerOf(client).status();
		assert.equal(status.adapter, 'replaced');
		assert.equal(status.lifecycle, 'failed');
		assert.equal(status.correlation.pending, 0);
		gate.resolve();
		await dispatch;

		await teardown(client);
		assert.equal(client.cache.adapter, replacement);
		assert.equal(reconcilerOf(client).status().adapter, 'detached');
	});

	test('revalidates cache onPacket ownership after an awaited downstream interceptor', async () => {
		const gate = deferred();
		const entered = deferred();
		const reconciler = cacheIntegrity({ coordinator: localCoordinator() });
		const delay = createPlugin({
			name: 'cache-handler-replacement-delay',
			register(api) {
				api.gateway.onDispatch(async (packet, next) => {
					if (packet.t !== GatewayDispatchEvents.RawGuildCreate) return next();
					entered.resolve();
					await gate.promise;
					return next();
				});
			},
		});
		const client = await createStartedClient(new MemoryAdapter(), [reconciler, delay]);
		await activateShard(client, 1);
		const dispatch = client.dispatch(1, guildPacket(125));
		await entered.promise;

		client.cache.onPacket = async () => {};
		gate.resolve();
		await dispatch;
		await reconcilerOf(client).waitForIdle();

		const status = reconcilerOf(client).status();
		assert.equal(status.lifecycle, 'failed');
		assert.equal(status.correlation.pending, 0);
		assert.include(
			status.diagnostics.map(item => item.code),
			'cache-handler-replaced',
		);
		await teardown(client);
	});

	test('fails terminally when core cache mutation throws', async () => {
		const reconciler = cacheIntegrity({ coordinator: localCoordinator() });
		const client = await createStartedClient(new FailingAdapter(), [reconciler]);
		await activateShard(client, 1);

		await expect(client.dispatch(1, guildPacket(130))).rejects.toThrow('core mutation failed');

		const status = reconcilerOf(client).status();
		assert.equal(status.lifecycle, 'failed');
		assert.equal(status.correlation.pending, 0);
		assert.include(
			status.diagnostics.map(item => item.code),
			'core-cache-failed',
		);
		await teardown(client);
	});

	test('deactivates the coordinator exactly once on terminal plugin failure', async () => {
		let deactivations = 0;
		const coordinator = {
			kind: 'deactivation-probe',
			start() {},
			close() {},
			bind() {
				return {
					deactivate() {
						deactivations++;
					},
				};
			},
		};
		const reconciler = cacheIntegrity({ coordinator });
		const client = await createStartedClient(new FailingAdapter(), [reconciler]);
		await activateShard(client, 1);

		await expect(client.dispatch(1, guildPacket(131))).rejects.toThrow('core mutation failed');
		reconcilerOf(client).status();

		assert.equal(deactivations, 1);
		await teardown(client);
	});

	test('fails terminally when core onPacket is disabled', async () => {
		const reconciler = cacheIntegrity({ coordinator: localCoordinator() });
		const client = new DispatchClient({ plugins: [reconciler] as never, logger: { active: false } });
		client.setServices({ cache: { adapter: new MemoryAdapter(), disabledCache: { onPacket: true } } });
		await setup(client);
		await client.cache.adapter.start();

		await activateShard(client, 1);

		const status = reconcilerOf(client).status();
		assert.equal(status.lifecycle, 'failed');
		assert.equal(status.correlation.pending, 0);
		assert.include(
			status.diagnostics.map(item => item.code),
			'post-cache-observer-missing',
		);
		await teardown(client);
	});

	test('settles duplicate-filter early-return events without waiting for core cache', async () => {
		const reconciler = cacheIntegrity({ coordinator: localCoordinator() });
		const client = await createStartedClient(new MemoryAdapter(), [reconciler]);
		await activateShard(client, 1);
		const before = reconcilerOf(client).status().correlation;
		const update = memberUpdatePacket(150);

		await client.dispatch(1, update);
		await client.dispatch(1, { ...update, s: 151 });

		assert.deepEqual(reconcilerOf(client).status().correlation, {
			failed: before.failed,
			matched: before.matched + 1,
			pending: 0,
			settled: before.settled + 2,
		});
		await teardown(client);
	});

	test('fences delayed member and presence updates when READY replaces their generation', async () => {
		const guildId = '175928847299117063';
		const userId = '175928847299117065';
		const gate = deferred();
		const memberEntered = deferred();
		const presenceEntered = deferred();
		const reconciler = cacheIntegrity({ coordinator: localCoordinator() });
		const delay = createPlugin({
			name: 'stale-generation-update-delay',
			register(api) {
				api.gateway.onDispatch(async (packet, next) => {
					if (packet.t === GatewayDispatchEvents.GuildMemberUpdate) {
						memberEntered.resolve();
					} else if (packet.t === GatewayDispatchEvents.PresenceUpdate) {
						presenceEntered.resolve();
					} else {
						return next();
					}
					await gate.promise;
					return next();
				});
			},
		});
		const inner = new MemoryAdapter();
		const client = await createStartedClient(inner, [reconciler, delay]);
		(client as unknown as { gateway: Map<number, { isReady: boolean }> }).gateway = new Map();
		await activateShard(client, 0);
		const baseline = reconcilerOf(client).status().correlation.matched;

		const member = client.dispatch(0, memberUpdatePacket(151));
		const presence = client.dispatch(
			0,
			dispatchPacket(GatewayDispatchEvents.PresenceUpdate, 152, {
				activities: [],
				client_status: {},
				guild_id: guildId,
				status: 'online',
				user: { id: userId },
			}),
		);
		await Promise.all([memberEntered.promise, presenceEntered.promise]);
		await client.dispatch(0, readyPacket(153));
		await client.dispatch(0, guildsReadyPacket(153));
		gate.resolve();
		await Promise.all([member, presence]);
		await reconcilerOf(client).waitForIdle();

		assert.equal(inner.get(`member.${guildId}.${userId}`), null);
		assert.equal(inner.get(`presence.${userId}`), null);
		assert.equal(inner.get(`user.${userId}`), null);
		assert.deepEqual(inner.getToRelationship(`member.${guildId}`), []);
		assert.deepEqual(inner.getToRelationship(`presence.${guildId}`), []);
		assert.equal(reconcilerOf(client).status().correlation.matched - baseline, 3);
		assert.equal(reconcilerOf(client).status().correlation.failed, 0);
		await teardown(client);
	});

	test.each([
		'veto',
		'throw',
		'identity',
	] as const)('ignores a delayed READY %s after a replacement READY becomes current', async outcome => {
		const gate = deferred();
		const entered = deferred();
		const reconciler = cacheIntegrity({ coordinator: localCoordinator() });
		const delay = createPlugin({
			name: `stale-ready-${outcome}`,
			register(api) {
				api.gateway.onDispatch(async (packet, next) => {
					if (packet.t !== GatewayDispatchEvents.Ready || packet.s !== 150) return next();
					entered.resolve();
					await gate.promise;
					if (outcome === 'veto') return null;
					if (outcome === 'throw') throw new Error('stale READY rejected');
					const result = await next();
					return result ? { ...result, s: result.s + 1 } : result;
				});
			},
		});
		const inner = new MemoryAdapter();
		const client = await createStartedClient(inner, [reconciler, delay]);
		(client as unknown as { gateway: Map<number, { isReady: boolean }> }).gateway = new Map();
		await activateShard(client, 0);

		const stale = client.dispatch(0, readyPacket(150, [], 'stale'));
		await entered.promise;
		await client.dispatch(0, readyPacket(200, [], 'current'));
		await client.dispatch(0, guildsReadyPacket(201));
		gate.resolve();
		if (outcome === 'throw') await expect(stale).rejects.toThrow('stale READY rejected');
		else if (outcome === 'identity') assert.isNull(await stale);
		else await stale;
		await reconcilerOf(client).waitForIdle();

		const status = reconcilerOf(client).status();
		assert.equal(status.lifecycle, 'active');
		assert.notInclude(
			status.diagnostics.map(diagnostic => diagnostic.code),
			outcome === 'veto' ? 'ready-vetoed' : outcome === 'throw' ? 'ready-downstream-failed' : 'packet-identity-failed',
		);
		expect(inner.get('user.175928847299117061')).toMatchObject({ username: 'current' });
		await teardown(client);
	});

	test('settles a delayed channel delete after READY replaces its generation', async () => {
		const guildId = '175928847299117063';
		const channelId = '175928847299117080';
		const gate = deferred();
		const entered = deferred();
		const reconciler = cacheIntegrity({ coordinator: localCoordinator() });
		const delay = createPlugin({
			name: 'stale-channel-delete-delay',
			register(api) {
				api.gateway.onDispatch(async (packet, next) => {
					if (packet.t !== GatewayDispatchEvents.ChannelDelete) return next();
					entered.resolve();
					await gate.promise;
					return next();
				});
			},
		});
		const inner = new MemoryAdapter();
		const client = new DispatchClient({ plugins: [reconciler, delay] as never, logger: { active: false } });
		client.setServices({ cache: { adapter: inner } });
		const gateway = Object.assign(new Map<number, { isReady: boolean }>(), {
			calculateShardId: () => 0,
		});
		(client as unknown as { gateway: typeof gateway }).gateway = gateway;
		await setup(client);
		await client.cache.adapter.start();
		await activateShard(client, 0);
		await client.dispatch(
			0,
			dispatchPacket(GatewayDispatchEvents.ChannelCreate, 220, {
				guild_id: guildId,
				id: channelId,
				name: 'stale channel',
				permission_overwrites: [],
				position: 0,
				type: 0,
			}),
		);
		const delayed = client.dispatch(
			0,
			dispatchPacket(GatewayDispatchEvents.ChannelDelete, 221, {
				guild_id: guildId,
				id: channelId,
				name: 'stale channel',
				position: 0,
				type: 0,
			}),
		);
		await entered.promise;
		await client.dispatch(0, readyPacket(300));
		await client.dispatch(0, guildsReadyPacket(300));
		gate.resolve();
		await delayed;
		await reconcilerOf(client).waitForIdle();

		assert.isNotNull(inner.get(`channel.${channelId}`));
		assert.equal(await client.cache.channels?.raw(channelId), null);
		assert.equal(reconcilerOf(client).status().lifecycle, 'active');
		assert.equal(reconcilerOf(client).status().correlation.failed, 0);
		assert.equal(reconcilerOf(client).status().correlation.pending, 0);
		await teardown(client);
	});

	test('does not identity-track producer-shaped GUILDS_READY packets without d', async () => {
		const reconciler = cacheIntegrity({ coordinator: localCoordinator() });
		const client = await createStartedClient(new MemoryAdapter(), [reconciler]);
		(client as unknown as { gateway: Map<number, { isReady: boolean }> }).gateway = new Map();
		await activateShard(client, 1);
		const before = reconcilerOf(client).status().correlation;
		let idle = false;
		const waiting = reconcilerOf(client)
			.waitForIdle()
			.then(() => {
				idle = true;
			});
		await Promise.resolve();
		assert.isFalse(idle);

		await client.dispatch(1, guildsReadyPacket(160));
		await waiting;

		assert.deepEqual(reconcilerOf(client).status().correlation, before);
		assert.isTrue(idle);
		assert.equal(reconcilerOf(client).status().lifecycle, 'active');
		await teardown(client);
	});

	test('ignores a delayed GUILDS_READY after READY replaces its generation', async () => {
		const gate = deferred();
		const entered = deferred();
		const reconciler = cacheIntegrity({ coordinator: localCoordinator() });
		const delay = createPlugin({
			name: 'stale-guilds-ready-delay',
			register(api) {
				api.gateway.onDispatch(async (packet, next) => {
					if (packet.t !== GatewayDispatchEvents.GuildsReady || packet.s !== 150) return next();
					entered.resolve();
					await gate.promise;
					return next();
				});
			},
		});
		const client = await createStartedClient(new MemoryAdapter(), [reconciler, delay]);
		(client as unknown as { gateway: Map<number, { isReady: boolean }> }).gateway = new Map();
		await activateShard(client, 0);

		const stale = client.dispatch(0, guildsReadyPacket(150));
		await entered.promise;
		await client.dispatch(0, readyPacket(200));
		await client.dispatch(0, guildsReadyPacket(201));
		gate.resolve();
		await stale;
		await reconcilerOf(client).waitForIdle();

		const status = reconcilerOf(client).status();
		assert.equal(status.lifecycle, 'active');
		assert.notInclude(
			status.diagnostics.map(diagnostic => diagnostic.code),
			'guilds-ready-bookkeeping-failed',
		);
		await teardown(client);
	});

	test('keeps the startup barrier pending when GUILDS_READY overtakes an admitted RAW guild', async () => {
		const gate = deferred();
		const entered = deferred();
		const reconciler = cacheIntegrity({ coordinator: localCoordinator() });
		const delay = createPlugin({
			name: 'late-raw-guild',
			register(api) {
				api.gateway.onDispatch(async (packet, next) => {
					if (packet.t !== GatewayDispatchEvents.RawGuildCreate) return next();
					entered.resolve();
					await gate.promise;
					return next();
				});
			},
		});
		const client = await createStartedClient(new MemoryAdapter(), [reconciler, delay]);
		(client as unknown as { gateway: Map<number, { isReady: boolean }> }).gateway = new Map();
		await activateShard(client, 3, ['175928847299117063']);

		const raw = client.dispatch(3, guildPacket(170));
		await entered.promise;
		await client.dispatch(3, guildsReadyPacket(170));
		let idle = false;
		const waiting = reconcilerOf(client)
			.waitForIdle()
			.then(() => {
				idle = true;
			});
		await Promise.resolve();
		assert.isFalse(idle);

		gate.resolve();
		await Promise.all([raw, waiting]);
		assert.isTrue(idle);
		expect(await client.cache.guilds?.raw('175928847299117063')).toMatchObject({ unavailable: false });
		assert.deepEqual(reconcilerOf(client).status().correlation, {
			failed: 0,
			matched: 2,
			pending: 0,
			settled: 2,
		});
		await teardown(client);
	});

	test('fails closed instead of stranding the startup barrier when GUILDS_READY is vetoed', async () => {
		const reconciler = cacheIntegrity({ coordinator: localCoordinator() });
		const veto = createPlugin({
			name: 'guilds-ready-veto',
			register(api) {
				api.gateway.onDispatch((packet, next) => (packet.t === GatewayDispatchEvents.GuildsReady ? null : next()));
			},
		});
		const client = await createStartedClient(new MemoryAdapter(), [reconciler, veto]);
		(client as unknown as { gateway: Map<number, { isReady: boolean }> }).gateway = new Map();
		await activateShard(client, 0);

		await client.dispatch(0, guildsReadyPacket(1));
		await reconcilerOf(client).waitForIdle();

		const status = reconcilerOf(client).status();
		assert.equal(status.lifecycle, 'failed');
		assert.equal(status.correlation.pending, 0);
		assert.include(
			status.diagnostics.map(diagnostic => diagnostic.code),
			'guilds-ready-vetoed',
		);
		await teardown(client);
	});

	test('delegates RESUMED without d until READY establishes owned generation state', async () => {
		const guildId = '175928847299117063';
		const inner = new MemoryAdapter();
		inner.set(`guild.${guildId}`, { id: guildId, name: 'legacy' });
		inner.addToRelationship('guild', guildId);
		const reconciler = cacheIntegrity({ coordinator: localCoordinator() });
		const client = await createStartedClient(inner, [reconciler]);

		assert.equal(await client.cache.guilds?.raw(guildId), null);
		await client.dispatch(2, resumedPacket(10));
		assert.equal(reconcilerOf(client).status().lifecycle, 'active');
		expect(inner.get(`guild.${guildId}`)).toMatchObject({ name: 'legacy' });
		assert.equal(await client.cache.guilds?.raw(guildId), null);

		(client as unknown as { gateway: Map<number, { isReady: boolean }> }).gateway = new Map();
		await client.dispatch(2, readyPacket(11, [guildId]));
		await client.dispatch(2, guildPacket(12));
		await client.dispatch(2, guildsReadyPacket(12));
		await reconcilerOf(client).waitForIdle();
		expect(await client.cache.guilds?.raw(guildId)).toMatchObject({ name: 'fixture guild' });
		assert.equal(reconcilerOf(client).status().correlation.failed, 0);
		await teardown(client);
	});

	test('prepares authoritative optional fields from the final downstream payload', async () => {
		const guildId = '175928847299117063';
		const stickerId = '175928847299117070';
		const inner = new MemoryAdapter();
		inner.set(`sticker.${stickerId}`, { guild_id: guildId, id: stickerId });
		inner.addToRelationship(`sticker.${guildId}`, stickerId);
		const reconciler = cacheIntegrity({ coordinator: localCoordinator() });
		const finalizer = createPlugin({
			name: 'final-snapshot-payload',
			register(api) {
				api.gateway.onDispatch((packet, next) => {
					if (packet.t !== GatewayDispatchEvents.RawGuildCreate) return next();
					return next({ ...packet, d: { ...packet.d, stickers: [] } });
				});
			},
		});
		const client = await createStartedClient(inner, [reconciler, finalizer]);
		(client as unknown as { gateway: Map<number, { isReady: boolean }> }).gateway = new Map();
		await activateShard(client, 0, [guildId]);

		await client.dispatch(0, guildPacket(180));
		await client.dispatch(0, guildsReadyPacket(180));
		await reconcilerOf(client).waitForIdle();

		assert.equal(inner.get(`sticker.${stickerId}`), null);
		assert.deepEqual(inner.getToRelationship(`sticker.${guildId}`), []);
		assert.equal(reconcilerOf(client).status().correlation.failed, 0);
		await teardown(client);
	});

	test('treats RAW guilds as disabled-preserved and skips stale-guild sweeping when guild cache is disabled', async () => {
		const guildId = '175928847299117063';
		const roleId = '175928847299117071';
		const inner = new MemoryAdapter();
		inner.set(`guild.${guildId}`, { id: guildId, name: 'legacy' });
		inner.addToRelationship('guild', guildId);
		inner.set(`role.${roleId}`, { id: roleId });
		inner.addToRelationship(`role.${guildId}`, roleId);
		const reconciler = cacheIntegrity({ coordinator: localCoordinator() });
		const client = new DispatchClient({ plugins: [reconciler] as never, logger: { active: false } });
		client.setServices({ cache: { adapter: inner, disabledCache: { guilds: true } } });
		await setup(client);
		await client.cache.adapter.start();
		(client as unknown as { gateway: Map<number, { isReady: boolean }> }).gateway = new Map();

		await activateShard(client, 0, [guildId]);
		await client.dispatch(0, guildPacket(190));
		await client.dispatch(0, guildsReadyPacket(190));
		await reconcilerOf(client).waitForIdle();

		assert.equal(client.cache.guilds, undefined);
		expect(inner.get(`guild.${guildId}`)).toMatchObject({ name: 'legacy' });
		expect(inner.get(`role.${roleId}`)).toMatchObject({ id: roleId });
		assert.deepEqual(inner.getToRelationship('guild'), [guildId]);
		assert.deepEqual(inner.getToRelationship(`role.${guildId}`), [roleId]);
		assert.equal(reconcilerOf(client).status().lifecycle, 'active');
		await teardown(client);
	});

	test('tracks message mutation and voice channel status events through the real cache pipeline', async () => {
		const guildId = '175928847299117063';
		const channelId = '175928847299117073';
		const userId = '175928847299117074';
		const messages = ['175928847299117075', '175928847299117076', '175928847299117077'];
		const inner = new MemoryAdapter();
		const reconciler = cacheIntegrity({ coordinator: localCoordinator() });
		const client = await createStartedClient(inner, [reconciler]);
		(client as unknown as { gateway: Map<number, { isReady: boolean }> }).gateway = new Map();
		(client as unknown as { handleCommand: { message(): Promise<void> } }).handleCommand = {
			async message() {},
		};
		await activateShard(client, 0);
		await client.dispatch(0, guildsReadyPacket(1));
		const baseline = reconcilerOf(client).status().correlation.matched;
		const message = (id: string, content: string) => ({
			author: { discriminator: '0', id: userId, username: 'author' },
			channel_id: channelId,
			content,
			guild_id: guildId,
			id,
		});

		await client.dispatch(0, dispatchPacket('MESSAGE_CREATE', 210, message(messages[0]!, 'one')));
		await client.dispatch(0, dispatchPacket('MESSAGE_UPDATE', 211, message(messages[0]!, 'updated')));
		await client.dispatch(
			0,
			dispatchPacket('MESSAGE_DELETE', 212, { channel_id: channelId, guild_id: guildId, id: messages[0] }),
		);
		await client.dispatch(0, dispatchPacket('MESSAGE_CREATE', 213, message(messages[1]!, 'two')));
		await client.dispatch(0, dispatchPacket('MESSAGE_CREATE', 214, message(messages[2]!, 'three')));
		await client.dispatch(
			0,
			dispatchPacket('MESSAGE_DELETE_BULK', 215, { channel_id: channelId, guild_id: guildId, ids: messages.slice(1) }),
		);
		await client.dispatch(
			0,
			dispatchPacket('VOICE_CHANNEL_STATUS_UPDATE', 216, { guild_id: guildId, id: channelId, status: 'Town hall' }),
		);
		await reconcilerOf(client).waitForIdle();

		assert.equal(reconcilerOf(client).status().correlation.matched - baseline, 7);
		assert.equal(reconcilerOf(client).status().correlation.failed, 0);
		for (const messageId of messages) assert.equal(inner.get(`message.${messageId}`), null);
		assert.deepEqual(inner.getToRelationship(`message.${channelId}`), []);
		expect(await client.cache.channels?.raw(channelId)).toMatchObject({ status: 'Town hall' });
		await teardown(client);
	});

	test('keeps contextless REST messages and empty overwrite sets readable', async () => {
		const guildId = '175928847299117063';
		const guildChannelId = '175928847299117081';
		const dmChannelId = '175928847299117082';
		const overwriteChannelId = '175928847299117083';
		const guildMessageId = '175928847299117084';
		const dmMessageId = '175928847299117085';
		const userId = '175928847299117086';
		const inner = new MemoryAdapter();
		const reconciler = cacheIntegrity({ coordinator: localCoordinator() });
		const client = new DispatchClient({ plugins: [reconciler] as never, logger: { active: false } });
		client.setServices({ cache: { adapter: inner } });
		const gateway = Object.assign(new Map<number, { isReady: boolean }>(), {
			calculateShardId: () => 0,
		});
		(client as unknown as { gateway: typeof gateway }).gateway = gateway;
		await setup(client);
		await client.cache.adapter.start();
		await activateShard(client, 0);

		await client.cache.messages?.set(CacheFrom.Rest, guildMessageId, guildChannelId, {
			author: { discriminator: '0', id: userId, username: 'rest-author' },
			channel_id: guildChannelId,
			content: 'guild message',
			guild_id: guildId,
			id: guildMessageId,
		});
		await client.cache.messages?.set(CacheFrom.Rest, dmMessageId, dmChannelId, {
			author: { discriminator: '0', id: userId, username: 'rest-author' },
			channel_id: dmChannelId,
			content: 'dm message',
			id: dmMessageId,
		});
		await client.cache.overwrites?.set(CacheFrom.Rest, overwriteChannelId, guildId, []);

		expect(await client.cache.messages?.raw(guildMessageId)).toMatchObject({
			channel_id: guildChannelId,
			content: 'guild message',
			guild_id: guildId,
			id: guildMessageId,
		});
		expect(await client.cache.messages?.raw(dmMessageId)).toMatchObject({
			channel_id: dmChannelId,
			content: 'dm message',
			id: dmMessageId,
		});
		assert.deepEqual(await client.cache.messages?.getToRelationship(guildChannelId), [guildMessageId]);
		assert.deepEqual(await client.cache.messages?.getToRelationship(dmChannelId), [dmMessageId]);
		assert.deepEqual(await client.cache.overwrites?.raw(overwriteChannelId), []);
		assert.deepEqual(await client.cache.overwrites?.getToRelationship(guildId), [overwriteChannelId]);
		await teardown(client);
	});

	test('drains an executing snapshot before restore and gates packets arriving during close', async () => {
		const guildId = '175928847299117063';
		const staleRoleId = '175928847299117072';
		const relationshipGate = deferred();
		const relationshipRead = deferred();
		const memory = new MemoryAdapter();
		memory.set(`role.${staleRoleId}`, { id: staleRoleId });
		memory.addToRelationship(`role.${guildId}`, staleRoleId);
		let blocked = false;
		const inner = new Proxy(memory, {
			get(target, property, receiver) {
				if (property === 'isAsync') return true;
				if (property === 'getToRelationship') {
					return async (to: string) => {
						if (!blocked && to === `role.${guildId}`) {
							blocked = true;
							relationshipRead.resolve();
							await relationshipGate.promise;
						}
						return target.getToRelationship(to);
					};
				}
				const value = Reflect.get(target, property, receiver);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
		const reconciler = cacheIntegrity({ coordinator: localCoordinator() });
		const client = new DispatchClient({ plugins: [reconciler] as never, logger: { active: false } });
		client.setServices({ cache: { adapter: inner } });
		await setup(client);
		const defaultOnPacket = client.cache.onPacket;
		const originalOnPacket = (event: GatewayDispatchPayload) => defaultOnPacket.call(client.cache, event);
		client.cache.onPacket = originalOnPacket;
		await client.cache.adapter.start();
		await activateShard(client, 0);
		const first = client.dispatch(0, guildPacket(200));
		await relationshipRead.promise;

		let closed = false;
		const closing = Promise.resolve(reconciler.teardown?.(client as never, undefined as never)).then(() => {
			closed = true;
		});
		let lateSettled = false;
		const late = client.dispatch(0, guildPacket(201, 'late')).then(() => {
			lateSettled = true;
		});
		await Promise.resolve();
		assert.isFalse(closed);
		assert.isFalse(lateSettled);
		assert.equal(reconcilerOf(client).status().lifecycle, 'closing');

		relationshipGate.resolve();
		await Promise.all([first, closing, late]);
		assert.equal(client.cache.adapter, inner);
		assert.equal(client.cache.onPacket, originalOnPacket);
		expect(memory.get(`role.${staleRoleId}`)).toMatchObject({ id: staleRoleId });
		expect(memory.get(`guild.${guildId}`)).toMatchObject({ description: 'late' });
		assert.equal(reconcilerOf(client).status().correlation.pending, 0);
		assert.equal(reconcilerOf(client).status().lifecycle, 'closed');
		await teardown(client);
	});

	test('rejects WorkerAdapter but accepts WorkerClient with a real adapter', async () => {
		const rejectedReconciler = cacheIntegrity({ coordinator: localCoordinator() });
		const workerAdapter = new WorkerAdapter({ workerId: 1 } as never);
		const rejected = new WorkerClient({ plugins: [rejectedReconciler] as never, logger: { active: false } });
		rejected.setServices({ cache: { adapter: workerAdapter } });
		const originalOnPacket = rejected.cache.onPacket;

		expect(() => rejectedReconciler.setup?.(rejected as never)).toThrow(/cannot wrap Seyfert WorkerAdapter/);
		assert.equal(rejected.cache.adapter, workerAdapter);
		assert.equal(rejected.cache.onPacket, originalOnPacket);

		const acceptedReconciler = cacheIntegrity({ coordinator: localCoordinator() });
		const realAdapter = new CountingAdapter();
		const accepted = new WorkerClient({ plugins: [acceptedReconciler] as never, logger: { active: false } });
		accepted.setServices({ cache: { adapter: realAdapter } });
		await setup(accepted);
		await accepted.cache.adapter.start();
		assert.equal(realAdapter.starts, 1);
		await teardown(accepted);
		assert.equal(accepted.cache.adapter, realAdapter);
	});
});
