import { CacheFrom, ChannelType, Client, type GatewayDispatchPayload, GatewayOpcodes, MemoryAdapter } from 'seyfert';
import { assert, describe, expect, test } from 'vitest';
import { ReconciledAdapter } from '../src/adapter';
import { AdapterReconciliationController } from '../src/adapter-controller';
import { localCoordinator } from '../src/coordinators/local';
import { type GatewayMutationContext, ReconciliationState, type ShardGeneration } from '../src/reconciliation-state';
import { ResourcePolicy } from '../src/resource-policy';
import { SnapshotReconciler } from '../src/snapshot-reconciler';
import { deferred } from './deferred';

const GUILD_0 = '100000000000000000';
const GUILD_1 = '200000000000000000';

interface Harness {
	adapter: ReconciledAdapter;
	cache: Client['cache'];
	controller: AdapterReconciliationController;
	engine: SnapshotReconciler;
	generations: Map<number, ShardGeneration>;
	inner: MemoryAdapter<unknown>;
	sequences: Map<number, number>;
	state: ReconciliationState;
}

function createHarness(
	disabledCache: { guilds?: boolean } = {},
	inner = new MemoryAdapter<unknown>(),
	onFailure: (code: string, error: unknown) => void = () => {},
): Harness {
	const client = new Client({ logger: { active: false } });
	client.setServices({ cache: { adapter: inner, disabledCache } });
	const state = new ReconciliationState();
	state.activate();
	const generations = new Map(
		[0, 1].map(shardId => [
			shardId,
			state.openGeneration({ expectedGuildIds: [], sequence: 0, sessionId: `session-${shardId}`, shardId }),
		]),
	);
	for (const generation of generations.values()) state.markGuildsReady(generation);
	const calculateShardId = (guildId: string) => (guildId === GUILD_1 ? 1 : 0);
	const policy = new ResourcePolicy(state, calculateShardId);
	const controller = new AdapterReconciliationController(state, {
		isManagedRelationship: to => policy.isManagedRelationship(to),
		isManagedValue: key => policy.isManagedValue(key),
		resolveAdmission: (target, context) => policy.resolveAdmission(target, context),
	});
	const adapter = new ReconciledAdapter(
		inner,
		localCoordinator(),
		{
			beforeStart() {},
			onFailed(error) {
				throw error;
			},
			onStarted() {},
		},
		controller,
	);
	client.cache.adapter = adapter;
	adapter.start();
	const engine = new SnapshotReconciler({
		adapter,
		cache: client.cache,
		calculateShardId,
		controller,
		onFailure,
		state,
	});
	return { adapter, cache: client.cache, controller, engine, generations, inner, sequences: new Map(), state };
}

function nextContext(
	harness: Harness,
	event: string,
	guildId?: string,
	shardId = guildId === GUILD_1 ? 1 : 0,
	mode: GatewayMutationContext['mode'] = 'packet',
): GatewayMutationContext {
	const sequence = (harness.sequences.get(shardId) ?? 0) + 1;
	harness.sequences.set(shardId, sequence);
	return {
		event,
		guildId,
		mode,
		position: harness.state.observePacket(harness.generations.get(shardId)!, sequence),
		shardId,
	};
}

function entry(resource: string, data: unknown, id: string, scope?: string): unknown[] {
	return scope === undefined ? [CacheFrom.Gateway, resource, data, id] : [CacheFrom.Gateway, resource, data, id, scope];
}

async function seed(harness: Harness, guildId: string, entries: unknown[][]): Promise<void> {
	const context = nextContext(harness, 'SEED', guildId);
	await harness.controller.runWithContext(context, () => harness.cache.bulkSet(entries as never));
}

async function dispatch(harness: Harness, event: string, guildId: string, data: unknown): Promise<void> {
	const context = nextContext(harness, event, guildId);
	if (event === 'GUILD_CREATE' || event === 'GUILD_UPDATE' || event === 'RAW_GUILD_CREATE') {
		harness.controller.supersedeValueDelete(`guild.${guildId}`, context.position);
	}
	const prepared = harness.engine.prepare(context, data);
	const packet = {
		d: data,
		op: GatewayOpcodes.Dispatch,
		s: context.position.sequence,
		t: event,
	} as unknown as GatewayDispatchPayload;
	await harness.controller.runWithContext(context, () => harness.cache.onPacket(packet));
	await harness.engine.reconcilePostCache(context, data, prepared);
}

