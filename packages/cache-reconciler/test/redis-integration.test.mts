import { randomUUID } from 'node:crypto';
import { createClient, ErrorReply, type RedisClientType } from '@redis/client';
import { ExpirableRedisAdapter, RedisAdapter } from '@slipher/redis-adapter';
import { createMockBot } from '@slipher/testing';
import { type Adapter, type AdapterEntry, Cache, Client, definePlugins, MemoryAdapter } from 'seyfert';
import { describe, expect, it, vi } from 'vitest';
import { cacheReconciler } from '../src';
import { ReconciledAdapter, runUnfiltered } from '../src/adapter';
import {
	type BoundCoordinator,
	type CoordinatorBinding,
	type CoordinatorHost,
	ReconciliationCancelled,
} from '../src/coordinator';
import { redisCoordinator } from '../src/coordinators/redis';
import { KeyLayout } from '../src/keys';
import { ReconciliationState } from '../src/state';
import {
	APPLICATION_ID,
	gatewayDispatch,
	guildDeletePacket,
	guildOn,
	guildPacket,
	guildsReadyPacket,
	readyPacket,
} from './support';

const redisUrl = process.env.SLIPHER_RECONCILER_REDIS_URL;
const G = guildOn(2);
const ROLES = `role.${G}`;
/** Short enough to watch a lease being renewed and retried, long enough not to expire under a busy test run. */
const LEASE_TTL = 900;

interface Worker {
	inner: RedisAdapter;
	adapter: ReconciledAdapter;
	state: ReconciliationState;
	binding: CoordinatorBinding;
	layout: KeyLayout;
}

function role(id: string, guildId = G, extra: object = {}): AdapterEntry {
	return [`role.${id}`, { id, guild_id: guildId, ...extra }, [`role.${guildId}`, id]];
}

/**
 * Everything a test creates lives under one random namespace and is removed afterwards, including the
 * coordinator's leases and sets, which `RedisAdapter.flush()` would leave behind.
 */
async function withRedis(
	run: (context: { namespace: string; raw: RedisClientType; worker: typeof startWorker }) => Promise<void>,
) {
	const namespace = `slipher_reconciler_${randomUUID()}`;
	const raw: RedisClientType = createClient({ url: redisUrl });
	const workers: Worker[] = [];
	await raw.connect();
	try {
		await run({
			namespace,
			raw,
			worker: async (options = {}) => {
				const worker = await startWorker({ namespace, ...options });
				workers.push(worker);
				return worker;
			},
		});
	} finally {
		for (const worker of workers) {
			worker.state.beginClose();
			await worker.binding.close();
			if (worker.inner.client.isOpen) worker.inner.client.close();
		}
		const keys: string[] = [];
		for await (const batch of raw.scanIterator({ MATCH: `${namespace}:*` })) keys.push(...batch);
		if (keys.length) await raw.del(keys);
		raw.close();
	}
}

interface WorkerOptions {
	namespace?: string;
	leaseTtl?: number;
	mutationFailed?: NonNullable<CoordinatorHost['mutationFailed']>;
}

/** The coordinator as the plugin itself sees it, which is how a test attaches one without a client. */
function bound(coordinator: ReturnType<typeof redisCoordinator>): BoundCoordinator {
	return coordinator as BoundCoordinator;
}

/**
 * Observes the coordinator scripts Redis already ran, before their reply reaches the coordinator. A hook that
 * throws stands for a connection that dropped after the script was applied. Returns the undo.
 */
