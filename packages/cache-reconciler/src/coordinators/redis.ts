import { createHash, randomUUID } from 'node:crypto';
import { ErrorReply, type RedisClientType } from '@redis/client';
import { ExpirableRedisAdapter, RedisAdapter, toDb } from '@slipher/redis-adapter';
import type { AdapterEntry, AdapterIncrementOptions } from 'seyfert';
import {
	type BoundCoordinator,
	type CacheReconcilerCoordinator,
	type CoordinatorBinding,
	type CoordinatorHost,
	ReconciliationCancelled,
	type RelationshipMember,
	type SweepResult,
	type WriteMethod,
} from '../coordinator';
import type { KeyLayout } from '../keys';
import type { GuildClaim, KeyTarget, PartitionChange, ReconciliationState, SnapshotCut } from '../state';

export interface RedisCoordinatorOptions {
	/**
	 * The node-redis client of the `RedisAdapter` being reconciled. The coordinator only issues commands on it;
	 * it never connects or closes it.
	 */
	client: RedisClientType;
	/** `namespace` of that `RedisAdapter`. */
	cacheNamespace: string;
	/** Key prefix for the coordinator's own state. Workers that share the cache must share it too. */
	namespace: string;
	/** @internal Lifetime of a shard lease in milliseconds; an owner renews it three times within that span. */
	leaseTtl?: number;
}

const PLUGIN_NAME = '@slipher/cache-reconciler';
const DEFAULT_LEASE_TTL = 30_000;
/** Entries per script call, the batch size RedisAdapter itself uses. */
const BATCH = 100;
/** Removals kept while Redis does not answer. Beyond it the oldest is given up. */
const MAX_UNCONFIRMED = 1024;
/**
 * Releases remembered per shard. A coordinator asks for its own again only when Redis never answered, so the
 * record has to outlast the releases of that shard that follow before it asks, not all of them.
 */
const RELEASES_KEPT = 16;

/**
 * Shared by every script. All keys derive from the two prefixes, which is the layout contract with
 * `@slipher/redis-adapter`: a value is the hash `<cache>:<key>`, a relationship is the hash
 * `<cache>:relationships:<to>` mapping member id to key, and `<cache>:relationships:owners` maps a key back to
 * `<to>.<id>`.
 *
 * Coordinator state: `vis` maps a key to `<generation>|<sequence>|<guild>`, `guilds` maps an open guild
 * partition to `<generation>|<cut>|<shard>`, `shard:<id>` holds the generation that owns a shard,
 * `shard:<id>:guilds` lists the partitions opened under it, `shard:<id>:released` the last generations that gave
 * its lease back, and `lease:<id>` names the coordinator incarnation that owns the shard. A generation is
 * `<incarnation>:<number>`.
 *
 * A partition only stands while the incarnation that opened it still holds the lease of the shard it opened it
 * under. Whatever ends that ownership, a shutdown, a crash, or a shard count that moved the guild to a shard
 * nobody acquired, also ends what the partition confirmed.
 *
 * `input.held` lists the shards the caller counts on: the ones it holds and is not giving back. If any of those
 * leases is gone the caller is a former owner, and every script refuses to act for it.
 */
const PRELUDE = `
local input = cjson.decode(ARGV[1])
local cache = input.cache
local ns = input.ns
local inc = input.inc
local visKey = ns .. 'vis'
local guildsKey = ns .. 'guilds'
local ownersKey = cache .. 'relationships:owners'

local leases = {}
local function holder(shard)
	local id = tostring(shard)
	local known = leases[id]
	if known == nil then
		known = redis.call('GET', ns .. 'lease:' .. id) or false
		leases[id] = known
	end
	return known
end

local function holds(shard)
	return holder(shard) == inc
end

local fenced = false
for _, shard in ipairs(input.held) do
	if not holds(shard) then fenced = true end
end

local mine = {}
for _, gen in ipairs(input.mine) do mine[gen] = true end

local partitions = {}
local function partition(guild)
	local known = partitions[guild]
	if known == nil then
		local value = redis.call('HGET', guildsKey, guild)
		known = false
		if value then
			local gen, cut, shard = string.match(value, '^(.*)|(%d+)|(%d+)$')
			if gen and holder(shard) == string.match(gen, '^(.*):%d+$') then
				known = { gen, tonumber(cut) }
			else
				-- Its owner is gone and never comes back under that incarnation, or nothing readable opened it.
				redis.call('HDEL', guildsKey, guild)
			end
		end
		partitions[guild] = known
	end
	if not known then return nil, nil end
	return known[1], known[2]
end

local function record(key)
	local value = redis.call('HGET', visKey, key)
	if not value then return nil end
	local gen, seq, guild = string.match(value, '^(.*)|(%d+)|([^|]*)$')
	return gen, tonumber(seq), guild
end

-- While one of its shards waits for READY, the caller cannot tell which guilds that shard owns. It then only
-- reads and changes what it can place: entries no guild owns, and the guilds its own generations opened.
local function placed(guild)
	if not input.hide or guild == '' then return true end
	return mine[partition(guild)] == true
end

local function visible(key)
	local gen, seq, guild = record(key)
	if not gen then return false end
	if guild == '' then return true end
	local pgen, cut = partition(guild)
	if not pgen or pgen ~= gen or seq < cut then return false end
	return placed(guild)
end

-- Whether a caller's own removal may touch the key.
local function removable(key)
	if not input.hide then return true end
	local gen, _, guild = record(key)
	return gen ~= nil and placed(guild)
end

local function commit(key, gen, seq, guild)
	local known, knownSeq = record(key)
	if known == gen and knownSeq > seq then seq = knownSeq end
	redis.call('HSET', visKey, key, gen .. '|' .. string.format('%d', seq) .. '|' .. guild)
end

local function forget(key)
	local owner = redis.call('HGET', ownersKey, key)
	if owner then
		local to, id = string.match(owner, '^(.*)%.([^%.]+)$')
		if to then redis.call('HDEL', cache .. 'relationships:' .. to, id) end
		redis.call('HDEL', ownersKey, key)
	end
	redis.call('DEL', cache .. key)
	redis.call('HDEL', visKey, key)
end
`;