function relation(harness: Harness, to: string): string[] {
	return [...harness.inner.getToRelationship(to)].sort();
}

function guild(id: string): Record<string, unknown> {
	return { id, name: id, unavailable: false };
}

function role(id: string): Record<string, unknown> {
	return {
		color: 0,
		hoist: false,
		id,
		managed: false,
		mentionable: false,
		name: id,
		permissions: '0',
		position: 0,
	};
}

function channel(
	id: string,
	guildId: string,
	type: ChannelType = ChannelType.GuildText,
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return { guild_id: guildId, id, name: id, position: 0, type, ...extra };
}

function emoji(id: string): Record<string, unknown> {
	return { animated: false, available: true, id, name: id };
}

function sticker(id: string, guildId: string): Record<string, unknown> {
	return {
		available: true,
		description: null,
		format_type: 1,
		guild_id: guildId,
		id,
		name: id,
		tags: 'tag',
		type: 2,
	};
}

function voice(userId: string, guildId: string, channelId: string): Record<string, unknown> {
	return {
		channel_id: channelId,
		deaf: false,
		guild_id: guildId,
		mute: false,
		self_deaf: false,
		self_mute: false,
		self_stream: false,
		self_video: false,
		session_id: `session-${userId}`,
		suppress: false,
		user_id: userId,
	};
}

function stage(id: string, guildId: string, channelId: string): Record<string, unknown> {
	return {
		channel_id: channelId,
		discoverable_disabled: false,
		guild_id: guildId,
		id,
		privacy_level: 2,
		topic: id,
	};
}

function overwrite(guildId: string): Record<string, unknown>[] {
	return [{ allow: '0', deny: '0', guild_id: guildId, id: guildId, type: 0 }];
}

function message(id: string, guildId: string, channelId: string): Record<string, unknown> {
	return { channel_id: channelId, guild_id: guildId, id };
}

function presence(userId: string, guildId: string): Record<string, unknown> {
	return { activities: [], client_status: {}, guild_id: guildId, status: 'online', user: { id: userId } };
}

function member(userId: string): Record<string, unknown> {
	return {
		deaf: false,
		flags: 0,
		joined_at: '2026-01-01T00:00:00.000Z',
		mute: false,
		pending: false,
		roles: [],
		user: { id: userId, username: userId },
	};
}

function ban(userId: string): Record<string, unknown> {
	return { reason: null, user: { id: userId, username: userId } };
}

function cascadeEntries(guildId: string, suffix: string, sharedUser: string): unknown[][] {
	const channelId = `c-${suffix}`;
	return [
		entry('guilds', guild(guildId), guildId),
		entry('members', member(`u-member-${suffix}`), `u-member-${suffix}`, guildId),
		entry('roles', role(`r-${suffix}`), `r-${suffix}`, guildId),
		entry('channels', channel(channelId, guildId), channelId, guildId),
		entry('emojis', emoji(`e-${suffix}`), `e-${suffix}`, guildId),
		entry('stickers', sticker(`s-${suffix}`, guildId), `s-${suffix}`, guildId),
		entry('voiceStates', voice(`v-${suffix}`, guildId, channelId), `v-${suffix}`, guildId),
		entry('stageInstances', stage(`si-${suffix}`, guildId, channelId), `si-${suffix}`, guildId),
		entry('bans', ban(`u-banned-${suffix}`), `u-banned-${suffix}`, guildId),
		entry('overwrites', overwrite(guildId), channelId, guildId),
		entry('messages', message(`m-${suffix}`, guildId, channelId), `m-${suffix}`, channelId),
		entry('presences', presence(sharedUser, guildId), sharedUser, guildId),
	];
}