function onReply(client: RedisClientType, hook: (input: Record<string, unknown>) => void): () => void {
	const scripted = client as unknown as {
		evalSha(sha: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
	};
	const original = scripted.evalSha;
	scripted.evalSha = async (sha, options) => {
		const reply = await original.call(scripted, sha, options);
		if (!options.keys.length) hook(JSON.parse(options.arguments[0]!));
		return reply;
	};
	return () => {
		scripted.evalSha = original;
	};
}

/** Whether a script input carries an ownership change of this kind. */
function carries(input: Record<string, unknown>, kind: string): boolean {
	return Array.isArray(input.ops) && input.ops.some(op => Array.isArray(op) && op[0] === kind);
}

/** Loses the reply of the first script that carries an ownership change of this kind. Returns the undo. */
function dropReply(client: RedisClientType, kind: string): () => void {
	let dropped = false;
	return onReply(client, input => {
		if (dropped || !carries(input, kind)) return;
		dropped = true;
		throw new Error('Socket closed unexpectedly');
	});
}

/** One process sharing the cache: its own RedisAdapter connection, state, and coordinator incarnation. */
function createWorker(options: WorkerOptions): Worker {
	const namespace = options.namespace!;
	const inner = new RedisAdapter({ redisOptions: { url: redisUrl }, namespace });
	const state = new ReconciliationState();
	const layout = new KeyLayout(() => APPLICATION_ID);
	const binding = bound(
		redisCoordinator({
			client: inner.client,
			cacheNamespace: namespace,
			namespace: `${namespace}:reconciler`,
			leaseTtl: options.leaseTtl ?? LEASE_TTL,
		}),
	).bind({ inner, state, layout, ...(options.mutationFailed && { mutationFailed: options.mutationFailed }) });
	const adapter = new ReconciledAdapter(inner, { state, layout, binding });
	return { inner, adapter, state, binding, layout };
}

async function startWorker(options: WorkerOptions = {}): Promise<Worker> {
	const worker = createWorker(options);
	await worker.adapter.start();
	return worker;
}

/**
 * Observes the coordinator scripts a client sends, before each one leaves. A hook that throws makes that script
 * fail the way a broken connection would. Returns the undo.
 */
function onScript(client: RedisClientType, hook: (input: Record<string, unknown>) => void): () => void {
	const scripted = client as unknown as {
		evalSha(sha: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
	};
	const original = scripted.evalSha;
	scripted.evalSha = async (sha, options) => {
		// RedisAdapter's own scripts address their keys; the coordinator's carry everything in one argument.
		if (!options.keys.length) hook(JSON.parse(options.arguments[0]!));
		return original.call(scripted, sha, options);
	};
	return () => {
		scripted.evalSha = original;
	};
}

/** READY for a shard followed by the startup snapshots of its guilds, published like after a real READY. */
async function own(
	worker: Worker,
	guildIds: string[],
	options: { shard?: [id: number, total: number]; session?: string } = {},
) {
	const [shardId, total] = options.shard ?? [0, 1];
	worker.state.ready(shardId, options.session ?? 'session', total, guildIds, 1);
	const cuts = guildIds.map(guildId => {
		const work = worker.state.guildAvailable(shardId, guildId, 2, { startup: true, unavailable: false })!;
		return { generation: work.generation, guildId, sequence: work.sequence };
	});
	await worker.binding.publish();
	return cuts;
}

function sleep(milliseconds: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}

describe('redisCoordinator configuration', () => {
	const options = (adapter: RedisAdapter<boolean>) => ({
		client: adapter.client,
		cacheNamespace: adapter.namespace,
		namespace: `${adapter.namespace}:reconciler`,
	});

	it('rejects ExpirableRedisAdapter before the plugin replaces it', async () => {
		const original = new ExpirableRedisAdapter({ redisOptions: {}, namespace: 'cache' });
		const client = new Client({
			plugins: definePlugins(cacheReconciler({ coordinator: redisCoordinator(options(original)) })),
		});
		client.setServices({ cache: { adapter: original } });

		await expect(createMockBot({ client })).rejects.toThrow('does not support ExpirableRedisAdapter');

		expect(client.cache.adapter).toBe(original);
		expect(original.client.isOpen).toBe(false);
	});

	it('rejects a RedisAdapter subclass, another adapter, and a client or namespace that is not the adapter own', () => {
		class Subclass extends RedisAdapter {}
		const adapter = new RedisAdapter({ redisOptions: {}, namespace: 'cache' });
		const other = new RedisAdapter({ redisOptions: {}, namespace: 'cache' });
		const bind = (inner: Adapter, coordinator = redisCoordinator(options(adapter))) =>
			bound(coordinator).bind({ inner, state: new ReconciliationState(), layout: new KeyLayout(() => undefined) });

		expect(() => bind(new Subclass({ redisOptions: {}, namespace: 'cache' }))).toThrow('exact RedisAdapter');
		expect(() => bind(new MemoryAdapter())).toThrow('exact RedisAdapter');
		expect(() => bind(other)).toThrow('client and namespace of the configured RedisAdapter');
		expect(() => bind(adapter, redisCoordinator({ ...options(adapter), cacheNamespace: 'elsewhere' }))).toThrow(
			'client and namespace of the configured RedisAdapter',
		);
		expect(() => redisCoordinator({ ...options(adapter), namespace: 'cache' })).toThrow('needs its own namespace');
		expect(() => redisCoordinator({ ...options(adapter), namespace: '' })).toThrow('non-empty');
	});
});

describe.skipIf(!redisUrl)('redisCoordinator against Redis', () => {
	it('stores entries exactly like RedisAdapter does', () =>
		withRedis(async ({ namespace, raw, worker }) => {
			const plainNamespace = `${namespace}:plain`;
			const plain = new RedisAdapter({ redisOptions: { url: redisUrl }, namespace: plainNamespace });
			await plain.start();
			const coordinated = await worker();
			const overwrites: AdapterEntry = [
				'overwrite.7',
				[{ id: 'r', type: 0, allow: '8', deny: '0', guild_id: G }],
				[`overwrite.${G}`, '7'],
			];
			const dump = async (prefix: string) => {
				const hashes: Record<string, unknown> = {};
				for await (const keys of raw.scanIterator({ MATCH: `${prefix}:*`, TYPE: 'hash' })) {
					for (const key of keys) {
						if (key.startsWith(`${prefix}:reconciler:`) || key.startsWith(`${prefix}:plain:`)) continue;
						hashes[key.slice(prefix.length + 1)] = { fields: await raw.hGetAll(key), ttl: await raw.ttl(key) };
					}
				}
				return hashes;
			};
			try {
				await own(coordinated, [G]);
				for (const adapter of [plain, coordinated.adapter] as Adapter[]) {
					await adapter.set(...role('1', G, { name: 'one', color: 0, hoist: false, tags: null }));
					await adapter.patch('role.1', { name: 'renamed', color: 5 }, [ROLES, '1']);
					await adapter.bulkSet([
						role('2'),
						overwrites,
						['user.9', { id: '9', bot: true }, ['user', '9']],
						// Another plugin's resource, which the coordinator leaves to the adapter.
						['cooldown.a', { uses: 1 }, ['cooldown', 'a']],
					]);
					await adapter.set('channel.empty', {}, [`channel.${G}`, 'empty']);
					// A field that changes type must not leave its previous encoding behind.
					await adapter.set(...role('3', G, { color: 1, hoist: true, tags: null }));
					await adapter.patch('role.3', { color: 'red', hoist: 2, tags: 'none' }, [ROLES, '3']);
					// A key filed again under another relationship, then removed from the first one.
					await adapter.set('channel.moved', { id: 'moved' }, [`channel.${G}`, 'moved']);
					await adapter.set('channel.moved', { id: 'moved' }, ['channel.@me', 'moved']);
					await adapter.removeToRelationship(`channel.${G}`, 'moved');
				}
				// An expiry that came from elsewhere does not survive the next write.
				for (const prefix of [namespace, plainNamespace]) await raw.expire(`${prefix}:role.2`, 1000);
				for (const adapter of [plain, coordinated.adapter] as Adapter[]) {
					await adapter.bulkPatch([['role.2', { position: 3 }, [ROLES, '2']]]);
				}

				const stored = await dump(namespace);
				expect(stored).toEqual(await dump(plainNamespace));
				expect(Object.keys(stored).sort()).toEqual(
					[
						'channel.empty',
						'channel.moved',
						'cooldown.a',
						'overwrite.7',
						'relationships:channel.@me',
						`relationships:channel.${G}`,
						'relationships:cooldown',
						`relationships:overwrite.${G}`,
						'relationships:owners',
						`relationships:${ROLES}`,
						'relationships:user',
						'role.1',
						'role.2',
						'role.3',
						'user.9',
					].sort(),
				);
				expect(stored['role.2']).toMatchObject({ ttl: -1 });
				expect(stored['role.3']).toEqual({
					fields: { id: '3', guild_id: G, color: 'red', N_hoist: '2', tags: 'none' },
					ttl: -1,
				});
				expect(stored['role.1']).toEqual({
					fields: { id: '1', guild_id: G, name: 'renamed', N_color: '5', B_hoist: 'f', O_tags: 'null' },
					ttl: -1,
				});
				expect(stored[`relationships:${ROLES}`]).toMatchObject({ fields: { '1': 'role.1', '2': 'role.2' } });
				// What the coordinator wrote reads back through a plain adapter on the same namespace.
				expect(await coordinated.inner.get('role.1')).toEqual(await plain.get('role.1'));
				expect((await coordinated.inner.keys(ROLES)).sort()).toEqual(['role.1', 'role.2', 'role.3']);
				expect(await coordinated.inner.get('overwrite.7')).toEqual(overwrites[1]);

				for (const adapter of [plain, coordinated.adapter] as Adapter[]) {
					await adapter.remove('role.1');
					await adapter.bulkRemove(['role.2', 'user.9']);
					await adapter.removeToRelationship(`overwrite.${G}`, '7');
					await adapter.removeRelationship(`channel.${G}`);
					await adapter.bulkRemove(['role.3', 'channel.moved', 'cooldown.a']);
				}
				expect(await dump(namespace)).toEqual({});
				expect(await dump(plainNamespace)).toEqual({});
				// Every removal path took the key's visibility with it, and the unreconciled entry never had any.
				expect(await raw.hLen(`${namespace}:reconciler:vis`)).toBe(0);
			} finally {
				plain.client.close();
			}
		}));

	it('serves a key only while the coordinator confirms it, for every worker sharing the cache', () =>
		withRedis(async ({ worker }) => {
			const owner = await worker();
			const reader = await worker();
			// A previous deployment left this behind.
			await reader.inner.set(...role('ghost'));
			await own(owner, [G]);
			await owner.adapter.set(...role('1'));
			await reader.inner.set('cooldown.a', { uses: 1 }, ['cooldown', 'a']);

			for (const { adapter } of [owner, reader]) {
				expect(await adapter.get('role.1')).toMatchObject({ id: '1' });
				expect(await adapter.get('role.ghost')).toBeNull();
				expect(await adapter.bulkGet(['role.ghost', 'role.1'])).toHaveLength(1);
				expect(await adapter.scan('role.*', true)).toEqual(['role.1']);
				expect(await adapter.keys(ROLES)).toEqual(['role.1']);
				expect(await adapter.values(ROLES)).toHaveLength(1);
				expect(await adapter.count(ROLES)).toBe(1);
				expect(await adapter.contains(ROLES, '1')).toBe(true);
				expect(await adapter.contains(ROLES, 'ghost')).toBe(false);
				expect(await adapter.getToRelationship(ROLES)).toEqual(['1']);
				// Another plugin's resource is not reconciled.
				expect(await adapter.get('cooldown.a')).toEqual({ uses: 1 });
			}

			// The owner's shard starts a new session: the other worker stops serving the guild at once.
			owner.state.ready(0, 'session-2', 1, [G], 1);
			await owner.binding.publish();
			expect(await reader.adapter.get('role.1')).toBeNull();
			expect(await reader.adapter.count(ROLES)).toBe(0);
		}));

	it('adds one Redis call to a read and none to the adapter own calls', () =>
		withRedis(async ({ worker }) => {
			const owner = await worker();
			await own(owner, [G]);
			await owner.adapter.bulkSet([role('1'), role('2')]);
			const calls: string[] = [];
			const client = owner.inner.client as unknown as Record<string, (...args: unknown[]) => unknown>;
			for (const command of ['evalSha', 'hGetAll', 'hLen', 'hVals', 'hKeys', 'hExists']) {
				const original = client[command]!.bind(client);
				client[command] = (...args: unknown[]) => {
					calls.push(command);
					return original(...args);
				};
			}
			const measure = async (read: () => unknown) => {
				calls.length = 0;
				await read();
				return [...calls].sort();
			};

			expect(await measure(() => owner.inner.get('role.1'))).toEqual(['hGetAll']);
			expect(await measure(() => owner.adapter.get('role.1'))).toEqual(['evalSha', 'hGetAll']);
			expect(await measure(() => owner.adapter.bulkGet(['role.1', 'role.2']))).toEqual([
				'evalSha',
				'hGetAll',
				'hGetAll',
			]);
			expect(await measure(() => owner.adapter.values(ROLES))).toEqual(['evalSha', 'hGetAll', 'hGetAll']);
			// Aggregates are answered by the visibility script alone, never by a raw HLEN or HKEYS.
			expect(await measure(() => owner.adapter.count(ROLES))).toEqual(['evalSha']);
			expect(await measure(() => owner.adapter.keys(ROLES))).toEqual(['evalSha']);
			expect(await measure(() => owner.adapter.contains(ROLES, '1'))).toEqual(['evalSha']);
		}));

	it('bypasses wrappers another plugin put on the adapter mutation methods', () =>
		withRedis(async ({ worker }) => {
			const owner = await worker();
			await own(owner, [G]);
			const instrumented: string[] = [];
			const inner = owner.inner as unknown as Record<string, (...args: unknown[]) => unknown>;
			for (const method of ['set', 'patch', 'bulkSet', 'bulkPatch', 'remove', 'bulkRemove', 'get']) {
				const original = inner[method]!.bind(inner);
				inner[method] = (...args: unknown[]) => {
					instrumented.push(method);
					return original(...args);
				};
			}

			await owner.adapter.set(...role('1'));
			await owner.adapter.bulkPatch([role('1', G, { name: 'patched' })]);
			await owner.adapter.get('role.1');
			await owner.adapter.remove('role.1');

			// Mutations are owned by coordinator scripts; only delegated reads reach the adapter's methods.
			expect(instrumented).toEqual(['get']);
		}));

	it('replaces instead of merging when a partial write lands on an entry nobody can read', () =>
		withRedis(async ({ worker }) => {
			const owner = await worker();
			await owner.inner.set('channel.7', { id: '7', name: 'deleted-offline', topic: 'stale' }, [`channel.${G}`, '7']);
			await own(owner, [G]);
			await owner.adapter.set(...role('1', G, { name: 'one' }));

			await owner.adapter.patch('channel.7', { status: 'live' }, [`channel.${G}`, '7']);
			await owner.adapter.bulkPatch([['role.1', { color: 3 }, [ROLES, '1']]]);

			expect(await owner.adapter.get('channel.7')).toEqual({ status: 'live' });
			expect(await owner.adapter.get('role.1')).toEqual({ id: '1', guild_id: G, name: 'one', color: 3 });
		}));

	it('keeps a later write and removes only what the snapshot outdated', () =>
		withRedis(async ({ worker }) => {
			const owner = await worker();
			await owner.inner.bulkSet([role('ghost'), role('other', guildOn(4))]);
			const [cut] = await own(owner, [G]);
			await owner.adapter.set(...role('at-cut'));
			// A packet after the snapshot created this role before the sweep reached Redis.
			owner.state.observe(0, 3);
			await owner.adapter.set(...role('created-later'));
			const targets = ['ghost', 'at-cut', 'created-later'].map(id => owner.layout.target(`role.${id}`, [ROLES, id])!);
			targets.push(owner.layout.target('role.other', [`role.${guildOn(4)}`, 'other'])!);

			const result = await owner.binding.sweep(targets, cut!);

			expect(result).toEqual({ removed: ['role.ghost', 'role.at-cut'], failed: [] });
			expect(await owner.inner.get('role.created-later')).toMatchObject({ id: 'created-later' });
			expect(await owner.inner.get('role.other')).toMatchObject({ id: 'other' });
			expect(await owner.inner.getToRelationship(ROLES)).toEqual(['created-later']);

			// The other order: the sweep already ran when the later packet writes the role again.
			await owner.adapter.set(...role('ghost', G, { name: 'recreated' }));
			expect(await owner.adapter.get('role.ghost')).toMatchObject({ name: 'recreated' });
		}));

	it('keeps shards that share a namespace independent', () =>
		withRedis(async ({ worker }) => {
			const onShard0 = guildOn(2);
			const onShard1 = guildOn(3);
			const first = await worker();
			const second = await worker();
			await own(first, [onShard0], { shard: [0, 2] });
			await own(second, [onShard1], { shard: [1, 2] });
			await first.adapter.set(...role('a', onShard0));
			await second.adapter.set(...role('b', onShard1));

			// Shard 1 reconnects with a new session.
			second.state.ready(1, 'session-2', 2, [onShard1], 1);
			await second.binding.publish();

			expect(await first.adapter.get('role.a')).toMatchObject({ id: 'a' });
			expect(await second.adapter.get('role.a')).toMatchObject({ id: 'a' });
			expect(await first.adapter.get('role.b')).toBeNull();
			expect(first.state.lifecycle).toBe('active');
			expect(second.state.lifecycle).toBe('active');
		}));

	it('renews a held lease, and makes a successor wait until it is released', () =>
		withRedis(async ({ namespace, raw, worker }) => {
			const lease = `${namespace}:reconciler:lease:0`;
			const first = await worker();
			await own(first, [G]);
			const holder = await raw.get(lease);

			await sleep(LEASE_TTL * 2);
			expect(await raw.get(lease)).toBe(holder);
			expect(await raw.pTTL(lease)).toBeGreaterThan(0);

			const successor = await worker();
			successor.state.ready(0, 'session-2', 1, [G], 1);
			successor.state.guildAvailable(0, G, 2, { startup: true, unavailable: false });
			let written = false;
			let attempts = 0;
			const restore = onScript(successor.inner.client, () => {
				attempts++;
			});
			const writing = Promise.resolve(successor.adapter.set(...role('1'))).then(() => {
				written = true;
			});
			await sleep(LEASE_TTL / 2);
			restore();
			// The lease is held by a live owner, so nothing of the successor reached the cache yet.
			expect(written).toBe(false);
			expect(await raw.get(lease)).toBe(holder);
			// It asks again on the renewal cadence instead of spinning.
			expect(attempts).toBeGreaterThanOrEqual(1);
			expect(attempts).toBeLessThanOrEqual(3);

			first.state.beginClose();
			await first.binding.close();
			await writing;

			expect(await raw.get(lease)).not.toBe(holder);
			expect(await successor.adapter.get('role.1')).toMatchObject({ id: '1' });
		}));

	it('fences an owner whose lease expired: a successor acquires and every late script of the former owner fails', () =>
		withRedis(async ({ namespace, raw, worker }) => {
			const former = await worker();
			const [formerCut] = await own(former, [G]);
			await former.adapter.set(...role('old'));
			// The former owner stalled long enough for its lease to expire.
			await raw.del(`${namespace}:reconciler:lease:0`);

			const successor = await worker();
			await own(successor, [G], { session: 'session-2' });
			await successor.adapter.set(...role('new'));

			const target = former.layout.target('role.new', [ROLES, 'new'])!;
			expect(await former.binding.sweep([target], formerCut!)).toEqual({ removed: [], failed: [] });
			await former.adapter.set(...role('late'));
			await former.adapter.remove('role.new');

			expect(await successor.adapter.get('role.new')).toMatchObject({ id: 'new' });
			expect(await successor.inner.get('role.late')).toBeUndefined();
			// Losing the lease is terminal for that coordinator: it reads nothing and never reacquires.
			expect(former.state.snapshot()).toMatchObject({ lifecycle: 'failed' });
			expect(await former.adapter.get('role.new')).toBeNull();
			expect(await former.adapter.keys(ROLES)).toEqual([]);
			former.state.ready(0, 'session-3', 1, [G], 1);
			await former.binding.publish();
			expect(await successor.adapter.get('role.new')).toMatchObject({ id: 'new' });
			// Closing afterwards does not bring its reads back.
			former.state.beginClose();
			expect(await former.adapter.get('role.new')).toBeNull();
		}));

	it('notices at renewal that its lease is gone', () =>
		withRedis(async ({ namespace, raw, worker }) => {
			const owner = await worker();
			await own(owner, [G]);

			await raw.set(`${namespace}:reconciler:lease:0`, 'another-incarnation');
			await sleep(LEASE_TTL);

			expect(owner.state.snapshot()).toMatchObject({ lifecycle: 'failed', cause: expect.any(Error) });
		}));

	it('continues on RESUMED only for the instance that owns the generation', () =>
		withRedis(async ({ worker }) => {
			const owner = await worker();
			await own(owner, [G]);
			await owner.adapter.set(...role('1'));

			expect(owner.state.resumed(0)).toBe(true);
			await owner.adapter.set(...role('2'));
			expect(await owner.adapter.keys(ROLES)).toHaveLength(2);

			// A replacement process resumes the same Discord session without ever having seen its READY.
			const replacement = await worker();
			expect(replacement.state.resumed(0)).toBe(false);
			await replacement.adapter.set(...role('3'));
			await replacement.adapter.remove('role.1');

			expect(await owner.inner.get('role.3')).toBeUndefined();
			expect(await replacement.adapter.get('role.1')).toBeNull();
			expect(await owner.adapter.get('role.1')).toMatchObject({ id: '1' });
		}));

	it('does not publish a partial snapshot when the owner restarts mid-startup', () =>
		withRedis(async ({ namespace, raw, worker }) => {
			const second = guildOn(4);
			const crashed = await worker();
			const reader = await worker();
			await reader.inner.set(...role('leftover', second));
			// READY listed two guilds; only the first one's snapshot arrived before the process died.
			crashed.state.ready(0, 'session', 1, [G, second], 1);
			crashed.state.guildAvailable(0, G, 2, { startup: true, unavailable: false });
			await crashed.adapter.set(...role('1'));

			expect(await raw.hGet(`${namespace}:reconciler:shard:0`, 'committed')).toBe('0');
			expect(await reader.adapter.get('role.1')).toMatchObject({ id: '1' });
			expect(await reader.adapter.get('role.leftover')).toBeNull();

			await raw.del(`${namespace}:reconciler:lease:0`);
			const restarted = await worker();
			restarted.state.ready(0, 'session-2', 1, [G, second], 1);
			await restarted.binding.publish();

			// The new generation starts from nothing: the half-finished one confirmed nothing for it.
			expect(await reader.adapter.get('role.1')).toBeNull();
			expect(await raw.hGet(`${namespace}:reconciler:shard:0`, 'committed')).toBe('0');
		}));

	it('removes what is left of a guild under its claim, and refuses once the guild is back', () =>
		withRedis(async ({ namespace, raw, worker }) => {
			const left = guildOn(4);
			const owner = await worker();
			await owner.inner.bulkSet([[`guild.${left}`, { id: left }, ['guild', left]], role('r-left', left)]);
			await own(owner, [G]);
			owner.state.settle(owner.state.guildAvailable(0, G, 2, { startup: true, unavailable: false })!, 'reconciled');
			owner.state.guildsReady(0);
			const generation = owner.state.ownership(G)!.generation;
			const cache = new Cache(0, owner.adapter, {}, {} as never);

			const claim = owner.state.claimGuild(generation, left)!;
			await runUnfiltered(owner.adapter, claim, () => cache.guilds!.remove(left));
			expect(await owner.inner.get(`guild.${left}`)).toBeUndefined();
			expect(await owner.inner.getToRelationship(`role.${left}`)).toEqual([]);

			// A second stale guild is joined again before its cleanup reaches Redis.
			const back = guildOn(6);
			await owner.inner.set(...role('r-back', back));
			const stale = owner.state.claimGuild(generation, back)!;
			owner.state.guildAvailable(0, back, 9, { startup: false, unavailable: false });
			await expect(
				runUnfiltered(owner.adapter, stale, () => owner.adapter.bulkRemove(['role.r-back'])),
			).rejects.toBeInstanceOf(ReconciliationCancelled);
			expect(await owner.inner.get('role.r-back')).toMatchObject({ id: 'r-back' });

			// A third one was opened by another coordinator, which only Redis knows about.
			const elsewhere = guildOn(8);
			const theirs = `role.${elsewhere}`;
			await owner.inner.set(...role('r-elsewhere', elsewhere));
			const blind = owner.state.claimGuild(generation, elsewhere)!;
			await raw.set(`${namespace}:reconciler:lease:7`, 'another-incarnation');
			await raw.hSet(`${namespace}:reconciler:guilds`, elsewhere, 'another-incarnation:1|4|7');
			for (const remove of [
				() => owner.adapter.bulkRemove(['role.r-elsewhere']),
				() => owner.adapter.removeToRelationship(theirs, 'r-elsewhere'),
				() => owner.adapter.removeRelationship(theirs),
			]) {
				await expect(runUnfiltered(owner.adapter, blind, remove)).rejects.toBeInstanceOf(ReconciliationCancelled);
			}
			expect(await owner.inner.get('role.r-elsewhere')).toMatchObject({ id: 'r-elsewhere' });
			expect(await owner.inner.getToRelationship(theirs)).toEqual(['r-elsewhere']);
			expect(owner.state.lifecycle).toBe('active');
		}));

	it('keeps its own state through a flush', () =>
		withRedis(async ({ namespace, raw, worker }) => {
			const owner = await worker();
			await own(owner, [G]);
			await owner.adapter.bulkSet([role('1'), ['cooldown.a', { uses: 1 }, ['cooldown', 'a']]]);

			await owner.adapter.flush();

			expect(await owner.inner.get('role.1')).toBeUndefined();
			expect(await owner.inner.get('cooldown.a')).toBeUndefined();
			expect(await raw.exists(`${namespace}:reconciler:shard:0`)).toBe(1);
			await owner.adapter.set(...role('2'));
			expect(await owner.adapter.get('role.2')).toMatchObject({ id: '2' });
			expect(owner.state.lifecycle).toBe('active');
		}));

	it.each<[string, (inner: RedisAdapter) => RedisAdapter['set']]>([
		['files entries somewhere else', () => async () => undefined],
		[
			'encodes typed fields differently',
			inner => (key, value, relationship) =>
				RedisAdapter.prototype.set.call(inner, key, { ...value, flag: 'true' }, relationship),
		],
	])('refuses an adapter that %s than its scripts expect', (_name, differently) =>
		withRedis(async ({ namespace, raw }) => {
			const worker = createWorker({ namespace });
			// Stands in for a release of the adapter with another storage layout.
			Reflect.set(worker.inner, 'set', differently(worker.inner));
			try {
				await expect(worker.adapter.start()).rejects.toThrow('does not recognize the storage layout');
				// The probe entry does not outlive the check.
				expect(await raw.keys(`${namespace}:cache_reconciler_probe*`)).toEqual([]);
			} finally {
				if (worker.inner.client.isOpen) worker.inner.client.close();
			}
		}));

	it('increments only what a caller can read', () =>
		withRedis(async ({ worker }) => {
			const owner = await worker();
			await owner.inner.set(...role('ghost', G, { position: 1 }));
			await own(owner, [G]);
			await owner.adapter.set(...role('1', G, { position: 1 }));

			expect(await owner.adapter.increment!('role.1', 'position', 2)).toBe(3);
			expect(await owner.adapter.increment!('role.ghost', 'position', 2)).toBeUndefined();
			expect(await owner.inner.get('role.ghost')).toMatchObject({ position: 1 });
		}));

	it('measures a write and a sweep against the snapshot the guild is on now', () =>
		withRedis(async ({ worker }) => {
			const owner = await worker();
			const [cut] = await own(owner, [G]);
			await owner.adapter.set(...role('1'));
			// The bot is removed from the guild and added back: its evidence starts again at a later packet.
			owner.state.closeGuild(G, 5);
			owner.state.guildAvailable(0, G, 6, { startup: false, unavailable: false });
			await owner.binding.publish();

			// Written before the guild came back, so nothing confirms it anymore.
			expect(await owner.adapter.get('role.1')).toBeNull();
			// The sweep of the snapshot that was replaced has nothing left to decide.
			const target = owner.layout.target('role.1', [ROLES, '1'])!;
			expect(await owner.binding.sweep([target], cut!)).toEqual({ removed: [], failed: [] });
			expect(await owner.inner.get('role.1')).toMatchObject({ id: '1' });

			await owner.adapter.set(...role('1', G, { name: 'again' }));
			expect(await owner.adapter.get('role.1')).toMatchObject({ name: 'again' });
		}));

	it('ends a sweep its own next READY overtakes without giving up the shard', () =>
		withRedis(async ({ worker }) => {
			const owner = await worker();
			const ghosts = Array.from({ length: 150 }, (_, index) => role(`ghost-${index}`));
			await owner.inner.bulkSet(ghosts);
			const [cut] = await own(owner, [G]);
			const targets = ghosts.map(([key, , relationship]) => owner.layout.target(key, relationship)!);
			// The shard reconnects with a new session while the first batch of the sweep is on its way.
			let scripts = 0;
			const restore = onScript(owner.inner.client, () => {
				if (++scripts === 1) owner.state.ready(0, 'session-2', 1, [G], 1);
			});

			const result = await owner.binding.sweep(targets, cut!);
			restore();

			expect(result.removed).toHaveLength(100);
			expect(result.failed).toEqual([]);
			// Being overtaken by its own next session is not losing the shard.
			expect(owner.state.lifecycle).toBe('active');
			owner.state.guildAvailable(0, G, 2, { startup: true, unavailable: false });
			await owner.adapter.set(...role('1'));
			expect(await owner.adapter.get('role.1')).toMatchObject({ id: '1' });
		}));

	it('lets a process that owns nothing write into a guild without undoing its owner', () =>
		withRedis(async ({ worker }) => {
			const owner = await worker();
			const rest = await worker();
			const [cut] = await own(owner, [G]);
			// A later packet created the role; the other process then caches the same role from a REST response.
			owner.state.observe(0, 5);
			await owner.adapter.set(...role('1', G, { name: 'gateway' }));
			await rest.adapter.set(...role('1', G, { name: 'rest' }));
			await rest.adapter.set(...role('2'));

			for (const { adapter } of [owner, rest]) {
				expect(await adapter.get('role.1')).toMatchObject({ name: 'rest' });
				expect(await adapter.get('role.2')).toMatchObject({ id: '2' });
			}
			// The owner's sweep still finds the role written after its snapshot.
			const target = owner.layout.target('role.1', [ROLES, '1'])!;
			expect(await owner.binding.sweep([target], cut!)).toEqual({ removed: [], failed: [] });

			// A guild no owner opened yet: the write is stored and nobody is served it.
			const unopened = guildOn(4);
			await rest.adapter.set(...role('3', unopened));
			expect(await rest.adapter.get('role.3')).toBeNull();
			expect(await rest.inner.get('role.3')).toMatchObject({ id: '3' });
		}));

	it('files a message under the guild of its channel', () =>
		withRedis(async ({ worker }) => {
			const owner = await worker();
			const reader = await worker();
			await own(owner, [G]);
			await owner.adapter.set('channel.c1', { id: 'c1', guild_id: G }, [`channel.${G}`, 'c1']);
			await owner.adapter.set('message.m1', { id: 'm1', channel_id: 'c1' }, ['message.c1', 'm1']);
			// A DM channel belongs to no guild, and neither do its messages.
			await owner.adapter.set('channel.dm', { id: 'dm' }, ['channel.@me', 'dm']);
			await owner.adapter.set('message.m2', { id: 'm2', channel_id: 'dm' }, ['message.dm', 'm2']);
			expect(await reader.adapter.keys('message.c1')).toEqual(['message.m1']);

			owner.state.ready(0, 'session-2', 1, [G], 1);
			await owner.binding.publish();

			expect(await reader.adapter.get('message.m1')).toBeNull();
			expect(await reader.adapter.get('message.m2')).toMatchObject({ id: 'm2' });
		}));

	it('keeps serving the guilds it owns while another of its shards waits for READY', () =>
		withRedis(async ({ worker }) => {
			const onShard0 = guildOn(2);
			const onShard1 = guildOn(3);
			const mixed = await worker();
			const other = await worker();
			await own(mixed, [onShard0], { shard: [0, 2] });
			await own(other, [onShard1], { shard: [1, 2] });
			await mixed.adapter.bulkSet([role('a', onShard0), role('stale', onShard0)]);
			await other.adapter.set(...role('b', onShard1));
			expect(await mixed.adapter.get('role.b')).toMatchObject({ id: 'b' });

			// Shard 1 resumes in this process, which never saw the READY of that session.
			expect(mixed.state.resumed(1)).toBe(false);

			expect(await mixed.adapter.get('role.a')).toMatchObject({ id: 'a' });
			expect(await mixed.adapter.keys(`role.${onShard0}`)).toEqual(['role.a', 'role.stale']);
			await mixed.adapter.set(...role('a2', onShard0));
			await mixed.adapter.remove('role.stale');
			expect(await other.adapter.keys(`role.${onShard0}`)).toEqual(['role.a', 'role.a2']);
			// It cannot tell which guilds the waiting shard owns, so it reads, writes, and removes nothing there.
			expect(await mixed.adapter.get('role.b')).toBeNull();
			await mixed.adapter.set(...role('b2', onShard1));
			await mixed.adapter.remove('role.b');
			await mixed.adapter.removeToRelationship(`role.${onShard1}`, 'b');
			await mixed.adapter.removeRelationship(`role.${onShard1}`);
			expect(await other.inner.get('role.b2')).toBeUndefined();
			expect(await other.adapter.keys(`role.${onShard1}`)).toEqual(['role.b']);
		}));

	it('leaves a guild alone when its shard changes with the shard count', () =>
		withRedis(async ({ worker }) => {
			// With one shard this guild is on shard 0; with two it is on shard 1.
			const moved = guildOn(3);
			const alsoMoved = guildOn(5);
			const before = await worker();
			await own(before, [moved, alsoMoved], { shard: [0, 1] });
			const onShard1 = await worker();
			await own(onShard1, [moved, alsoMoved], { shard: [1, 2], session: 'session-2' });
			await onShard1.adapter.bulkSet([role('r', moved, { name: 'current' }), role('s', alsoMoved)]);

			// The old layout is still connected for a moment. What it writes or closes there no longer counts.
			await before.adapter.set(...role('r', moved, { name: 'old-layout' }));
			before.state.closeGuild(moved, 9);
			await before.binding.publish();
			expect(await onShard1.adapter.get('role.r')).toMatchObject({ name: 'current' });
			expect(before.state.lifecycle).toBe('active');
			before.state.beginClose();
			await before.binding.close();

			// The new shard 0 takes the lease the old layout held. The guild that layout never closed is not the
			// new shard's to close either.
			const onShard0 = await worker();
			await own(onShard0, [guildOn(2)], { shard: [0, 2], session: 'session-3' });

			for (const { adapter } of [onShard0, onShard1]) {
				expect(await adapter.get('role.r')).toMatchObject({ name: 'current' });
				expect(await adapter.get('role.s')).toMatchObject({ id: 's' });
			}
		}));

	it('stops serving the guilds of a shard once nothing owns it anymore', () =>
		withRedis(async ({ namespace, raw, worker }) => {
			const onShard0 = guildOn(2);
			const onShard1 = guildOn(3);
			const first = await worker();
			const second = await worker();
			const reader = await worker();
			await own(first, [onShard0], { shard: [0, 2] });
			await own(second, [onShard1], { shard: [1, 2] });
			await first.adapter.set(...role('a', onShard0));
			await second.adapter.set(...role('b', onShard1));

			// The worker keeps running without its shard, so nobody updates those guilds anymore.
			second.state.suspend(1);
			await second.binding.publish();
			expect(await reader.adapter.get('role.b')).toBeNull();
			expect(await raw.exists(`${namespace}:reconciler:lease:1`)).toBe(0);

			// A clean shutdown gives the lease back, and what it confirmed goes with it: nobody updates it now.
			expect(await reader.adapter.get('role.a')).toMatchObject({ id: 'a' });
			first.state.beginClose();
			await first.binding.close();
			expect(await raw.exists(`${namespace}:reconciler:lease:0`)).toBe(0);
			expect(await reader.adapter.get('role.a')).toBeNull();
			expect(await reader.adapter.keys(`role.${onShard0}`)).toEqual([]);
			// The entries themselves are still stored for the next owner to confirm or remove.
			expect(await reader.inner.get('role.a')).toMatchObject({ id: 'a' });
		}));

	it('stops serving a crashed owner once its lease expires, before anyone takes the shard', () =>
		withRedis(async ({ namespace, raw, worker }) => {
			const crashed = await worker();
			const reader = await worker();
			await own(crashed, [G]);
			await crashed.adapter.set(...role('1'));
			expect(await reader.adapter.get('role.1')).toMatchObject({ id: '1' });

			// The process is gone: nothing renews the lease and nothing releases it.
			await raw.del(`${namespace}:reconciler:lease:0`);

			expect(await reader.adapter.get('role.1')).toBeNull();
			// A write from a process that owns nothing does not bring the guild back.
			await reader.adapter.set(...role('2'));
			expect(await reader.adapter.keys(ROLES)).toEqual([]);
		}));

	it('waits for a contended shard without holding up its other shards or its own teardown', () =>
		withRedis(async ({ worker }) => {
			const onShard0 = guildOn(2);
			const onShard1 = guildOn(3);
			const holder = await worker();
			await own(holder, [onShard0], { shard: [0, 2] });
			const successor = await worker();
			successor.state.ready(0, 'session-2', 2, [onShard0], 1);
			successor.state.ready(1, 'session-2', 2, [onShard1], 1);
			successor.state.guildAvailable(0, onShard0, 2, { startup: true, unavailable: false });
			successor.state.guildAvailable(1, onShard1, 2, { startup: true, unavailable: false });

			// Shard 1 is free, so its guild is served while shard 0 is still held elsewhere.
			await successor.adapter.set(...role('b', onShard1));
			expect(await successor.adapter.get('role.b')).toMatchObject({ id: 'b' });
			let settled = false;
			const waiting = Promise.resolve(successor.adapter.set(...role('a', onShard0))).then(() => {
				settled = true;
			});
			await sleep(LEASE_TTL);
			expect(settled).toBe(false);
			// Several attempts later the wait is still reported once.
			expect(successor.state.snapshot().failures).toEqual([expect.objectContaining({ kind: 'session', shardId: 0 })]);

			successor.state.beginClose();
			await waiting;
			expect(holder.state.lifecycle).toBe('active');
			// The write that waited is older than whatever the shard's owner cached since, so it is not applied.
			expect(await holder.inner.get('role.a')).toBeUndefined();
		}));

	it('stops waiting for a lease when teardown begins while another attempt is on its way', () =>
		withRedis(async ({ worker }) => {
			const holder = await worker();
			await own(holder, [G]);
			const successor = await worker();
			successor.state.ready(0, 'session-2', 1, [G], 1);
			successor.state.guildAvailable(0, G, 2, { startup: true, unavailable: false });
			let attempts = 0;
			const restore = onScript(successor.inner.client, input => {
				// The second attempt at the lease has left for Redis when the client starts closing.
				if ('ops' in input && ++attempts === 2) successor.state.beginClose();
			});

			await successor.adapter.set(...role('1'));
			restore();

			expect(attempts).toBe(2);
			expect(holder.state.lifecycle).toBe('active');
		}));

	it('keeps what a shard reports while its attempt at a contended lease is on its way', () =>
		withRedis(async ({ worker }) => {
			const gone = guildOn(4);
			const holder = await worker();
			await holder.inner.set(...role('ghost', gone));
			await own(holder, [G, gone]);
			await holder.adapter.set(...role('ghost', gone));
			const successor = await worker();
			successor.state.ready(0, 'session-2', 1, [G, gone], 1);
			successor.state.guildAvailable(0, gone, 2, { startup: true, unavailable: false });
			// The attempt leaves for Redis now. One guild's startup packet and the removal of another arrive
			// before the answer, which is that the lease is still held.
			const publishing = successor.binding.publish();
			successor.state.guildAvailable(0, G, 3, { startup: true, unavailable: false });
			successor.state.closeGuild(gone, 4);
			await publishing;

			// Rolling restart: the previous owner shuts down cleanly and the successor takes the shard.
			holder.state.beginClose();
			await holder.binding.close();
			await successor.adapter.set(...role('1', G, { name: 'fresh' }));
			await successor.adapter.set(...role('ghost', gone));

			const reader = await worker();
			expect(await reader.adapter.get('role.1')).toMatchObject({ name: 'fresh' });
			expect(await reader.adapter.get('role.ghost')).toBeNull();
		}));

	it('does not overwrite the owner with a write that was still waiting for the lease at teardown', () =>
		withRedis(async ({ worker }) => {
			const holder = await worker();
			await own(holder, [G]);
			await holder.adapter.set(...role('1', G, { name: 'first' }));
			const successor = await worker();
			successor.state.ready(0, 'session-2', 1, [G], 1);
			successor.state.guildAvailable(0, G, 2, { startup: true, unavailable: false });
			const waiting = Promise.resolve(successor.adapter.set(...role('1', G, { name: 'waited' })));
			await sleep(LEASE_TTL / 3);
			// The owner keeps receiving events and caches a newer value.
			holder.state.observe(0, 10);
			await holder.adapter.set(...role('1', G, { name: 'newest' }));

			// The successor is torn down while it still waits: a failed deploy, a rollback.
			successor.state.beginClose();
			await waiting;

			expect(await holder.adapter.get('role.1')).toMatchObject({ name: 'newest' });
		}));

	it('does not take a renewal that crosses the release of a shard it stopped following for a lost lease', () =>
		withRedis(async ({ worker }) => {
			const onShard0 = guildOn(2);
			const onShard1 = guildOn(3);
			const owner = await worker();
			await own(owner, [onShard0], { shard: [0, 2] });
			await own(owner, [onShard1], { shard: [1, 2] });
			await owner.adapter.set(...role('a', onShard0));
			owner.state.suspend(1);
			const releasing = owner.binding.publish();
			// The renewal timer fires while the release is on its way.
			await Reflect.get(owner.binding, 'renew').call(owner.binding);
			await releasing;

			expect(owner.state.lifecycle).toBe('active');
			expect(await owner.adapter.get('role.a')).toMatchObject({ id: 'a' });
		}));

	it('does not take a read or a write that crosses the release of another shard for a lost lease', () =>
		withRedis(async ({ worker }) => {
			const onShard0 = guildOn(2);
			const onShard1 = guildOn(3);
			const owner = await worker();
			await own(owner, [onShard0], { shard: [0, 2] });
			await own(owner, [onShard1], { shard: [1, 2] });
			await owner.adapter.set(...role('a', onShard0));
			// Both are past their turn in line when the worker stops following the other shard and gives it back.
			const reading = owner.adapter.get('role.a');
			const writing = owner.adapter.set(...role('b', onShard0));
			owner.state.suspend(1);
			const releasing = owner.binding.publish();

			expect(await reading).toMatchObject({ id: 'a' });
			await Promise.all([writing, releasing]);
			expect(owner.state.lifecycle).toBe('active');
			expect(await owner.adapter.get('role.b')).toMatchObject({ id: 'b' });
		}));

	it('counts again on a shard it gave back and took again in one step', () =>
		withRedis(async ({ namespace, raw, worker }) => {
			const owner = await worker();
			await own(owner, [G]);
			owner.state.suspend(0);
			owner.state.ready(0, 'session-2', 1, [G], 1);
			owner.state.guildAvailable(0, G, 2, { startup: true, unavailable: false });
			await owner.binding.publish();
			// The owner stalls until its lease expires and another coordinator has the shard.
			await raw.set(`${namespace}:reconciler:lease:0`, 'another-incarnation');

			await owner.adapter.set(...role('late'));

			expect(owner.state.snapshot()).toMatchObject({ lifecycle: 'failed', cause: expect.any(Error) });
			expect(await owner.inner.get('role.late')).toBeUndefined();
		}));

	it('stops a sweep between batches once teardown began', () =>
		withRedis(async ({ worker }) => {
			const owner = await worker();
			const ghosts = Array.from({ length: 250 }, (_, index) => role(`ghost-${index}`));
			await owner.inner.bulkSet(ghosts);
			const [cut] = await own(owner, [G]);
			const targets = ghosts.map(([key, , relationship]) => owner.layout.target(key, relationship)!);
			let sweeps = 0;
			const restore = onScript(owner.inner.client, input => {
				if (input.mode === 'sweep' && ++sweeps === 1) owner.state.beginClose();
			});

			const result = await owner.binding.sweep(targets, cut!);
			restore();

			expect(sweeps).toBe(1);
			expect(result).toMatchObject({ failed: [] });
			expect(result.removed).toHaveLength(100);
		}));

	it('stops serving a guild that a new shard count moved, before its new shard delivers it', () =>
		withRedis(async ({ worker }) => {
			// With one shard this guild is on shard 0; with two it is on shard 1.
			const moved = guildOn(3);
			const before = await worker();
			await own(before, [moved], { shard: [0, 1] });
			await before.adapter.set(...role('r', moved, { name: 'old-layout' }));
			before.state.beginClose();
			await before.binding.close();

			// Nothing owns shard 0 anymore, so its guilds are not served whichever shard they belong to now.
			const onShard1 = await worker();
			const reader = await worker();
			onShard1.state.ready(1, 'session-2', 2, [moved], 1);
			await onShard1.binding.publish();
			expect(await reader.adapter.get('role.r')).toBeNull();
			expect(await onShard1.adapter.get('role.r')).toBeNull();

			onShard1.state.guildAvailable(1, moved, 2, { startup: true, unavailable: false });
			await onShard1.adapter.set(...role('r', moved, { name: 'new-layout' }));
			expect(await reader.adapter.get('role.r')).toMatchObject({ name: 'new-layout' });
		}));

	it('removes a guild the bot left while offline even when its old shard no longer exists', () =>
		withRedis(async ({ worker }) => {
			// On shard 1 of 2, and on shard 0 once there is a single shard.
			const left = guildOn(3);
			const onShard1 = await worker();
			await own(onShard1, [left], { shard: [1, 2] });
			await onShard1.adapter.bulkSet([[`guild.${left}`, { id: left }, ['guild', left]], role('r-left', left)]);
			onShard1.state.beginClose();
			await onShard1.binding.close();

			// The bot now runs one shard, and its READY no longer lists the guild.
			const single = await worker();
			const reader = await worker();
			single.state.ready(0, 'session-2', 1, [G], 1);
			single.state.settle(single.state.guildAvailable(0, G, 2, { startup: true, unavailable: false })!, 'reconciled');
			const generation = single.state.guildsReady(0)!;
			await single.binding.publish();
			expect(await reader.adapter.get('role.r-left')).toBeNull();

			const cache = new Cache(0, single.adapter, {}, {} as never);
			await runUnfiltered(single.adapter, single.state.claimGuild(generation, left)!, () => cache.guilds!.remove(left));

			expect(await single.inner.get('role.r-left')).toBeUndefined();
			expect(await single.inner.get(`guild.${left}`)).toBeUndefined();
		}));

	it('ends a claimed removal its own next READY overtakes', () =>
		withRedis(async ({ worker }) => {
			const left = guildOn(4);
			const owner = await worker();
			const leftovers = Array.from({ length: 150 }, (_, index) => role(`left-${index}`, left));
			await owner.inner.bulkSet(leftovers);
			await own(owner, [G]);
			owner.state.settle(owner.state.guildAvailable(0, G, 2, { startup: true, unavailable: false })!, 'reconciled');
			const claim = owner.state.claimGuild(owner.state.guildsReady(0)!, left)!;
			// The shard reconnects while the first batch is on its way, and something else publishes the new
			// session before the second batch leaves. The guild may be back in that session.
			let removals = 0;
			const restore = onScript(owner.inner.client, input => {
				if (input.mode !== 'claim' || ++removals !== 1) return;
				owner.state.ready(0, 'session-2', 1, [G, left], 1);
				queueMicrotask(() => void owner.binding.publish());
			});

			await expect(
				runUnfiltered(owner.adapter, claim, () => owner.adapter.bulkRemove(leftovers.map(([key]) => key))),
			).rejects.toBeInstanceOf(ReconciliationCancelled);
			restore();

			expect(removals).toBe(2);
			expect(await owner.inner.getToRelationship(`role.${left}`)).toHaveLength(50);
			expect(owner.state.lifecycle).toBe('active');
		}));

	it('removes with a sweep what another process cached at the very packet of the snapshot', () =>
		withRedis(async ({ worker }) => {
			const owner = await worker();
			const rest = await worker();
			const [cut] = await own(owner, [G]);
			// A process that owns nothing cannot know the owner's position, so its write counts as made at the
			// snapshot. A sweep of that snapshot that does not list the role takes it; the next read is a miss.
			await rest.adapter.set(...role('1'));
			const target = owner.layout.target('role.1', [ROLES, '1'])!;

			expect(await owner.binding.sweep([target], cut!)).toEqual({ removed: ['role.1'], failed: [] });
			expect(await rest.adapter.get('role.1')).toBeNull();
		}));

	it('survives a renewal that follows a new session Redis took without answering', () =>
		withRedis(async ({ worker }) => {
			const owner = await worker();
			await own(owner, [G]);
			// The shard reconnects. Redis applies the new session and the connection drops before the reply.
			const restore = dropReply(owner.inner.client, 'acquire');
			owner.state.ready(0, 'session-2', 1, [G], 1);
			await expect(owner.binding.publish()).rejects.toThrow('Socket closed unexpectedly');
			restore();

			// The renewal timer fires before anything else applies the session again.
			await Reflect.get(owner.binding, 'renew').call(owner.binding);

			expect(owner.state.lifecycle).toBe('active');
			owner.state.guildAvailable(0, G, 2, { startup: true, unavailable: false });
			await owner.adapter.set(...role('1'));
			expect(await owner.adapter.get('role.1')).toMatchObject({ id: '1' });
		}));

	it('gives a shard back again when Redis released it without answering', () =>
		withRedis(async ({ namespace, raw, worker }) => {
			const onShard0 = guildOn(2);
			const onShard1 = guildOn(3);
			const owner = await worker();
			await own(owner, [onShard0], { shard: [0, 2] });
			await own(owner, [onShard1], { shard: [1, 2] });
			await owner.adapter.set(...role('a', onShard0));
			const restore = dropReply(owner.inner.client, 'release');
			owner.state.suspend(1);
			await expect(owner.binding.publish()).rejects.toThrow('Socket closed unexpectedly');
			restore();
			expect(await raw.exists(`${namespace}:reconciler:lease:1`)).toBe(0);

			// The renewal timer fires before anything else asks again. The shard it keeps is unaffected.
			await Reflect.get(owner.binding, 'renew').call(owner.binding);
			expect(owner.state.lifecycle).toBe('active');
			expect(await owner.adapter.get('role.a')).toMatchObject({ id: 'a' });
			expect(await raw.exists(`${namespace}:reconciler:lease:0`)).toBe(1);
		}));

	it('gives a shard back again after another process already took it', () =>
		withRedis(async ({ namespace, raw, worker }) => {
			const owner = await worker();
			const successor = await worker();
			await own(owner, [G]);
			const restore = dropReply(owner.inner.client, 'release');
			owner.state.suspend(0);
			await expect(owner.binding.publish()).rejects.toThrow('Socket closed unexpectedly');
			restore();
			// A process that was waiting for the shard takes it before the first one asks again.
			await own(successor, [G], { session: 'session-2' });
			await successor.adapter.set(...role('new'));
			const holder = await raw.get(`${namespace}:reconciler:lease:0`);

			await owner.binding.publish();

			expect(owner.state.lifecycle).toBe('active');
			expect(await raw.get(`${namespace}:reconciler:lease:0`)).toBe(holder);
			expect(await successor.adapter.get('role.new')).toMatchObject({ id: 'new' });
		}));

	it('gives a shard back again after another process took it and gave it back too', () =>
		withRedis(async ({ namespace, raw, worker }) => {
			const owner = await worker();
			const successor = await worker();
			await own(owner, [G]);
			const restore = dropReply(owner.inner.client, 'release');
			owner.state.suspend(0);
			await expect(owner.binding.publish()).rejects.toThrow('Socket closed unexpectedly');
			restore();
			// Before the first one asks again, a process that was waiting takes the shard and stops following it.
			await own(successor, [G], { session: 'session-2' });
			successor.state.suspend(0);
			await successor.binding.publish();

			await owner.binding.publish();

			expect(owner.state.lifecycle).toBe('active');
			expect(successor.state.lifecycle).toBe('active');
			expect(await raw.exists(`${namespace}:reconciler:lease:0`)).toBe(0);
		}));

	it('gives a shard back again when it asks together with a later session of that shard', () =>
		withRedis(async ({ namespace, raw, worker }) => {
			const owner = await worker();
			const successor = await worker();
			await own(owner, [G]);
			const restore = dropReply(owner.inner.client, 'release');
			owner.state.suspend(0);
			await expect(owner.binding.publish()).rejects.toThrow('Socket closed unexpectedly');
			restore();
			await own(successor, [G], { session: 'session-2' });
			const holder = await raw.get(`${namespace}:reconciler:lease:0`);
			// The first one follows the shard again and stops once more before it reaches Redis.
			owner.state.ready(0, 'session-3', 1, [G], 1);
			owner.state.suspend(0);

			await owner.binding.publish();

			// It waits for the shard like any other process instead of counting it as lost.
			expect(owner.state.lifecycle).toBe('active');
			expect(await raw.get(`${namespace}:reconciler:lease:0`)).toBe(holder);
		}));

	it('remembers only the latest releases of a shard', () =>
		withRedis(async ({ namespace, raw, worker }) => {
			const owner = await worker();
			for (let session = 0; session < 20; session++) {
				owner.state.ready(0, `session-${session}`, 1, [G], 1);
				owner.state.suspend(0);
				await owner.binding.publish();
			}

			expect(owner.state.lifecycle).toBe('active');
			expect(await raw.lLen(`${namespace}:reconciler:shard:0:released`)).toBe(16);
		}));

	it('gives a shard back again when one step gave it back twice', () =>
		withRedis(async ({ namespace, raw, worker }) => {
			const owner = await worker();
			await own(owner, [G]);
			const restore = dropReply(owner.inner.client, 'release');
			// The worker stops following the shard, follows it again under a new session, and stops once more.
			owner.state.suspend(0);
			owner.state.ready(0, 'session-2', 1, [G], 1);
			owner.state.suspend(0);
			await expect(owner.binding.publish()).rejects.toThrow('Socket closed unexpectedly');
			restore();

			await owner.binding.publish();

			expect(owner.state.lifecycle).toBe('active');
			expect(await raw.exists(`${namespace}:reconciler:lease:0`)).toBe(0);
		}));

	it('gives back a shard it took and stopped following in one step', () =>
		withRedis(async ({ namespace, raw, worker }) => {
			const owner = await worker();
			owner.state.ready(0, 'session', 1, [G], 1);
			owner.state.suspend(0);
			await owner.binding.publish();

			expect(owner.state.lifecycle).toBe('active');
			expect(await raw.exists(`${namespace}:reconciler:lease:0`)).toBe(0);
		}));

	it('treats a lease that was gone before it gave the shard back as a lost lease', () =>
		withRedis(async ({ namespace, raw, worker }) => {
			const lease = `${namespace}:reconciler:lease:0`;
			const owner = await worker();
			await own(owner, [G]);
			// The owner stalled until its lease expired, and the first thing it does next is give the shard back.
			await raw.del(lease);
			owner.state.suspend(0);
			await owner.binding.publish();

			expect(owner.state.snapshot()).toMatchObject({ lifecycle: 'failed', cause: expect.any(Error) });
			// It does not take the shard again under the identity that lost it.
			owner.state.ready(0, 'session-2', 1, [G], 1);
			await owner.binding.publish();
			expect(await raw.exists(lease)).toBe(0);
		}));

	it('does not wait to take back a shard that another process took before it gave it up', () =>
		withRedis(async ({ namespace, raw, worker }) => {
			const lease = `${namespace}:reconciler:lease:0`;
			const owner = await worker();
			await own(owner, [G]);
			await raw.set(lease, 'another-incarnation', { expiration: { type: 'PX', value: LEASE_TTL / 3 } });
			// It stops following the shard and gets a new session for it before anything reached Redis.
			owner.state.suspend(0);
			owner.state.ready(0, 'session-2', 1, [G], 1);
			await owner.binding.publish();

			expect(owner.state.snapshot()).toMatchObject({ lifecycle: 'failed', cause: expect.any(Error) });
			// The other lease runs out, and the former owner is not there to pick the shard up.
			await sleep(LEASE_TTL);
			expect(await raw.exists(lease)).toBe(0);
		}));

	it('notices at renewal that the lease of a shard it is about to give back is gone', () =>
		withRedis(async ({ namespace, raw, worker }) => {
			const owner = await worker();
			await own(owner, [G]);
			await raw.del(`${namespace}:reconciler:lease:0`);
			owner.state.suspend(0);
			// The renewal timer fires before the release reaches Redis.
			await Reflect.get(owner.binding, 'renew').call(owner.binding);

			expect(owner.state.snapshot()).toMatchObject({ lifecycle: 'failed', cause: expect.any(Error) });
		}));

	it('notices a lost lease when it reports a change of that shard', () =>
		withRedis(async ({ namespace, raw, worker }) => {
			const owner = await worker();
			await own(owner, [G]);
			await raw.set(`${namespace}:reconciler:lease:0`, 'another-incarnation');
			owner.state.closeGuild(G);
			await owner.binding.publish();

			expect(owner.state.snapshot()).toMatchObject({ lifecycle: 'failed', cause: expect.any(Error) });
		}));

	it('gives back its other shards at shutdown after a release Redis never answered', () =>
		withRedis(async ({ namespace, raw, worker }) => {
			const onShard0 = guildOn(2);
			const onShard1 = guildOn(3);
			const owner = await worker();
			const reader = await worker();
			await own(owner, [onShard0], { shard: [0, 2] });
			await own(owner, [onShard1], { shard: [1, 2] });
			await owner.adapter.set(...role('a', onShard0));
			const restore = dropReply(owner.inner.client, 'release');
			owner.state.suspend(1);
			await expect(owner.binding.publish()).rejects.toThrow('Socket closed unexpectedly');
			restore();
			expect(await reader.adapter.get('role.a')).toMatchObject({ id: 'a' });

			owner.state.beginClose();
			await owner.binding.close();

			expect(await raw.exists(`${namespace}:reconciler:lease:0`)).toBe(0);
			expect(await reader.adapter.get('role.a')).toBeNull();
		}));

	it('gives back at shutdown a shard Redis handed it without answering', () =>
		withRedis(async ({ namespace, raw, worker }) => {
			const lease = `${namespace}:reconciler:lease:0`;
			const owner = await worker();
			const restore = dropReply(owner.inner.client, 'acquire');
			owner.state.ready(0, 'session', 1, [G], 1);
			await expect(owner.binding.publish()).rejects.toThrow('Socket closed unexpectedly');
			restore();
			expect(await raw.exists(lease)).toBe(1);

			owner.state.beginClose();
			await owner.binding.close();

			expect(await raw.exists(lease)).toBe(0);
		}));

	it('reopens a shard it gave back and took again in one step', () =>
		withRedis(async ({ worker }) => {
			const owner = await worker();
			const reader = await worker();
			await own(owner, [G]);
			await owner.adapter.set(...role('old'));
			// The worker stops following the shard and a new session arrives before anything reached Redis.
			owner.state.suspend(0);
			owner.state.ready(0, 'session-2', 1, [G], 1);
			owner.state.guildAvailable(0, G, 2, { startup: true, unavailable: false });
			await owner.adapter.set(...role('new'));

			expect(await reader.adapter.keys(ROLES)).toEqual(['role.new']);
			expect(owner.state.lifecycle).toBe('active');
		}));

	it('treats a guild entry it cannot read as a guild nobody opened', () =>
		withRedis(async ({ namespace, raw, worker }) => {
			const owner = await worker();
			await own(owner, [G]);
			const other = guildOn(4);
			await raw.hSet(`${namespace}:reconciler:guilds`, other, 'not-a-partition');

			await owner.adapter.set(...role('1', other));

			expect(await owner.adapter.get('role.1')).toBeNull();
			expect(await raw.hExists(`${namespace}:reconciler:guilds`, other)).toBeFalsy();
			expect(owner.state.lifecycle).toBe('active');
		}));

	it('lets a successor take over once the lease of a stalled owner expires', () =>
		withRedis(async ({ namespace, raw, worker }) => {
			const lease = `${namespace}:reconciler:lease:0`;
			const stalled = await worker();
			await own(stalled, [G]);
			await stalled.adapter.set(...role('old'));
			const holder = await raw.get(lease);
			// Its connection stops answering, so nothing renews the lease anymore.
			const restore = onScript(stalled.inner.client, () => {
				throw new Error('connection lost');
			});

			const successor = await worker();
			successor.state.ready(0, 'session-2', 1, [G], 1);
			successor.state.guildAvailable(0, G, 2, { startup: true, unavailable: false });
			await successor.adapter.set(...role('new'));

			expect(await raw.get(lease)).not.toBe(holder);
			expect(await successor.adapter.keys(ROLES)).toEqual(['role.new']);
			// The former owner gave up by itself: it could not confirm its lease for a whole lifetime.
			await vi.waitFor(() => expect(stalled.state.snapshot()).toMatchObject({ lifecycle: 'failed' }));
			expect(String(stalled.state.snapshot().cause)).toContain('could not be renewed');
			restore();
			await stalled.adapter.set(...role('late'));
			expect(await successor.inner.get('role.late')).toBeUndefined();
		}));

	it('survives a failed renewal as long as the lease is confirmed again in time', () =>
		withRedis(async ({ worker }) => {
			const owner = await worker();
			await own(owner, [G]);
			// Renewals keep succeeding for longer than one lease lifetime.
			await sleep(LEASE_TTL * 1.5);
			let failed = false;
			const restore = onScript(owner.inner.client, () => {
				if (failed) return;
				failed = true;
				throw new Error('connection reset');
			});
			await vi.waitFor(() => expect(failed).toBe(true));
			await sleep(LEASE_TTL / 2);
			restore();

			expect(owner.state.lifecycle).toBe('active');
			await owner.adapter.set(...role('1'));
			expect(await owner.adapter.get('role.1')).toMatchObject({ id: '1' });
		}));

	it.each<[string, (former: Worker) => unknown]>([
		['a write', former => former.adapter.set(...role('kept', G, { name: 'overwritten' }))],
		['a partial write', former => former.adapter.patch('role.kept', { name: 'overwritten' }, [ROLES, 'kept'])],
		['a removal', former => former.adapter.remove('role.kept')],
		['a bulk removal', former => former.adapter.bulkRemove(['role.kept'])],
		['a relationship member removal', former => former.adapter.removeToRelationship(ROLES, 'kept')],
		['a relationship removal', former => former.adapter.removeRelationship(ROLES)],
		['an increment', former => former.adapter.increment!('role.kept', 'position', 5)],
		['a flush', former => former.adapter.flush()],
	])('does not apply %s of a former owner that has not noticed losing its lease', (_name, mutate) =>
		withRedis(async ({ namespace, raw, worker }) => {
			// A lease long enough that only the mutation itself can find out.
			const former = await worker({ leaseTtl: 60_000 });
			await own(former, [G]);
			await former.adapter.set(...role('kept', G, { name: 'kept', position: 1 }));
			await raw.set(`${namespace}:reconciler:lease:0`, 'another-incarnation');

			await mutate(former);

			expect(await former.inner.get('role.kept')).toEqual({ id: 'kept', guild_id: G, name: 'kept', position: 1 });
			expect(await former.inner.getToRelationship(ROLES)).toEqual(['kept']);
			expect(await raw.hGet(`${namespace}:reconciler:vis`, 'role.kept')).toEqual(expect.any(String));
			expect(former.state.lifecycle).toBe('failed');
		}));

	it('keeps serving the resources it does not reconcile after losing its lease', () =>
		withRedis(async ({ namespace, raw, worker }) => {
			const former = await worker({ leaseTtl: 60_000 });
			await own(former, [G]);
			await raw.set(`${namespace}:reconciler:lease:0`, 'another-incarnation');
			await former.adapter.set(...role('late'));
			expect(former.state.lifecycle).toBe('failed');

			await former.adapter.bulkSet([role('later'), ['cooldown.a', { uses: 1 }, ['cooldown', 'a']]]);
			await former.adapter.patch('cooldown.a', { uses: 2 }, ['cooldown', 'a']);
			expect(await former.adapter.get('cooldown.a')).toEqual({ uses: 2 });
			expect(await former.adapter.increment!('cooldown.a', 'uses', 1)).toBe(3);
			await former.adapter.bulkRemove(['cooldown.a', 'role.late']);

			expect(await former.inner.get('cooldown.a')).toBeUndefined();
			expect(await former.inner.get('role.later')).toBeUndefined();
		}));

	it('applies a removal Redis never answered before anything else the process does', () =>
		withRedis(async ({ worker }) => {
			const owner = await worker();
			const reader = await worker();
			await own(owner, [G]);
			await owner.adapter.bulkSet([role('1'), role('2'), role('3')]);
			// The connection drops while each of these removals is on its way.
			const restore = onScript(owner.inner.client, input => {
				if ('mode' in input) throw new Error('Socket closed unexpectedly');
			});
			await expect(owner.adapter.remove('role.1')).rejects.toThrow('Socket closed unexpectedly');
			await expect(owner.adapter.removeToRelationship(ROLES, '2')).rejects.toThrow('Socket closed unexpectedly');
			restore();
			expect(await owner.inner.get('role.1')).toMatchObject({ id: '1' });

			// Discord said both roles are gone, and that did not stop being true. The role created again after
			// its removal must be the one that stays.
			await owner.adapter.set(...role('1', G, { name: 'created again' }));

			for (const { adapter } of [owner, reader]) {
				expect(await adapter.get('role.1')).toEqual({ id: '1', guild_id: G, name: 'created again' });
				expect((await adapter.keys(ROLES)).sort()).toEqual(['role.1', 'role.3']);
			}
			expect(await owner.inner.get('role.2')).toBeUndefined();
			expect(owner.state.snapshot().failures.map(failure => failure.kind)).toEqual(['removal', 'removal']);
		}));

	it('keeps failing while Redis still does not answer a removal, and recovers by itself', () =>
		withRedis(async ({ worker }) => {
			const owner = await worker();
			await own(owner, [G]);
			await owner.adapter.set(...role('1'));
			const restore = onScript(owner.inner.client, input => {
				if ('mode' in input) throw new Error('Socket closed unexpectedly');
			});
			await expect(owner.adapter.remove('role.1')).rejects.toThrow('Socket closed unexpectedly');

			// Serving anything now could mean serving what was just removed.
			await expect(owner.adapter.get('role.1')).rejects.toThrow('Socket closed unexpectedly');
			await expect(owner.adapter.set(...role('2'))).rejects.toThrow('Socket closed unexpectedly');
			// Another plugin's resource does not depend on any of this.
			await owner.adapter.set('cooldown.a', { uses: 1 }, ['cooldown', 'a']);
			expect(await owner.adapter.get('cooldown.a')).toEqual({ uses: 1 });
			await owner.adapter.remove('cooldown.a');
			expect(await owner.inner.get('cooldown.a')).toBeUndefined();
			restore();

			expect(await owner.adapter.get('role.1')).toBeNull();
			await owner.adapter.set(...role('2'));
			expect(await owner.adapter.keys(ROLES)).toEqual(['role.2']);
			expect(owner.state.lifecycle).toBe('active');
		}));

	it('does not try a removal again when Redis answered it with an error', () =>
		withRedis(async ({ worker }) => {
			const owner = await worker();
			await own(owner, [G]);
			await owner.adapter.set(...role('1'));
			let scripts = 0;
			const restore = onScript(owner.inner.client, input => {
				if (!('mode' in input)) return;
				scripts++;
				throw new ErrorReply('ERR the script could not run');
			});

			await expect(owner.adapter.remove('role.1')).rejects.toThrow('ERR the script could not run');
			expect(await owner.adapter.get('role.1')).toMatchObject({ id: '1' });
			await owner.adapter.set(...role('2'));
			restore();

			expect(scripts).toBe(1);
			expect(await owner.adapter.keys(ROLES)).toEqual(['role.1', 'role.2']);
		}));

	it('gives up a removal Redis rejects when it is tried again, without holding up what follows', () =>
		withRedis(async ({ worker }) => {
			const owner = await worker();
			await own(owner, [G]);
			await owner.adapter.bulkSet([role('1'), role('2')]);
			let attempts = 0;
			const restore = onScript(owner.inner.client, input => {
				if (!('mode' in input)) return;
				// The first attempt gets no answer; the second one gets an error for one.
				if (++attempts === 1) throw new Error('Socket closed unexpectedly');
				if (attempts === 2) throw new ErrorReply('ERR the script could not run');
			});
			await expect(owner.adapter.remove('role.1')).rejects.toThrow('Socket closed unexpectedly');

			await owner.adapter.remove('role.2');
			restore();

			expect(attempts).toBe(3);
			expect(await owner.adapter.keys(ROLES)).toEqual(['role.1']);
			expect(owner.state.snapshot().failures).toMatchObject([
				{ kind: 'removal', key: 'role.1' },
				{ kind: 'removal', key: 'role.1', message: expect.stringContaining('rejected a removal') },
			]);
		}));

	it('does not try the engine own cleanup again', () =>
		withRedis(async ({ worker }) => {
			const left = guildOn(4);
			const owner = await worker();
			await owner.inner.set(...role('r-left', left));
			await own(owner, [G]);
			owner.state.settle(owner.state.guildAvailable(0, G, 2, { startup: true, unavailable: false })!, 'reconciled');
			owner.state.guildsReady(0);
			const claim = owner.state.claimGuild(owner.state.ownership(G)!.generation, left)!;
			let removals = 0;
			const restore = onScript(owner.inner.client, input => {
				if (!('mode' in input)) return;
				removals++;
				throw new Error('Socket closed unexpectedly');
			});
			await expect(
				runUnfiltered(owner.adapter, claim, () => owner.adapter.bulkRemove(['role.r-left'])),
			).rejects.toThrow('Socket closed unexpectedly');
			restore();

			// What it could not remove is unreadable already, and a later reconciliation claims it again.
			await owner.adapter.set(...role('1'));
			expect(removals).toBe(1);
			expect(await owner.inner.get('role.r-left')).toMatchObject({ id: 'r-left' });
		}));

	it('bounds how many unanswered removals it keeps', () =>
		withRedis(async ({ worker }) => {
			const owner = await worker();
			await own(owner, [G]);
			const total = 1030;
			await owner.adapter.bulkSet(Array.from({ length: total }, (_, index) => role(`r${index}`)));
			const restore = onScript(owner.inner.client, input => {
				if ('mode' in input) throw new Error('Socket closed unexpectedly');
			});
			for (let index = 0; index < total; index++) {
				await expect(owner.adapter.remove(`role.r${index}`)).rejects.toThrow('Socket closed unexpectedly');
			}
			restore();

			// The six oldest were given up and reported; everything kept is applied with the next operation.
			const kept = (await owner.adapter.keys(ROLES)).sort();
			expect(kept).toEqual(['role.r0', 'role.r1', 'role.r2', 'role.r3', 'role.r4', 'role.r5']);
			const givenUp = owner.state.snapshot().failures.filter(failure => failure.message.startsWith('Too many'));
			expect(givenUp.map(failure => failure.key)).toEqual(kept);
		}));

	it('reports a failed removal of another plugin resource and still removes what it reconciles', () =>
		withRedis(async ({ worker }) => {
			const owner = await worker();
			await own(owner, [G]);
			await owner.adapter.bulkSet([role('1'), ['cooldown.a', { uses: 1 }, ['cooldown', 'a']]]);
			const failure = new Error('the adapter could not remove it');
			Reflect.set(owner.inner, 'bulkRemove', () => Promise.reject(failure));

			await expect(owner.adapter.bulkRemove(['cooldown.a', 'role.1'])).rejects.toBe(failure);

			expect(await owner.inner.get('role.1')).toBeUndefined();
			expect(await owner.inner.get('cooldown.a')).toEqual({ uses: 1 });
			expect(owner.state.snapshot().failures).toMatchObject([{ kind: 'removal', cause: failure }]);
			// Nothing of it is left to try again.
			await owner.adapter.set(...role('2'));
			expect(await owner.adapter.keys(ROLES)).toEqual(['role.2']);
		}));

	it('does not involve Redis coordination in a removal of resources it does not reconcile', () =>
		withRedis(async ({ worker }) => {
			const owner = await worker();
			await own(owner, [G]);
			await owner.adapter.bulkSet([
				['cooldown.a', { uses: 1 }, ['cooldown', 'a']],
				['cooldown.b', { uses: 1 }, ['cooldown', 'b']],
				['cooldown.c', { uses: 1 }, ['cooldown', 'c']],
			]);
			let scripts = 0;
			const restore = onScript(owner.inner.client, () => {
				scripts++;
			});

			await owner.adapter.remove('cooldown.a');
			await owner.adapter.removeToRelationship('cooldown', 'b');
			await owner.adapter.removeRelationship('cooldown');
			restore();

			expect(scripts).toBe(0);
			expect(await owner.inner.getToRelationship('cooldown')).toEqual([]);
			expect(await owner.inner.get('cooldown.c')).toBeUndefined();
		}));

	it('names the guilds of a mutation that failed', () =>
		withRedis(async ({ worker }) => {
			const reported: { keys: readonly string[]; guildIds: readonly (string | undefined)[] | undefined }[] = [];
			const owner = await worker({
				mutationFailed: (keys, _cause, guildIds) => reported.push({ keys, guildIds }),
			});
			await own(owner, [G]);
			const restore = onScript(owner.inner.client, input => {
				if ('entries' in input || 'mode' in input) throw new Error('connection lost');
			});

			await expect(owner.adapter.bulkSet([role('1'), ['user.9', { id: '9' }, ['user', '9']]])).rejects.toThrow(
				'connection lost',
			);
			await expect(owner.adapter.removeToRelationship(ROLES, '1')).rejects.toThrow('connection lost');
			await expect(owner.adapter.removeRelationship(ROLES)).rejects.toThrow('connection lost');
			await expect(owner.adapter.bulkRemove([`member.${G}.u-1`])).rejects.toThrow('connection lost');
			restore();

			expect(reported).toEqual([
				{ keys: ['role.1', 'user.9'], guildIds: [G, undefined] },
				{ keys: [], guildIds: [G] },
				{ keys: [], guildIds: [G] },
				{ keys: [`member.${G}.u-1`], guildIds: [] },
			]);
			expect(owner.state.snapshot().failures.map(failure => failure.kind)).toEqual([
				'write',
				'removal',
				'removal',
				'removal',
			]);
			expect(owner.state.lifecycle).toBe('active');
		}));

	it('stops serving a removed guild whose removal failed in Redis', () =>
		withRedis(async ({ namespace, raw, worker }) => {
			const adapter = new RedisAdapter({ redisOptions: { url: redisUrl }, namespace });
			const client = new Client({
				plugins: definePlugins(
					cacheReconciler({
						coordinator: redisCoordinator({
							client: adapter.client,
							cacheNamespace: adapter.namespace,
							namespace: `${adapter.namespace}:reconciler`,
						}),
					}),
				),
			});
			client.setServices({ cache: { adapter } });
			const bot = await createMockBot({ client });
			const dispatch = gatewayDispatch(bot);
			try {
				await dispatch(readyPacket({ guilds: [G] }));
				await dispatch(
					guildPacket('RAW_GUILD_CREATE', 2, {
						id: G,
						name: 'guild',
						roles: [{ id: 'r-1' }],
						members: [{ user: { id: 'u-1' } }],
					}),
				);
				await dispatch(guildsReadyPacket(2));
				await client.cacheReconciler.waitForIdle();
				const reader = await worker();
				expect(await reader.adapter.get('role.r-1')).toMatchObject({ id: 'r-1' });
				// Redis rejects the removals of Seyfert's guild cascade.
				const failure = new Error('connection lost');
				const restore = onScript(adapter.client, input => {
					if ('mode' in input) throw failure;
				});

				await expect(dispatch(guildDeletePacket('GUILD_DELETE', 3, { id: G }))).rejects.toBe(failure);
				restore();
				await client.cacheReconciler.waitForIdle();

				const status = client.cacheReconciler.status();
				expect(status).toMatchObject({ lifecycle: 'active', idle: true, pending: { guilds: 0 } });
				expect(status.failures).toContainEqual(expect.objectContaining({ kind: 'guild', guildId: G, cause: failure }));
				// What Seyfert asked to remove went through once Redis answered again. The guild record it never
				// got to is still stored, and no process is served it anymore.
				expect(await raw.exists(`${namespace}:role.r-1`)).toBe(0);
				expect(await raw.exists(`${namespace}:guild.${G}`)).toBe(1);
				expect(await reader.adapter.get(`guild.${G}`)).toBeNull();
				expect(await client.cache.guilds!.raw(G)).toBeUndefined();
				expect(await client.cache.roles!.keys(G)).toEqual([]);
			} finally {
				await bot.close();
				adapter.client.close();
			}
		}));

	it('holds cleanup back until its shard is acquired', () =>
		withRedis(async ({ worker }) => {
			const left = guildOn(4);
			const holder = await worker();
			await holder.inner.bulkSet([role('ghost'), role('r-left', left)]);
			await own(holder, [G]);
			const successor = await worker();
			successor.state.ready(0, 'session-2', 1, [G], 1);
			const work = successor.state.guildAvailable(0, G, 2, { startup: true, unavailable: false })!;
			successor.state.settle(work, 'reconciled');
			successor.state.guildsReady(0);
			const claim = successor.state.claimGuild(work.generation, left)!;

			const target = successor.layout.target('role.ghost', [ROLES, 'ghost'])!;
			const sweeping = successor.binding.sweep([target], {
				generation: work.generation,
				guildId: G,
				sequence: work.sequence,
			});
			const removing = runUnfiltered(successor.adapter, claim, () => successor.adapter.bulkRemove(['role.r-left']));
			await sleep(LEASE_TTL / 2);
			expect(await holder.inner.get('role.ghost')).toMatchObject({ id: 'ghost' });
			holder.state.beginClose();
			await holder.binding.close();

			// Neither was given up as cancelled while the previous owner still held the shard.
			expect(await sweeping).toEqual({ removed: ['role.ghost'], failed: [] });
			await removing;
			expect(await successor.inner.get('role.r-left')).toBeUndefined();
		}));

	it('tells other processes about a new session even when READY itself caches nothing', () =>
		withRedis(async ({ namespace, worker }) => {
			const adapter = new RedisAdapter({ redisOptions: { url: redisUrl }, namespace });
			const client = new Client({
				plugins: definePlugins(
					cacheReconciler({
						coordinator: redisCoordinator({
							client: adapter.client,
							cacheNamespace: adapter.namespace,
							namespace: `${adapter.namespace}:reconciler`,
						}),
					}),
				),
			});
			// Without a users cache Seyfert writes nothing at READY, so no cache traffic carries the news.
			client.setServices({ cache: { adapter, disabledCache: { users: true } } });
			const bot = await createMockBot({ client });
			const dispatch = gatewayDispatch(bot);
			try {
				await dispatch(readyPacket({ guilds: [G] }));
				await dispatch(guildPacket('RAW_GUILD_CREATE', 2, { id: G, name: 'guild', roles: [{ id: 'r-1' }] }));
				await dispatch(guildsReadyPacket(2));
				await client.cacheReconciler.waitForIdle();
				const reader = await worker();
				expect(await reader.adapter.get('role.r-1')).toMatchObject({ id: 'r-1' });

				await dispatch(readyPacket({ guilds: [G], sessionId: 'session-2' }));

				await vi.waitFor(async () => expect(await reader.adapter.get('role.r-1')).toBeNull());
			} finally {
				await bot.close();
				adapter.client.close();
			}
		}));

	it('reconciles a client end to end', () =>
		withRedis(async ({ namespace, raw, worker }) => {
			const left = guildOn(4);
			const adapter = new RedisAdapter({ redisOptions: { url: redisUrl }, namespace });
			const previous = new RedisAdapter({ redisOptions: { url: redisUrl }, namespace });
			await previous.start();
			await previous.bulkSet([
				role('r-gone'),
				[`guild.${left}`, { id: left }, ['guild', left]],
				role('r-left', left),
				[`member.${G}.u-1`, { id: 'u-1' }, [`member.${G}`, 'u-1']],
			]);
			previous.client.close();
			const client = new Client({
				plugins: definePlugins(
					cacheReconciler({
						coordinator: redisCoordinator({
							client: adapter.client,
							cacheNamespace: adapter.namespace,
							namespace: `${adapter.namespace}:reconciler`,
						}),
					}),
				),
			});
			client.setServices({ cache: { adapter } });
			const bot = await createMockBot({ client });
			const dispatch = gatewayDispatch(bot);
			try {
				await dispatch(readyPacket({ guilds: [G] }));
				await dispatch(
					guildPacket('RAW_GUILD_CREATE', 2, {
						id: G,
						name: 'guild',
						roles: [{ id: 'r-kept' }],
						channels: [],
						threads: [],
						emojis: [],
						stickers: [],
						members: [],
						voice_states: [],
						presences: [],
						stage_instances: [],
					}),
				);
				await dispatch(guildsReadyPacket(2));
				await client.cacheReconciler.waitForIdle();

				expect(client.cacheReconciler.status()).toMatchObject({
					coordinator: 'redis',
					lifecycle: 'active',
					shards: [{ startup: 'committed', outcomes: { reconciled: 1 } }],
					failures: [],
				});
				expect(await client.cache.roles!.keys(G)).toEqual(['role.r-kept']);
				expect(await raw.exists(`${namespace}:role.r-gone`)).toBe(0);
				expect(await raw.exists(`${namespace}:guild.${left}`)).toBe(0);
				expect(await raw.exists(`${namespace}:role.r-left`)).toBe(0);
				// A member the snapshot did not list stays stored and unreadable.
				expect(await raw.exists(`${namespace}:member.${G}.u-1`)).toBe(1);
				expect(await client.cache.members!.keys(G)).toEqual([]);
				expect(await raw.hGet(`${namespace}:reconciler:shard:0`, 'committed')).toBe('1');

				// Another process reads what this client confirmed, and stops as soon as the client reconnects.
				const reader = await worker();
				expect(await reader.adapter.get('role.r-kept')).toMatchObject({ id: 'r-kept' });
				await dispatch(readyPacket({ guilds: [G], sessionId: 'session-2' }));
				await vi.waitFor(async () => expect(await reader.adapter.get('role.r-kept')).toBeNull());
			} finally {
				await bot.close();
				// The plugin leaves the caller's client open and gives its lease back.
				expect(adapter.client.isOpen).toBe(true);
				expect(await raw.exists(`${namespace}:reconciler:lease:0`)).toBe(0);
				adapter.client.close();
			}
		}));
});