/**
 * Applies ownership and partition changes in order. It stops at a lease another incarnation still holds. A
 * change for a shard this incarnation gave back, or for a generation the shard already replaced, is skipped:
 * the same owner simply moved on. Losing a lease it still counts on is what the shared check reports.
 *
 * `input.giving` lists the shards the batch gives back, each with the generation of its first release there,
 * the one that ends what the caller counted on. Redis may have run the batch before and lost the reply, so a
 * lease that is gone is only a lost one when that release is not on record as having given it back. Who took
 * the shard since does not change that, nor who gave it back, for as many releases as the record keeps.
 */
const META_SCRIPT = `${PRELUDE}
local function gaveBack(shard, gen)
	for _, released in ipairs(redis.call('LRANGE', ns .. 'shard:' .. shard .. ':released', 0, -1)) do
		if released == gen then return true end
	end
	return false
end
for _, giving in ipairs(input.giving or {}) do
	if not holds(giving[1]) and not gaveBack(giving[1], giving[2]) then fenced = true end
end
if fenced then return {'fenced'} end
local results = {}
for index, op in ipairs(input.ops) do
	local kind, shard, gen = op[1], op[2], op[3]
	local leaseKey = ns .. 'lease:' .. shard
	local shardKey = ns .. 'shard:' .. shard
	local membersKey = shardKey .. ':guilds'
	-- Only the partitions this shard's generation opened are its own to close.
	local function invalidate(generation)
		for _, guild in ipairs(redis.call('SMEMBERS', membersKey)) do
			if partition(guild) == generation then redis.call('HDEL', guildsKey, guild) end
		end
		redis.call('DEL', membersKey)
		partitions = {}
	end
	if kind == 'acquire' then
		local current = redis.call('GET', leaseKey)
		if current and current ~= inc then
			results[index] = 'busy'
			break
		end
		redis.call('SET', leaseKey, inc, 'PX', input.ttl)
		leases[tostring(shard)] = inc
		partitions = {}
		invalidate(redis.call('HGET', shardKey, 'gen'))
		redis.call('HSET', shardKey, 'gen', gen, 'owner', inc, 'committed', '0')
		results[index] = 'ok'
	elseif kind == 'release' then
		-- Giving the lease back is what closes the shard's guilds for every reader. The record it leaves is how
		-- the same release, asked again, is told apart from a lease that was lost.
		if holds(shard) then
			redis.call('DEL', leaseKey)
			redis.call('LPUSH', shardKey .. ':released', gen)
			redis.call('LTRIM', shardKey .. ':released', 0, ${RELEASES_KEPT - 1})
			leases[tostring(shard)] = false
			partitions = {}
		end
		results[index] = 'ok'
	elseif not holds(shard) or redis.call('HGET', shardKey, 'gen') ~= gen then
		-- The shard was given back or moved on to another generation: nothing is left for the change to apply to.
		results[index] = 'superseded'
	elseif kind == 'renew' then
		redis.call('PEXPIRE', leaseKey, input.ttl)
		results[index] = 'ok'
	elseif kind == 'open' then
		redis.call('HSET', guildsKey, op[4], gen .. '|' .. string.format('%d', op[5]) .. '|' .. tostring(shard))
		redis.call('SADD', membersKey, op[4])
		partitions[op[4]] = nil
		results[index] = 'ok'
	elseif kind == 'close' then
		if partition(op[4]) == gen then redis.call('HDEL', guildsKey, op[4]) end
		redis.call('SREM', membersKey, op[4])
		partitions[op[4]] = nil
		results[index] = 'ok'
	else
		redis.call('HSET', shardKey, 'committed', '1')
		results[index] = 'ok'
	end
end
return {'ok', results}
`;

/**
 * Writes each entry together with its fence and visibility. An entry is
 * { key, to, id, op, fields, logicalFields, kind, guild, gen, seq, channel }, where kind is `g` for a resource
 * no shard owns, `o` for a guild this incarnation owns (its lease is among the ones the shared check covers),
 * `f` for a guild it does not, and `m` for a message, whose guild is the one its channel was filed under.
 */
const WRITE_SCRIPT = `${PRELUDE}
if fenced then return {'fenced'} end
local statuses = {}
for index, e in ipairs(input.entries) do
	local key, to, id, op, fields, logicalFields, kind, guild = e[1], e[2], e[3], e[4], e[5], e[6], e[7], e[8]
	local gen, seq = '', 0
	local status = 'ok'
	if kind == 'm' then
		local _, _, channelGuild = record(e[11])
		guild = channelGuild or ''
	end
	if kind == 'o' then
		local pgen = partition(guild)
		if pgen and pgen ~= e[9] then
			-- Another generation opened this guild since: a write stamped by this one would only hide it.
			status = 'superseded'
		else
			gen, seq = e[9], e[10]
		end
	elseif guild ~= '' then
		local pgen, cut = partition(guild)
		if not placed(guild) then
			status = 'skipped'
		elseif pgen then
			gen, seq = pgen, cut
		end
	end
	if status == 'ok' then
		local valueKey = cache .. key
		if op == 'auto' then
			if visible(key) then op = 'patch' else op = 'replace' end
		end
		if op == 'replace' then
			redis.call('DEL', valueKey)
		else
			for _, field in ipairs(logicalFields) do
				redis.call('HDEL', valueKey, field, 'B_' .. field, 'N_' .. field, 'O_' .. field)
			end
		end
		redis.call('HSET', valueKey, unpack(fields))
		redis.call('PERSIST', valueKey)
		redis.call('HSETEX', cache .. 'relationships:' .. to, 'FIELDS', 1, id, key)
		redis.call('HSETEX', ownersKey, 'FIELDS', 1, key, to .. '.' .. id)
		commit(key, gen, seq, guild)
	end
	statuses[index] = status
end
return {'ok', statuses}
`;