describe('SnapshotReconciler with Seyfert cache resources', () => {
	test('reconciles a full raw guild snapshot and preserves partial or non-authoritative state', async () => {
		const harness = createHarness();
		const keptChannel = 'c-kept';
		const staleChannel = 'c-stale';
		const archivedThread = 'thread-archived';
		const unknownThread = 'thread-unclassified';
		const activeThread = 'thread-active';
		await seed(harness, GUILD_0, [
			entry('guilds', guild(GUILD_0), GUILD_0),
			entry('roles', role('r-kept'), 'r-kept', GUILD_0),
			entry('roles', role('r-stale'), 'r-stale', GUILD_0),
			entry('channels', channel(keptChannel, GUILD_0), keptChannel, GUILD_0),
			entry('channels', channel(staleChannel, GUILD_0), staleChannel, GUILD_0),
			entry(
				'channels',
				channel(archivedThread, GUILD_0, ChannelType.PublicThread, { thread_metadata: { archived: true } }),
				archivedThread,
				GUILD_0,
			),
			entry('channels', channel(unknownThread, GUILD_0, ChannelType.PublicThread), unknownThread, GUILD_0),
			entry(
				'channels',
				channel(activeThread, GUILD_0, ChannelType.PublicThread, { thread_metadata: { archived: false } }),
				activeThread,
				GUILD_0,
			),
			entry('emojis', emoji('e-kept'), 'e-kept', GUILD_0),
			entry('emojis', emoji('e-stale'), 'e-stale', GUILD_0),
			entry('stickers', sticker('s-optional', GUILD_0), 's-optional', GUILD_0),
			entry('voiceStates', voice('v-kept', GUILD_0, keptChannel), 'v-kept', GUILD_0),
			entry('voiceStates', voice('v-stale', GUILD_0, staleChannel), 'v-stale', GUILD_0),
			entry('stageInstances', stage('si-kept', GUILD_0, keptChannel), 'si-kept', GUILD_0),
			entry('stageInstances', stage('si-stale', GUILD_0, staleChannel), 'si-stale', GUILD_0),
			entry('overwrites', overwrite(GUILD_0), keptChannel, GUILD_0),
			entry('overwrites', overwrite(GUILD_0), staleChannel, GUILD_0),
			entry('messages', message('m-kept', GUILD_0, keptChannel), 'm-kept', keptChannel),
			entry('messages', message('m-stale', GUILD_0, staleChannel), 'm-stale', staleChannel),
			entry('presences', presence('u-optional', GUILD_0), 'u-optional', GUILD_0),
			entry('members', member('u-member-optional'), 'u-member-optional', GUILD_0),
			entry('bans', ban('u-banned-optional'), 'u-banned-optional', GUILD_0),
		]);

		const snapshot = {
			...guild(GUILD_0),
			channels: [channel(keptChannel, GUILD_0)],
			emojis: [emoji('e-kept')],
			roles: [role('r-kept')],
			stage_instances: [stage('si-kept', GUILD_0, keptChannel)],
			threads: [],
			voice_states: [voice('v-kept', GUILD_0, keptChannel)],
		};
		await dispatch(harness, 'RAW_GUILD_CREATE', GUILD_0, snapshot);

		expect(relation(harness, `role.${GUILD_0}`)).toEqual(['r-kept']);
		expect(relation(harness, `channel.${GUILD_0}`)).toEqual([archivedThread, keptChannel, unknownThread].sort());
		expect(relation(harness, `emoji.${GUILD_0}`)).toEqual(['e-kept']);
		expect(relation(harness, `voice_state.${GUILD_0}`)).toEqual(['v-kept']);
		expect(relation(harness, `stage_instance.${GUILD_0}`)).toEqual(['si-kept']);
		expect(relation(harness, `overwrite.${GUILD_0}`)).toEqual([keptChannel]);
		expect(relation(harness, `message.${staleChannel}`)).toEqual([]);
		expect(relation(harness, `message.${keptChannel}`)).toEqual(['m-kept']);
		expect(relation(harness, `sticker.${GUILD_0}`)).toEqual(['s-optional']);
		expect(relation(harness, `presence.${GUILD_0}`)).toEqual(['u-optional']);
		expect(relation(harness, `member.${GUILD_0}`)).toEqual(['u-member-optional']);
		expect(relation(harness, `ban.${GUILD_0}`)).toEqual(['u-banned-optional']);
		assert.isNull(harness.inner.get(`channel.${staleChannel}`));
		assert.isNull(harness.inner.get(`channel.${activeThread}`));
		assert.isNull(harness.inner.get('role.r-stale'));
		assert.isNull(harness.inner.get('emoji.e-stale'));
		assert.isNull(harness.inner.get(`voice_state.${GUILD_0}.v-stale`));
		assert.isNull(harness.inner.get('stage_instance.si-stale'));
		assert.isNull(harness.inner.get('message.m-stale'));
		assert.isNull(harness.inner.get(`overwrite.${staleChannel}`));
		assert.isNotNull(harness.inner.get(`channel.${archivedThread}`));
		assert.isNotNull(harness.inner.get(`channel.${unknownThread}`));
		assert.isNotNull(harness.inner.get('message.m-kept'));
		assert.isNotNull(harness.inner.get('sticker.s-optional'));
		assert.isNotNull(harness.inner.get('presence.u-optional'));
		assert.isNotNull(harness.inner.get(`member.${GUILD_0}.u-member-optional`));
		assert.isNotNull(harness.inner.get(`ban.${GUILD_0}.u-banned-optional`));

		await dispatch(harness, 'RAW_GUILD_CREATE', GUILD_0, { ...snapshot, stickers: [] });
		expect(relation(harness, `sticker.${GUILD_0}`)).toEqual([]);
		assert.isNull(harness.inner.get('sticker.s-optional'));
		assert.isNotNull(harness.inner.get(`member.${GUILD_0}.u-member-optional`));
		assert.isNotNull(harness.inner.get(`ban.${GUILD_0}.u-banned-optional`));
	});

	test('repairs emoji and sticker list relationships from raw IDs and treats overwrite [] as authoritative', async () => {
		const harness = createHarness();
		const channelId = 'c-overwrite';
		await seed(harness, GUILD_0, [
			entry('guilds', guild(GUILD_0), GUILD_0),
			entry('emojis', emoji('e-stale'), 'e-stale', GUILD_0),
			entry('stickers', sticker('s-stale', GUILD_0), 's-stale', GUILD_0),
			entry('channels', channel(channelId, GUILD_0), channelId, GUILD_0),
			entry('overwrites', overwrite(GUILD_0), channelId, GUILD_0),
		]);

		await dispatch(harness, 'GUILD_EMOJIS_UPDATE', GUILD_0, {
			emojis: [emoji('e-current')],
			guild_id: GUILD_0,
		});
		await dispatch(harness, 'GUILD_STICKERS_UPDATE', GUILD_0, {
			guild_id: GUILD_0,
			stickers: [sticker('s-current', GUILD_0)],
		});
		await dispatch(harness, 'CHANNEL_UPDATE', GUILD_0, {
			...channel(channelId, GUILD_0),
			permission_overwrites: [],
		});

		expect(relation(harness, `emoji.${GUILD_0}`)).toEqual(['e-current']);
		expect(relation(harness, `sticker.${GUILD_0}`)).toEqual(['s-current']);
		expect(relation(harness, `overwrite.${GUILD_0}`)).toEqual([]);
		assert.isNull(harness.inner.get('emoji.e-stale'));
		assert.isNull(harness.inner.get('sticker.s-stale'));
		assert.isNull(harness.inner.get(`overwrite.${channelId}`));
	});

	test('a point overwrite cut does not supersede full-snapshot cleanup for another channel', async () => {
		const firstChannel = 'c-overwrite-first';
		const secondChannel = 'c-overwrite-second';
		const removeEntered = deferred();
		const removeGate = deferred();
		const inner = new MemoryAdapter<unknown>();
		inner.isAsync = true;
		const originalRemove = inner.remove.bind(inner);
		(inner as unknown as { remove(key: string): Promise<void> }).remove = async key => {
			if (key === `overwrite.${firstChannel}`) {
				removeEntered.resolve();
				await removeGate.promise;
			}
			originalRemove(key);
		};
		const harness = createHarness({}, inner);
		await seed(harness, GUILD_0, [
			entry('guilds', guild(GUILD_0), GUILD_0),
			entry('channels', channel(firstChannel, GUILD_0), firstChannel, GUILD_0),
			entry('channels', channel(secondChannel, GUILD_0), secondChannel, GUILD_0),
			entry('overwrites', overwrite(GUILD_0), firstChannel, GUILD_0),
			entry('overwrites', overwrite(GUILD_0), secondChannel, GUILD_0),
		]);
		const full = dispatch(harness, 'RAW_GUILD_CREATE', GUILD_0, {
			...guild(GUILD_0),
			channels: [
				channel(firstChannel, GUILD_0, ChannelType.GuildText, { permission_overwrites: [] }),
				channel(secondChannel, GUILD_0, ChannelType.GuildText, { permission_overwrites: [] }),
			],
			emojis: [],
			roles: [],
			stage_instances: [],
			threads: [],
			voice_states: [],
		});
		await removeEntered.promise;

		const point = dispatch(
			harness,
			'CHANNEL_UPDATE',
			GUILD_0,
			channel(firstChannel, GUILD_0, ChannelType.GuildText, {
				permission_overwrites: overwrite(GUILD_0),
			}),
		);
		assert.isDefined(
			harness.state.latestSnapshotCut(harness.generations.get(0)!, {
				guildId: GUILD_0,
				resource: 'overwrites',
				supersessionTarget: firstChannel,
			}),
		);
		removeGate.resolve();
		await Promise.all([full, point]);

		assert.isNotNull(inner.get(`overwrite.${firstChannel}`));
		assert.isNull(inner.get(`overwrite.${secondChannel}`));
		expect(relation(harness, `overwrite.${GUILD_0}`)).toEqual([firstChannel]);
	});

	test('cascades only stale guilds on the target shard and preserves global presence values', async () => {
		const harness = createHarness();
		const sharedUser = 'shared-user';
		await seed(harness, GUILD_0, cascadeEntries(GUILD_0, 'shard-0', sharedUser));
		await seed(harness, GUILD_1, cascadeEntries(GUILD_1, 'shard-1', sharedUser));

		const context = nextContext(harness, 'GUILDS_READY', undefined, 0, 'snapshot');
		await harness.engine.reconcileStaleGuilds(context, new Set());

		expect(relation(harness, 'guild')).toEqual([GUILD_1]);
		for (const namespace of [
			'member',
			'role',
			'channel',
			'emoji',
			'sticker',
			'voice_state',
			'stage_instance',
			'ban',
			'overwrite',
		]) {
			expect(relation(harness, `${namespace}.${GUILD_0}`)).toEqual([]);
		}
		expect(relation(harness, 'message.c-shard-0')).toEqual([]);
		expect(relation(harness, `presence.${GUILD_0}`)).toEqual([]);
		expect(relation(harness, `member.${GUILD_1}`)).toEqual(['u-member-shard-1']);
		expect(relation(harness, `role.${GUILD_1}`)).toEqual(['r-shard-1']);
		expect(relation(harness, `channel.${GUILD_1}`)).toEqual(['c-shard-1']);
		expect(relation(harness, `emoji.${GUILD_1}`)).toEqual(['e-shard-1']);
		expect(relation(harness, `sticker.${GUILD_1}`)).toEqual(['s-shard-1']);
		expect(relation(harness, `voice_state.${GUILD_1}`)).toEqual(['v-shard-1']);
		expect(relation(harness, `stage_instance.${GUILD_1}`)).toEqual(['si-shard-1']);
		expect(relation(harness, `ban.${GUILD_1}`)).toEqual(['u-banned-shard-1']);
		expect(relation(harness, `overwrite.${GUILD_1}`)).toEqual(['c-shard-1']);
		expect(relation(harness, 'message.c-shard-1')).toEqual(['m-shard-1']);
		expect(relation(harness, `presence.${GUILD_1}`)).toEqual([sharedUser]);
		assert.isNull(harness.inner.get(`guild.${GUILD_0}`));
		assert.isNull(harness.inner.get(`member.${GUILD_0}.u-member-shard-0`));
		assert.isNull(harness.inner.get('role.r-shard-0'));
		assert.isNull(harness.inner.get('channel.c-shard-0'));
		assert.isNull(harness.inner.get('emoji.e-shard-0'));
		assert.isNull(harness.inner.get('sticker.s-shard-0'));
		assert.isNull(harness.inner.get(`voice_state.${GUILD_0}.v-shard-0`));
		assert.isNull(harness.inner.get('stage_instance.si-shard-0'));
		assert.isNull(harness.inner.get(`ban.${GUILD_0}.u-banned-shard-0`));
		assert.isNull(harness.inner.get('overwrite.c-shard-0'));
		assert.isNull(harness.inner.get('message.m-shard-0'));
		assert.isNotNull(harness.inner.get(`guild.${GUILD_1}`));
		assert.isNotNull(harness.inner.get(`member.${GUILD_1}.u-member-shard-1`));
		assert.isNotNull(harness.inner.get('role.r-shard-1'));
		assert.isNotNull(harness.inner.get('channel.c-shard-1'));
		assert.isNotNull(harness.inner.get('emoji.e-shard-1'));
		assert.isNotNull(harness.inner.get('sticker.s-shard-1'));
		assert.isNotNull(harness.inner.get(`voice_state.${GUILD_1}.v-shard-1`));
		assert.isNotNull(harness.inner.get('stage_instance.si-shard-1'));
		assert.isNotNull(harness.inner.get(`ban.${GUILD_1}.u-banned-shard-1`));
		assert.isNotNull(harness.inner.get('overwrite.c-shard-1'));
		assert.isNotNull(harness.inner.get('message.m-shard-1'));
		assert.isNotNull(harness.inner.get(`presence.${sharedUser}`));
	});

	test('lets a reobserved guild win while its stale native cascade is executing', async () => {
		const inner = new MemoryAdapter<unknown>();
		inner.isAsync = true;
		const removeGate = deferred();
		const removeStarted = deferred();
		const originalBulkRemove = inner.bulkRemove.bind(inner);
		let blocked = false;
		(inner as unknown as { bulkRemove(keys: string[]): Promise<void> }).bulkRemove = async keys => {
			if (!blocked) {
				blocked = true;
				removeStarted.resolve();
				await removeGate.promise;
			}
			originalBulkRemove(keys);
		};
		const harness = createHarness({}, inner);
		await seed(harness, GUILD_0, cascadeEntries(GUILD_0, 'stale', 'shared-user'));
		const staleContext = nextContext(harness, 'GUILDS_READY', undefined, 0, 'snapshot');
		const sweeping = harness.engine.reconcileStaleGuilds(staleContext, new Set());
		await removeStarted.promise;

		const freshRole = 'r-fresh';
		const freshChannel = 'c-fresh';
		const freshSnapshot = {
			...guild(GUILD_0),
			channels: [channel(freshChannel, GUILD_0)],
			emojis: [],
			roles: [role(freshRole)],
			stage_instances: [],
			stickers: [],
			threads: [],
			voice_states: [],
		};
		const reobserving = dispatch(harness, 'GUILD_CREATE', GUILD_0, freshSnapshot);
		removeGate.resolve();
		await Promise.all([sweeping, reobserving]);

		expect(inner.get(`guild.${GUILD_0}`)).toMatchObject({ id: GUILD_0, unavailable: false });
		expect(inner.get(`role.${freshRole}`)).toMatchObject({ id: freshRole });
		expect(inner.get(`channel.${freshChannel}`)).toMatchObject({ id: freshChannel });
		expect(relation(harness, 'guild')).toEqual([GUILD_0]);
		expect(relation(harness, `role.${GUILD_0}`)).toEqual([freshRole]);
		expect(relation(harness, `channel.${GUILD_0}`)).toEqual([freshChannel]);
		await Promise.all([harness.adapter.waitForIdle(), harness.state.waitForIdle()]);
	});

	test('keeps a failed cleanup hidden and physically retryable', async () => {
		const inner = new MemoryAdapter<unknown>();
		inner.isAsync = true;
		const originalRemove = inner.remove.bind(inner);
		let fail = true;
		(inner as unknown as { remove(key: string): Promise<void> }).remove = async key => {
			if (fail && key === 'role.r-failing') {
				fail = false;
				throw new Error('cleanup failed');
			}
			originalRemove(key);
		};
		const failures: string[] = [];
		const harness = createHarness({}, inner, code => failures.push(code));
		await seed(harness, GUILD_0, [
			entry('guilds', guild(GUILD_0), GUILD_0),
			entry('roles', role('r-failing'), 'r-failing', GUILD_0),
		]);
		const snapshot = {
			...guild(GUILD_0),
			channels: [],
			emojis: [],
			roles: [],
			stage_instances: [],
			threads: [],
			voice_states: [],
		};

		await expect(dispatch(harness, 'RAW_GUILD_CREATE', GUILD_0, snapshot)).rejects.toThrow('cleanup failed');
		assert.isNull(await harness.adapter.get('role.r-failing'));
		assert.isNotNull(inner.get('role.r-failing'));
		expect(relation(harness, `role.${GUILD_0}`)).toEqual(['r-failing']);
		await Promise.all([harness.adapter.waitForIdle(), harness.state.waitForIdle()]);
		assert.equal(harness.state.pendingWork, 0);
		expect(failures).toContain('snapshot-delete-failed');

		await dispatch(harness, 'RAW_GUILD_CREATE', GUILD_0, snapshot);
		assert.isNull(inner.get('role.r-failing'));
		expect(relation(harness, `role.${GUILD_0}`)).toEqual([]);
	});

	test('keeps a deleted channel hidden and removes its parent when descendant cleanup fails', async () => {
		const channelId = 'c-parent-cleanup';
		const messageId = 'm-descendant-failure';
		const inner = new MemoryAdapter<unknown>();
		inner.isAsync = true;
		const originalRemove = inner.remove.bind(inner);
		(inner as unknown as { remove(key: string): Promise<void> }).remove = async key => {
			if (key === `message.${messageId}`) throw new Error('descendant cleanup failed');
			originalRemove(key);
		};
		const failures: string[] = [];
		const harness = createHarness({}, inner, code => failures.push(code));
		await seed(harness, GUILD_0, [
			entry('guilds', guild(GUILD_0), GUILD_0),
			entry('channels', channel(channelId, GUILD_0), channelId, GUILD_0),
			entry('messages', message(messageId, GUILD_0, channelId), messageId, channelId),
		]);
		const snapshot = {
			...guild(GUILD_0),
			channels: [],
			emojis: [],
			roles: [],
			stage_instances: [],
			threads: [],
			voice_states: [],
		};

		await expect(dispatch(harness, 'RAW_GUILD_CREATE', GUILD_0, snapshot)).rejects.toThrow('descendant cleanup failed');

		assert.isNull(await harness.adapter.get(`channel.${channelId}`));
		assert.isNull(inner.get(`channel.${channelId}`));
		expect(relation(harness, `channel.${GUILD_0}`)).toEqual([]);
		assert.isNull(await harness.adapter.get(`message.${messageId}`));
		assert.isNotNull(inner.get(`message.${messageId}`));
		expect(relation(harness, `message.${channelId}`)).toEqual([messageId]);
		expect(failures).toContain('snapshot-delete-failed');
		await Promise.all([harness.adapter.waitForIdle(), harness.state.waitForIdle()]);
	});

	test('leaves the physical keyspace untouched when guild caching is disabled', async () => {
		const harness = createHarness({ guilds: true });
		assert.isUndefined(harness.cache.guilds);
		harness.inner.set(`guild.${GUILD_0}`, guild(GUILD_0));
		harness.inner.addToRelationship('guild', GUILD_0);
		harness.inner.set('role.stale-role', role('stale-role'));
		harness.inner.addToRelationship(`role.${GUILD_0}`, 'stale-role');

		const context = nextContext(harness, 'GUILDS_READY', undefined, 0, 'snapshot');
		await harness.engine.reconcileStaleGuilds(context, new Set());

		expect(relation(harness, 'guild')).toEqual([GUILD_0]);
		expect(relation(harness, `role.${GUILD_0}`)).toEqual(['stale-role']);
		assert.isNotNull(harness.inner.get(`guild.${GUILD_0}`));
		assert.isNotNull(harness.inner.get('role.stale-role'));
	});
});