/**
 * Removes keys with their relationship membership and visibility. `claim` requires the guild partition to be
 * closed under the caller's generation; `sweep` is removeIfVersionAtMost: it spares a key written after the cut.
 */
const REMOVE_SCRIPT = `${PRELUDE}
if fenced then return {'fenced'} end
local mode = input.mode
if mode ~= 'plain' then
	-- A lease this incarnation still counts on was checked above; one it gave back only ends this removal.
	if not holds(input.shard) then return {'cancelled'} end
	if redis.call('HGET', ns .. 'shard:' .. input.shard, 'gen') ~= input.gen then return {'cancelled'} end
	local pgen, cut = partition(input.guild)
	if mode == 'claim' and pgen then return {'cancelled'} end
	if mode == 'sweep' and (pgen ~= input.gen or cut ~= input.cut) then return {'cancelled'} end
end
local removed = {}
for _, key in ipairs(input.keys) do
	local keep = false
	if mode == 'sweep' then
		local gen, seq = record(key)
		keep = gen == input.gen and seq > input.cut
	elseif mode == 'plain' then
		keep = not removable(key)
	end
	if not keep then
		forget(key)
		removed[#removed + 1] = key
	end
end
return {'ok', removed}
`;

/** Reads and removals addressed through a relationship. */
const MEMBERS_SCRIPT = `${PRELUDE}
if fenced then return {'fenced'} end
local relationshipKey = cache .. 'relationships:' .. input.to
if input.action == 'list' then
	local entries = redis.call('HGETALL', relationshipKey)
	local members = {}
	for index = 1, #entries, 2 do
		if visible(entries[index + 1]) then
			members[#members + 1] = entries[index]
			members[#members + 1] = entries[index + 1]
		end
	end
	return {'ok', members}
end
if input.action == 'contains' then
	local key = redis.call('HGET', relationshipKey, input.id)
	if key and visible(key) then return {'ok', 1} end
	return {'ok', 0}
end
if input.mode == 'claim' then
	if not holds(input.shard) then return {'cancelled'} end
	if redis.call('HGET', ns .. 'shard:' .. input.shard, 'gen') ~= input.gen then return {'cancelled'} end
	if partition(input.guild) then return {'cancelled'} end
end
local ids = input.ids
if input.action == 'drop' then ids = redis.call('HKEYS', relationshipKey) end
local kept = false
for _, id in ipairs(ids) do
	local key = redis.call('HGET', relationshipKey, id)
	if key and input.mode == 'plain' and not removable(key) then
		kept = true
	elseif key then
		-- The value goes with the membership only while this relationship is still the one the key is filed under.
		if redis.call('HGET', ownersKey, key) == input.to .. '.' .. id then
			redis.call('DEL', cache .. key)
			redis.call('HDEL', ownersKey, key)
			redis.call('HDEL', visKey, key)
		end
		redis.call('HDEL', relationshipKey, id)
	end
end
if input.action == 'drop' and not kept then redis.call('DEL', relationshipKey) end
return {'ok'}
`;

const VISIBLE_SCRIPT = `${PRELUDE}
if fenced then return {'fenced'} end
local flags = {}
for index, key in ipairs(input.keys) do
	if visible(key) then flags[index] = 1 else flags[index] = 0 end
end
return {'ok', flags}
`;

const SCRIPTS = [META_SCRIPT, WRITE_SCRIPT, REMOVE_SCRIPT, MEMBERS_SCRIPT, VISIBLE_SCRIPT];
const SCRIPT_SHAS = new Map(SCRIPTS.map(script => [script, createHash('sha1').update(script).digest('hex')]));

type MetaOp =
	| [kind: 'acquire' | 'commit' | 'renew' | 'release', shard: number, gen: string]
	| [kind: 'open', shard: number, gen: string, guild: string, cut: number]
	| [kind: 'close', shard: number, gen: string, guild: string];

/** Why a removal runs: a caller's own, or the reconciliation engine's under a guild claim. */
type Fence = { mode: 'plain' } | { mode: 'claim'; shard: number; gen: string; guild: string };

/** Raised inside the binding once a script found one of this incarnation's leases gone. */
class LeaseLost extends Error {}

/** One removal as the adapter was asked for it. */
interface Removal {
	/** Keys the failure is reported with. A guild record among them closes its guild. */
	readonly keys: string[];
	/** Relationships addressed, which name the guild where the keys do not. */
	readonly relationships: string[];
	readonly claim: GuildClaim | undefined;
	/** The part that belongs to other plugins' resources, which goes to the adapter as it came. */
	readonly passthrough: (() => Promise<unknown>) | undefined;
	/** The reconciled part, as coordinator scripts. Absent when nothing reconciled is addressed. */
	readonly scripted: ((fence: Fence) => Promise<string>) | undefined;
}

/** A caller's removal Redis never answered. */
interface UnconfirmedRemoval {
	readonly key: string | undefined;
	run(): Promise<unknown>;
}

/** Changes of a shard whose lease another incarnation still holds, waiting for it to be given up. */
interface ParkedShard {
	readonly changes: PartitionChange[];
	readonly timer: NodeJS.Timeout;
	readonly acquired: Promise<void>;
	settle(): void;
}

/**
 * Coordinates reconciliation across every worker that shares one Redis cache.
 *
 * Ownership, causal fences, and visibility live in Redis, and every mutation of a reconciled key runs as one
 * Lua script that checks the owner, applies the fence, changes the cache, and commits visibility together.
 * That requires knowing how `RedisAdapter` lays out its storage, so only the exact `RedisAdapter` of the
 * pinned `@slipher/redis-adapter` version is accepted. Reads ask Redis which keys are visible before they use
 * the adapter, which costs one extra round trip per read.
 */
export function redisCoordinator(options: RedisCoordinatorOptions): CacheReconcilerCoordinator {
	const { cacheNamespace, namespace } = options ?? {};
	if (typeof cacheNamespace !== 'string' || !cacheNamespace || typeof namespace !== 'string' || !namespace) {
		throw new TypeError(`${PLUGIN_NAME} redisCoordinator requires non-empty cacheNamespace and namespace strings.`);
	}
	if (namespace === cacheNamespace) {
		throw new TypeError(
			`${PLUGIN_NAME} redisCoordinator needs its own namespace: "${namespace}" is the cache namespace itself.`,
		);
	}
	const ttl = options.leaseTtl ?? DEFAULT_LEASE_TTL;
	if (!Number.isInteger(ttl) || ttl <= 0) {
		throw new TypeError(`${PLUGIN_NAME} redisCoordinator leaseTtl must be a positive integer.`);
	}
	const coordinator: BoundCoordinator = {
		kind: 'redis',
		bind: host => new RedisBinding(host, { ...options, leaseTtl: ttl }),
	};
	return coordinator;
}

class RedisBinding implements CoordinatorBinding {
	private readonly inner: RedisAdapter;
	private readonly state: ReconciliationState;
	private readonly layout: KeyLayout;
	private readonly client: RedisClientType;
	private readonly cachePrefix: string;
	private readonly prefix: string;
	private readonly ttl: number;
	/** Never reused: a restarted process or a second binding is a different owner. */
	private readonly incarnation = randomUUID();
	/** Shards this incarnation acquired, with the generation each lease was taken for. */
	private readonly owned = new Map<number, number>();
	private readonly parked = new Map<number, ParkedShard>();
	/** Shards whose contended lease was already reported, so a long wait is recorded once. */
	private readonly contended = new Set<number>();
	private queue: PartitionChange[] = [];
	/** Removals of this process that Redis never answered, oldest first. */
	private unconfirmed: UnconfirmedRemoval[] = [];
	private applying: Promise<void> | undefined;
	private renewal: NodeJS.Timeout | undefined;
	private lastRenewal = 0;
	/** Sticky: losing a lease is terminal for this coordinator, also while its client closes afterwards. */
	private leaseLost = false;
	/** Set once the instance stopped admitting work. Nothing waits for a contended lease from then on. */
	private stopped = false;
	private closed = false;

	constructor(
		private readonly host: CoordinatorHost,
		options: Required<RedisCoordinatorOptions>,
	) {
		this.inner = assertRedisAdapter(host.inner, options);
		this.state = host.state;
		this.layout = host.layout;
		this.client = options.client;
		this.cachePrefix = `${options.cacheNamespace}:`;
		this.prefix = `${options.namespace}:`;
		this.ttl = options.leaseTtl;
		this.state.subscribe(change => (this.parked.get(change.shardId)?.changes ?? this.queue).push(change));
		// Nothing waits for a lease once the instance stops admitting work; running sweeps still need the renewal.
		this.state.onStop(() => this.unpark());
	}

	async start(): Promise<void> {
		await Promise.all(SCRIPTS.map(script => this.client.scriptLoad(script)));
		await this.assertLayout();
		this.lastRenewal = performance.now();
		this.renewal = setInterval(() => void this.renew(), this.retryDelay);
		this.renewal.unref();
	}

	/**
	 * Stops renewing first, then gives back the leases this incarnation still holds. It counts on none of them
	 * by then: a lease that is already gone does not keep the others from being given back. A lease Redis may
	 * have handed over without its reply arriving is given back too.
	 */
	async close(): Promise<void> {
		this.closed = true;
		clearInterval(this.renewal);
		this.unpark();
		await this.applying?.catch(() => undefined);
		const leases = new Map(this.owned);
		for (const change of this.queue) if (change.type === 'generation') leases.set(change.shardId, change.generation);
		const releases: MetaOp[] = [...leases].map(([shard, generation]) => ['release', shard, this.token(generation)]);
		if (!releases.length || this.leaseLost) return;
		try {
			await this.call(META_SCRIPT, { ops: releases, ttl: this.ttl, held: [] });
		} catch (cause) {
			if (cause instanceof LeaseLost) return;
			this.state.recordFailure({
				kind: 'session',
				message: 'The shard leases could not be released; they expire on their own.',
				cause,
			});
		} finally {
			this.owned.clear();
		}
	}

	publish(): Promise<void> {
		return this.sync();
	}

	visibleKeys(keys: readonly string[]): Promise<string[]> {
		if (!keys.length) return Promise.resolve([]);
		return this.reading([], async () => {
			const flags = await this.call<number[]>(VISIBLE_SCRIPT, { keys });
			return keys.filter((_, index) => flags[index] === 1);
		});
	}

	visibleMembers(to: string): Promise<RelationshipMember[]> {
		return this.reading([], async () => {
			const flat = await this.call<string[]>(MEMBERS_SCRIPT, { action: 'list', to });
			const members: RelationshipMember[] = [];
			for (let index = 0; index < flat.length; index += 2) members.push({ id: flat[index]!, key: flat[index + 1]! });
			return members;
		});
	}

	containsMember(to: string, id: string): Promise<boolean> {
		return this.reading(
			false,
			async () => (await this.call<number>(MEMBERS_SCRIPT, { action: 'contains', to, id })) === 1,
		);
	}

	async write(method: WriteMethod, entries: AdapterEntry[]): Promise<void> {
		const patch = method === 'patch' || method === 'bulkPatch';
		const managed = entries.filter(([key]) => this.layout.manages(key));
		const unmanaged = entries.filter(([key]) => !this.layout.manages(key));
		try {
			// Another plugin's entries are not this coordinator's to fence; they go to the adapter as they came.
			if (unmanaged.length) await (patch ? this.inner.bulkPatch(unmanaged) : this.inner.bulkSet(unmanaged));
			for (let offset = 0; offset < managed.length; offset += BATCH) {
				const batch = managed.slice(offset, offset + BATCH);
				await this.published(batch.map(([key, , relationship]) => this.shardOf(key, relationship)));
				const encoded = batch.map(entry => this.encode(entry, patch)).filter(entry => entry !== undefined);
				if (encoded.length) await this.call<string[]>(WRITE_SCRIPT, { entries: encoded });
			}
		} catch (cause) {
			// A coordinator that lost its lease stops admitting reconciled writes instead of writing unfenced.
			if (cause instanceof LeaseLost) return;
			this.state.recordFailure({
				kind: 'write',
				message: 'A cache write failed in Redis; the affected keys keep their previous visibility.',
				key: entries[0]?.[0],
				cause,
			});
			this.host.mutationFailed?.(
				entries.map(([key]) => key),
				cause,
				entries.map(([key, , relationship]) => this.layout.target(key, relationship)?.guildId),
			);
			throw cause;
		}
	}

	async increment(
		key: string,
		field: string,
		delta: number,
		options?: AdapterIncrementOptions,
	): Promise<number | undefined> {
		if (this.layout.manages(key) && !(await this.visibleKeys([key])).length) return undefined;
		return this.inner.increment(key, field, delta, options);
	}

	remove(_method: 'remove' | 'bulkRemove', keys: string[], claim?: GuildClaim): Promise<void> {
		const managed = keys.filter(key => this.layout.manages(key));
		const unmanaged = keys.filter(key => !this.layout.manages(key));
		return this.removing({
			keys,
			relationships: [],
			claim,
			passthrough: unmanaged.length ? () => this.inner.bulkRemove(unmanaged) : undefined,
			scripted: managed.length
				? async fence => {
						for (let offset = 0; offset < managed.length; offset += BATCH) {
							const batch = managed.slice(offset, offset + BATCH);
							const status = await this.status(REMOVE_SCRIPT, { ...fence, keys: batch });
							if (status !== 'ok') return status;
						}
						return 'ok';
					}
				: undefined,
		});
	}

	removeMembers(to: string, ids: string[], claim?: GuildClaim): Promise<void> {
		// A member of the guild relationship is a guild record, whose removal closes the guild.
		const records = ids.map(id => `${to}.${id}`).filter(key => this.layout.guildRecord(key) !== undefined);
		const managed = this.layout.manages(to);
		return this.removing({
			keys: records,
			relationships: [to],
			claim,
			passthrough: managed ? undefined : () => this.inner.removeToRelationship(to, ids),
			scripted: managed ? fence => this.status(MEMBERS_SCRIPT, { ...fence, action: 'remove', to, ids }) : undefined,
		});
	}

	removeRelationships(relationships: string[], claim?: GuildClaim): Promise<void> {
		const managed = relationships.filter(to => this.layout.manages(to));
		const unmanaged = relationships.filter(to => !this.layout.manages(to));
		return this.removing({
			keys: [],
			relationships,
			claim,
			passthrough: unmanaged.length ? () => this.inner.removeRelationship(unmanaged) : undefined,
			scripted: managed.length
				? async fence => {
						for (const to of await this.expand(managed)) {
							const status = await this.status(MEMBERS_SCRIPT, { ...fence, action: 'drop', to });
							if (status !== 'ok') return status;
						}
						return 'ok';
					}
				: undefined,
		});
	}

	/**
	 * Deletes every cache hash but keeps the coordinator's own state, which lives under the same Redis and may
	 * sit under the cache namespace. Visibility goes first, so nothing is readable while the scan runs. One scan
	 * reaches every key that existed when it started; a write that races it is later than the flush.
	 */
	async flush(): Promise<void> {
		try {
			await this.sync();
			// The lease check of any script: a former owner must not wipe what the new owner cached.
			await this.call(VISIBLE_SCRIPT, { keys: [] });
			await this.client.unlink(`${this.prefix}vis`);
			for await (const keys of this.client.scanIterator({ MATCH: `${this.cachePrefix}*`, TYPE: 'hash' })) {
				const stale = keys.filter(key => !key.startsWith(this.prefix));
				if (stale.length) await this.client.unlink(stale);
			}
		} catch (cause) {
			if (cause instanceof LeaseLost) return;
			this.state.recordFailure({ kind: 'removal', message: 'flush failed in Redis.', cause });
			throw cause;
		}
	}

	async closeGuild(guildId: string, upTo: number): Promise<void> {
		this.state.closeGuild(guildId, upTo);
		await this.sync();
	}

	async sweep(targets: readonly KeyTarget[], cut: SnapshotCut): Promise<SweepResult> {
		const result: SweepResult = { removed: [], failed: [] };
		const shard = this.state.shardOfGeneration(cut.generation);
		const keys = targets
			.filter(target => target.guildId === cut.guildId && target.replaceable)
			.map(target => target.key);
		if (shard === undefined || !this.state.admits) return result;
		const fence = { mode: 'sweep', shard, gen: this.token(cut.generation), guild: cut.guildId, cut: cut.sequence };
		for (let offset = 0; offset < keys.length; offset += BATCH) {
			// Closing or failing fences every delete that has not left yet.
			if (!this.state.admits) break;
			const batch = keys.slice(offset, offset + BATCH);
			try {
				await this.published([shard]);
				result.removed.push(...(await this.call<string[]>(REMOVE_SCRIPT, { ...fence, keys: batch })));
			} catch (cause) {
				// A newer READY, a reopened guild, or a lost lease ends the sweep; none of them is a failure.
				if (cause instanceof LeaseLost || cause instanceof ReconciliationCancelled) break;
				result.failed.push(...batch);
				this.state.recordFailure({
					kind: 'removal',
					message: 'A sweep failed in Redis; its candidates stay as they were until a later reconciliation.',
					key: batch[0],
					cause,
				});
			}
		}
		return result;
	}

	/**
	 * Brings Redis up to date with the generations and partitions the Gateway interceptor reported, in order.
	 * Every operation runs behind it, so a READY always acquires its shard lease before a mutation that depends
	 * on it. A shard whose lease is still held elsewhere is set aside so it does not hold up the others.
	 */
	private async sync(): Promise<void> {
		while ((this.applying || this.queue.length || this.unconfirmed.length) && !this.closed && !this.leaseLost) {
			this.applying ??= this.applyChanges().finally(() => {
				this.applying = undefined;
			});
			await this.applying;
		}
	}

	private async applyChanges(): Promise<void> {
		while (this.queue.length && !this.leaseLost && !this.closed) {
			const changes = this.queue;
			this.queue = [];
			// A shard the batch gives back is judged by its release instead of counted on: Redis may have given
			// it back already and lost the reply, and asking twice is not losing it.
			const giving = new Map<number, string>();
			for (const change of changes) {
				if (change.type !== 'suspended' || !this.owned.has(change.shardId) || giving.has(change.shardId)) continue;
				giving.set(change.shardId, this.token(change.generation));
			}
			let results: string[];
			try {
				results = await this.call<string[]>(META_SCRIPT, {
					ops: changes.map(change => this.metaOp(change)),
					ttl: this.ttl,
					held: [...this.owned.keys()].filter(shard => !giving.has(shard)),
					giving: [...giving],
				});
			} catch (cause) {
				if (cause instanceof LeaseLost) return;
				// The reply is unknown. Every change is safe to apply again, so they go back in front.
				this.queue = [...changes, ...this.queue];
				throw cause;
			}
			for (const [index, result] of results.entries()) {
				const change = changes[index]!;
				if (result === 'busy') {
					this.park(change.shardId, changes.slice(index));
					break;
				}
				if (change.type === 'generation') {
					this.owned.set(change.shardId, change.generation);
					this.contended.delete(change.shardId);
					this.lastRenewal = performance.now();
				} else if (change.type === 'suspended') this.owned.delete(change.shardId);
			}
		}
		await this.confirmRemovals();
	}

	/**
	 * Runs the removals Redis never answered, oldest first and ahead of anything this process does next, so
	 * nothing it reads or writes afterwards meets an entry that evidence already removed. While Redis still does
	 * not answer, the operation behind it fails too.
	 */
	private async confirmRemovals(): Promise<void> {
		while (this.unconfirmed.length && !this.leaseLost && !this.closed) {
			const removal = this.unconfirmed[0]!;
			try {
				await removal.run();
			} catch (cause) {
				if (cause instanceof LeaseLost) return;
				if (!(cause instanceof ErrorReply)) throw cause;
				// An error reply is an answer. This removal will not go through, and must not hold up the rest.
				this.state.recordFailure({
					kind: 'removal',
					message: 'Redis rejected a removal when it was tried again; its entries stay as they were.',
					key: removal.key,
					cause,
				});
			}
			if (this.unconfirmed[0] === removal) this.unconfirmed.shift();
		}
	}

	/** Keeps a removal Redis never answered, to run it again ahead of this process's next operation. */
	private unconfirm(key: string | undefined, run: () => Promise<unknown>): void {
		this.unconfirmed.push({ key, run });
		if (this.unconfirmed.length <= MAX_UNCONFIRMED) return;
		const dropped = this.unconfirmed.shift();
		this.state.recordFailure({
			kind: 'removal',
			message:
				'Too many removals are waiting for Redis. The oldest was given up; its entries stay as they were until the next READY of their shard.',
			key: dropped?.key,
		});
	}

	/**
	 * Another incarnation still holds the shard's lease: it has to release it or let it expire. The shard's
	 * changes wait together and are tried again later, while everything else carries on.
	 */
	private park(shardId: number, rest: PartitionChange[]): void {
		// What was reported for the shard while the attempt was on its way sits in the queue, behind `rest`.
		const waiting = [...rest, ...this.queue];
		this.queue = waiting.filter(change => change.shardId !== shardId);
		const changes = waiting.filter(change => change.shardId === shardId);
		// An attempt that was already on its way when the instance stopped must not start the wait again.
		if (this.stopped) return;
		// A parked shard's changes never reach a script, so there is no second wait to start. Should that ever
		// change, the first wait keeps its timer and whoever waits on it.
		const parked = this.parked.get(shardId);
		if (parked) {
			parked.changes.push(...changes);
			return;
		}
		let settle!: () => void;
		const acquired = new Promise<void>(resolve => {
			settle = resolve;
		});
		const timer = setTimeout(() => {
			const parked = this.parked.get(shardId);
			if (!parked) return;
			this.parked.delete(shardId);
			this.queue = [...parked.changes, ...this.queue];
			void this.sync().then(parked.settle, parked.settle);
		}, this.retryDelay);
		timer.unref();
		this.parked.set(shardId, { changes, timer, acquired, settle });
		if (this.contended.has(shardId)) return;
		this.contended.add(shardId);
		this.state.recordFailure({
			kind: 'session',
			message: 'The shard lease is held by another coordinator; this one waits for it to be released or to expire.',
			shardId,
		});
	}

	/** Gives up waiting for contended leases, for good. The changes that waited for them are dropped with the wait. */
	private unpark(): void {
		this.stopped = true;
		for (const parked of this.parked.values()) {
			clearTimeout(parked.timer);
			parked.settle();
		}
		this.parked.clear();
	}

	/**
	 * Publishes what the interceptor reported and waits for the leases of these shards while another coordinator
	 * still holds them, so nothing that depends on owning a shard runs ahead of acquiring it.
	 */
	private async published(shards: Iterable<number | undefined>): Promise<void> {
		await this.sync();
		for (const shard of shards) {
			while (shard !== undefined && this.parked.has(shard)) {
				await this.parked.get(shard)!.acquired;
				await this.sync();
			}
		}
	}

	/** The shard this process owns the entry's guild through, if any. */
	private shardOf(key: string, relationship: readonly [to: string, id: string]): number | undefined {
		const guildId = this.layout.target(key, relationship)?.guildId;
		return guildId === undefined ? undefined : this.state.ownership(guildId)?.shardId;
	}

	private metaOp(change: PartitionChange): MetaOp {
		const gen = this.token(change.generation);
		switch (change.type) {
			case 'generation':
				return ['acquire', change.shardId, gen];
			case 'suspended':
				// The shard's cache is no longer followed, and nothing stays readable without an owner.
				return ['release', change.shardId, gen];
			case 'opened':
				return ['open', change.shardId, gen, change.guildId, change.cut];
			case 'closed':
				return ['close', change.shardId, gen, change.guildId];
			case 'committed':
				return ['commit', change.shardId, gen];
		}
	}

	/**
	 * Extends the owned leases. A lease that could not be confirmed for its whole lifetime counts as lost. The
	 * renewal names its shards one by one instead of counting on all of them, because a shard this coordinator
	 * is giving back at that moment is not a lost lease.
	 */
	private async renew(): Promise<void> {
		if (this.closed || this.leaseLost || !this.owned.size) return;
		const leases = [...this.owned];
		const ops: MetaOp[] = leases.map(([shard, generation]) => ['renew', shard, this.token(generation)]);
		let results: string[];
		try {
			results = await this.call<string[]>(META_SCRIPT, { ops, ttl: this.ttl, held: [] });
		} catch (cause) {
			if (cause instanceof LeaseLost || performance.now() - this.lastRenewal < this.ttl) return;
			this.lost('The shard leases could not be renewed before they expired.', cause);
			return;
		}
		const refused = leases.filter((_, index) => results[index] !== 'ok');
		if (refused.length) {
			// A release or a new READY of its own may be what moved the shard on, also one Redis applied without
			// its reply ever arriving. Whatever is queued is applied before the refusal is judged; if that cannot
			// be done now, the next renewal judges it.
			try {
				await this.sync();
			} catch {
				return;
			}
			if (refused.some(([shard, generation]) => this.owned.get(shard) === generation)) {
				this.lost('A shard lease this coordinator held is owned by another coordinator or expired.');
				return;
			}
		}
		this.lastRenewal = performance.now();
	}

	private lost(message: string, cause?: unknown): void {
		if (this.leaseLost || this.closed) return;
		this.leaseLost = true;
		clearInterval(this.renewal);
		this.unpark();
		this.owned.clear();
		this.queue = [];
		this.unconfirmed = [];
		this.state.fail(new Error(`${PLUGIN_NAME}: ${message} This coordinator stopped serving the cache.`, { cause }));
	}

	private get retryDelay(): number {
		return Math.max(1, Math.floor(this.ttl / 3));
	}

	/**
	 * An entry as the write script takes it, or nothing for a guild whose shard this process was given a session
	 * for but does not hold. That only happens once it stopped waiting for the lease, and then its write is
	 * older than whatever the shard's owner cached since.
	 */
	private encode([key, value, relationship]: AdapterEntry, patch: boolean): unknown[] | undefined {
		const fields = Object.entries(toDb(value)).flat();
		const logicalFields = Array.isArray(value) ? [] : Object.keys(value);
		const op = !patch || Array.isArray(value) ? 'replace' : 'auto';
		const head = [key, relationship[0], relationship[1], op, fields, logicalFields];
		const channel = this.layout.messageChannel(relationship[0]);
		if (channel !== undefined) return [...head, 'm', '', '', 0, channel];
		const guildId = this.layout.target(key, relationship)?.guildId;
		if (guildId === undefined) return [...head, 'g', ''];
		const owner = this.state.ownership(guildId);
		if (!owner) return [...head, 'f', guildId];
		if (!this.owned.has(owner.shardId)) return;
		return [...head, 'o', guildId, this.token(owner.generation), owner.sequence];
	}

	/** Runs a removal, fenced by the guild claim when the reconciliation engine issued it. */
	private async removing({ keys, relationships, claim, passthrough, scripted }: Removal): Promise<void> {
		let fence: Fence = { mode: 'plain' };
		let shard: number | undefined;
		if (claim) {
			shard = this.state.shardOfGeneration(claim.generation);
			if (shard === undefined || !this.state.guildClaimHolds(claim)) throw new ReconciliationCancelled();
			fence = { mode: 'claim', shard, gen: this.token(claim.generation), guild: claim.guildId };
		}
		for (const key of keys) {
			// Removing the guild record closes its partition: every descendant stops being readable with it.
			const guildId = this.layout.guildRecord(key);
			if (guildId !== undefined) this.state.closeGuild(guildId);
		}
		let failure: { cause: unknown } | undefined;
		try {
			await passthrough?.();
		} catch (cause) {
			failure = { cause };
		}
		let status = 'ok';
		if (scripted) {
			try {
				await this.published([shard]);
				status = await scripted(fence);
			} catch (cause) {
				if (cause instanceof LeaseLost) {
					if (claim) throw new ReconciliationCancelled();
				} else {
					// Redis never answered, so the removal may not have happened, and what it was evidence of still
					// holds. An error reply is an answer and is not tried again; neither is the engine's own cleanup,
					// whose entries are unreadable already.
					if (!claim && !(cause instanceof ErrorReply)) this.unconfirm(keys[0], () => scripted(fence));
					failure ??= { cause };
				}
			}
		}
		if (failure) {
			const { cause } = failure;
			this.state.recordFailure({ kind: 'removal', message: 'A removal failed in Redis.', key: keys[0], cause });
			this.host.mutationFailed?.(
				keys,
				cause,
				relationships.map(to => this.layout.relationshipGuild(to)),
			);
			throw cause;
		}
		if (status !== 'ok') throw new ReconciliationCancelled();
	}

	/** Resolves wildcard relationships the way RedisAdapter does, by scanning for the stored relationship hashes. */
	private async expand(relationships: string[]): Promise<string[]> {
		const exact: string[] = [];
		const base = `${this.cachePrefix}relationships:`;
		for (const to of relationships) {
			if (!to.includes('*')) {
				exact.push(to);
				continue;
			}
			for await (const keys of this.client.scanIterator({ MATCH: `${base}${to}`, TYPE: 'hash' })) {
				for (const key of keys) {
					if (key !== `${base}owners`) exact.push(key.slice(base.length));
				}
			}
		}
		return exact;
	}

	/**
	 * Confirms the adapter still stores an entry the way the scripts expect, with an entry of a resource the
	 * reconciler does not manage: where the value, its relationship membership, and its owner go, and how the
	 * fields the scripts remove by name are encoded. A different layout means an untested adapter version.
	 */
	private async assertLayout(): Promise<void> {
		const id = randomUUID();
		const to = 'cache_reconciler_probe';
		const key = `${to}.${id}`;
		await this.inner.set(key, { id, flag: true, count: 1, extra: null }, [to, id]);
		try {
			const [fields, member, owner] = await Promise.all([
				this.client.hmGet(`${this.cachePrefix}${key}`, ['id', 'B_flag', 'N_count', 'O_extra']),
				this.client.hGet(`${this.cachePrefix}relationships:${to}`, id),
				this.client.hGet(`${this.cachePrefix}relationships:owners`, key),
			]);
			const encoded = fields.every(field => typeof field === 'string') && fields[0] === id;
			if (!encoded || member !== key || owner !== `${to}.${id}`) {
				throw new TypeError(
					`${PLUGIN_NAME} redisCoordinator does not recognize the storage layout of the installed @slipher/redis-adapter; use the version this package pins.`,
				);
			}
		} finally {
			await this.inner.remove(key);
		}
	}

	private token(generation: number): string {
		return `${this.incarnation}:${generation}`;
	}

	/** A read fails closed once the lease is lost: nothing this coordinator would return is trustworthy anymore. */
	private async reading<T>(miss: T, read: () => Promise<T>): Promise<T> {
		if (this.leaseLost) return miss;
		try {
			await this.sync();
			return await read();
		} catch (cause) {
			if (cause instanceof LeaseLost) return miss;
			throw cause;
		}
	}

	/** Runs a script that only reports how it ended. */
	private async status(script: string, input: object): Promise<string> {
		try {
			await this.call(script, input);
			return 'ok';
		} catch (cause) {
			if (cause instanceof ReconciliationCancelled) return 'cancelled';
			throw cause;
		}
	}

	/**
	 * Runs a script and unwraps its reply. A reply of `fenced` means a lease this incarnation relied on is gone,
	 * which ends this coordinator; `cancelled` means newer evidence superseded what the script was asked to do.
	 */
	private async call<T>(script: string, input: object): Promise<T> {
		if (this.leaseLost) throw new LeaseLost();
		const options = {
			keys: [],
			arguments: [
				JSON.stringify({
					cache: this.cachePrefix,
					ns: this.prefix,
					inc: this.incarnation,
					held: [...this.owned.keys()],
					mine: [...this.owned.values()].map(generation => this.token(generation)),
					hide: this.state.awaiting,
					...input,
				}),
			],
		};
		let reply: [status: string, payload: T];
		try {
			reply = (await this.client.evalSha(SCRIPT_SHAS.get(script)!, options)) as never;
		} catch (error) {
			if (!(error instanceof Error) || !error.message.includes('NOSCRIPT')) throw error;
			reply = (await this.client.eval(script, options)) as never;
		}
		if (reply[0] === 'cancelled') throw new ReconciliationCancelled();
		if (reply[0] === 'fenced') {
			this.lost('A shard lease this coordinator held is owned by another coordinator or expired.');
			throw new LeaseLost();
		}
		return reply[1];
	}
}

function assertRedisAdapter(inner: unknown, options: RedisCoordinatorOptions): RedisAdapter {
	if (inner instanceof ExpirableRedisAdapter) {
		throw new TypeError(
			`${PLUGIN_NAME} redisCoordinator does not support ExpirableRedisAdapter: it owns key expiry and an in-process cache that coordinator scripts would bypass. Use memoryCoordinator() with it in a single process, or RedisAdapter for shared coordination.`,
		);
	}
	// A subclass may store entries differently, so being an instance of RedisAdapter is not enough.
	if (!(inner instanceof RedisAdapter) || Object.getPrototypeOf(inner) !== RedisAdapter.prototype) {
		throw new TypeError(
			`${PLUGIN_NAME} redisCoordinator only coordinates the exact RedisAdapter from @slipher/redis-adapter; set it with setServices({ cache: { adapter } }) before client.start().`,
		);
	}
	if (inner.client !== options.client || inner.namespace !== options.cacheNamespace) {
		throw new TypeError(
			`${PLUGIN_NAME} redisCoordinator must be given the client and namespace of the configured RedisAdapter: pass client: adapter.client and cacheNamespace: adapter.namespace.`,
		);
	}
	return inner;
}
