import type { RedisClientOptions, RedisClientType } from '@redis/client';
import { type MakeRequired, MergeOptions } from 'seyfert/lib/common';
import { RedisAdapter, type RedisAdapterOptions, toDb, toNormal } from './adapter';

export interface ResourceLimitedMemoryAdapter {
	/** Redis key lifetime in milliseconds. Positive values refresh the TTL; non-positive values remove it. */
	expire?: number;
	/** Enables the adapter-local read-through and write-through cache for this resource. */
	ondemand?: boolean;
	/** Disables the adapter-local cache so an externally configured node-redis client-side cache can own caching. */
	native?: boolean;
	/** Maximum local entries for this resource. Zero disables local caching; undefined is unlimited. */
	limit?: number;
}

interface ResolvedResourceOptions {
	expire?: number;
	limit: number;
	native: boolean;
	ondemand: boolean;
}

interface CachedValue {
	expiresAt?: number;
	value: any;
}

const REPLACE_HASH_SCRIPT = `
local ttl = -1
if ARGV[1] == 'preserve' then
	ttl = redis.call('PTTL', KEYS[1])
end

redis.call('DEL', KEYS[1])
if #ARGV > 2 then
	redis.call('HSET', KEYS[1], unpack(ARGV, 3))
end

if ARGV[1] == 'expire' then
	redis.call('PEXPIRE', KEYS[1], ARGV[2])
elseif ARGV[1] == 'preserve' and ttl >= 0 then
	redis.call('PEXPIRE', KEYS[1], ttl)
end

return 1
`;

function hashReply(value: unknown): Record<string, any> {
	if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Error) {
		throw new TypeError('ExpirableRedisAdapter expected HGETALL to return an object');
	}
	return value as Record<string, any>;
}

function integerReply(command: string, value: unknown): number {
	if (typeof value !== 'number') {
		throw new TypeError(`ExpirableRedisAdapter expected ${command} to return a number`);
	}
	return value;
}

type ExpirationPolicy = { type: 'preserve' } | { type: 'expire'; milliseconds: number } | { type: 'persist' };

function resolveExpirationPolicy(expire?: number): ExpirationPolicy {
	if (expire === undefined) return { type: 'preserve' };
	if (expire > 0) return { type: 'expire', milliseconds: expire };
	return { type: 'persist' };
}

export interface ExpirableRedisAdapterOptions {
	/** Migrates relationship keys created by older adapter releases during startup. Disabled by default. */
	migrateLegacyRelationships?: boolean;

	default?: ResourceLimitedMemoryAdapter;

	guild?: ResourceLimitedMemoryAdapter;
	user?: ResourceLimitedMemoryAdapter;

	ban?: ResourceLimitedMemoryAdapter;
	member?: ResourceLimitedMemoryAdapter;
	voice_state?: ResourceLimitedMemoryAdapter;

	channel?: ResourceLimitedMemoryAdapter;
	emoji?: ResourceLimitedMemoryAdapter;
	presence?: ResourceLimitedMemoryAdapter;
	role?: ResourceLimitedMemoryAdapter;
	stage_instance?: ResourceLimitedMemoryAdapter;
	sticker?: ResourceLimitedMemoryAdapter;
	overwrite?: ResourceLimitedMemoryAdapter;
	message?: ResourceLimitedMemoryAdapter;
}

type ExpirableResourceOptions = Omit<ExpirableRedisAdapterOptions, 'migrateLegacyRelationships'>;

// Legacy relationship keys had no internal prefix, so cleanup is restricted to Seyfert cache resources.
const CACHE_RESOURCE_NAMES = {
	ban: true,
	channel: true,
	emoji: true,
	guild: true,
	member: true,
	message: true,
	overwrite: true,
	presence: true,
	role: true,
	stage_instance: true,
	sticker: true,
	user: true,
	voice_state: true,
} as const satisfies Record<Exclude<keyof ExpirableResourceOptions, 'default'>, true>;

export class ExpirableRedisAdapter extends RedisAdapter {
	options: MakeRequired<ExpirableResourceOptions, 'default'>;
	protected readonly ondemandCache = new Map<string, Map<string, CachedValue>>();
	private readonly ondemandNextExpiry = new WeakMap<Map<string, CachedValue>, number>();
	private readonly activeMutations = new Map<string, object>();
	private readonly migrateLegacyRelationshipsOnStart: boolean;
	private readonly pendingReads = new Map<string, object>();

	constructor(
		data: ({ client: RedisClientType } | { redisOptions: RedisClientOptions }) & RedisAdapterOptions = {
			redisOptions: {},
		},
		options: ExpirableRedisAdapterOptions = {},
	) {
		super(data);
		const { migrateLegacyRelationships = false, ...resourceOptions } = options;
		this.migrateLegacyRelationshipsOnStart = migrateLegacyRelationships;
		this.options = MergeOptions(
			{
				default: {
					expire: undefined,
					ondemand: false,
					native: false,
				},
			} satisfies ExpirableResourceOptions,
			resourceOptions,
		);
		this.validateOptions();
	}

	async start() {
		await super.start();
		if (this.migrateLegacyRelationshipsOnStart) {
			await this.migrateLegacyRelationships();
		}
	}

	protected resolveCacheType(key: string): keyof ExpirableResourceOptions {
		const namespace = `${this.namespace}:`;
		const normalized = key.startsWith(namespace) ? key.slice(namespace.length) : key;
		const cacheType = normalized.split('.')[0];
		return Object.hasOwn(this.options, cacheType) ? (cacheType as keyof ExpirableResourceOptions) : 'default';
	}

	protected getResourceOptions(key: string): ResolvedResourceOptions {
		const cacheType = this.resolveCacheType(key);
		const resource = cacheType === 'default' ? undefined : this.options[cacheType];
		return {
			expire: resource?.expire ?? this.options.default.expire,
			limit: resource?.limit ?? this.options.default.limit ?? Number.POSITIVE_INFINITY,
			native: resource?.native ?? this.options.default.native ?? false,
			ondemand: resource?.ondemand ?? this.options.default.ondemand ?? false,
		};
	}

	protected getOndemandBucket(key: string, create = false) {
		const options = this.getResourceOptions(key);
		if (!options.ondemand || options.native || options.limit === 0) return;

		const cacheType = this.resolveCacheType(key);
		let bucket = this.ondemandCache.get(cacheType);

		if (!bucket && create) {
			bucket = new Map<string, CachedValue>();
			this.ondemandCache.set(cacheType, bucket);
		}
		if (bucket) this.pruneOndemandBucket(bucket);

		return bucket;
	}

	private pruneOndemandBucket(bucket: Map<string, CachedValue>, now = Date.now()) {
		const currentExpiry = this.ondemandNextExpiry.get(bucket);
		if (currentExpiry === undefined || currentExpiry > now) return;

		let nextExpiry: number | undefined;
		for (const [key, entry] of bucket) {
			if (entry.expiresAt !== undefined && entry.expiresAt <= now) {
				bucket.delete(key);
			} else if (entry.expiresAt !== undefined && (nextExpiry === undefined || entry.expiresAt < nextExpiry)) {
				nextExpiry = entry.expiresAt;
			}
		}
		if (nextExpiry === undefined) this.ondemandNextExpiry.delete(bucket);
		else this.ondemandNextExpiry.set(bucket, nextExpiry);
	}

	protected getCachedValue(key: string) {
		const bucket = this.getOndemandBucket(key);
		const normalizedKey = this.buildKey(key);
		const entry = bucket?.get(normalizedKey);

		if (!bucket || !entry) return;

		// Refresh insertion order so the bucket behaves like an LRU cache.
		bucket.delete(normalizedKey);
		bucket.set(normalizedKey, entry);

		return entry.value;
	}

	protected cacheValue(key: string, value: any, ttl: number, observedAt = Date.now()) {
		if (ttl === 0 || ttl === -2) {
			this.deleteCachedValue(key);
			return;
		}

		const bucket = this.getOndemandBucket(key, true);
		if (!bucket) return;

		const normalizedKey = this.buildKey(key);
		if (bucket.has(normalizedKey)) {
			bucket.delete(normalizedKey);
		}

		const expiresAt = ttl > 0 ? observedAt + ttl : undefined;
		bucket.set(normalizedKey, {
			expiresAt,
			value,
		});
		const nextExpiry = this.ondemandNextExpiry.get(bucket);
		if (expiresAt !== undefined && (nextExpiry === undefined || expiresAt < nextExpiry)) {
			this.ondemandNextExpiry.set(bucket, expiresAt);
		}

		const limit = this.getResourceOptions(key).limit;
		if (Number.isFinite(limit)) {
			while (bucket.size > limit) {
				const oldestKey = bucket.keys().next().value as string | undefined;
				if (!oldestKey) break;
				bucket.delete(oldestKey);
			}
		}
	}

	protected deleteCachedValue(key: string) {
		this.getOndemandBucket(key)?.delete(this.buildKey(key));
	}

	protected clearOndemandCache() {
		this.ondemandCache.clear();
		this.activeMutations.clear();
		this.pendingReads.clear();
	}

	private beginMutation(key: string) {
		const normalizedKey = this.buildKey(key);
		const token = {};
		this.activeMutations.set(normalizedKey, token);
		this.pendingReads.delete(normalizedKey);
		return { normalizedKey, token };
	}

	private finishMutation(normalizedKey: string, token: object) {
		if (this.activeMutations.get(normalizedKey) === token) {
			this.activeMutations.delete(normalizedKey);
		}
	}

	private validateOptions() {
		for (const [resource, options] of Object.entries(this.options)) {
			if (options.expire !== undefined && !Number.isSafeInteger(options.expire)) {
				throw new RangeError(`ExpirableRedisAdapter ${resource}.expire must be a safe integer in milliseconds`);
			}
			if (
				options.limit !== undefined &&
				options.limit !== Number.POSITIVE_INFINITY &&
				(!Number.isSafeInteger(options.limit) || options.limit < 0)
			) {
				throw new RangeError(`ExpirableRedisAdapter ${resource}.limit must be a non-negative safe integer`);
			}
		}
	}

	private async readHash(key: string) {
		const observedAt = Date.now();
		const [raw, ttl] = await this.client.multi().hGetAll(key).pTTL(key).exec();
		return {
			observedAt,
			ttl: integerReply('PTTL', ttl),
			value: toNormal(hashReply(raw)),
		};
	}

	private async replaceHash(id: string, data: any) {
		const expiration = resolveExpirationPolicy(this.getResourceOptions(id).expire);
		const fields = Object.entries(toDb(data)).flatMap(([field, value]) => [field, value]);
		await this.client.eval(REPLACE_HASH_SCRIPT, {
			arguments: [expiration.type, expiration.type === 'expire' ? expiration.milliseconds.toString() : '', ...fields],
			keys: [this.buildKey(id)],
		});
	}

	private publishMutation(
		id: string,
		mutation: { normalizedKey: string; token: object },
		value: ReturnType<typeof toNormal>,
		ttl: number,
		observedAt: number,
	) {
		this.pendingReads.delete(mutation.normalizedKey);
		if (this.activeMutations.get(mutation.normalizedKey) !== mutation.token) {
			this.deleteCachedValue(id);
			return;
		}

		if (value === undefined) this.deleteCachedValue(id);
		else this.cacheValue(id, value, ttl, observedAt);
	}

	private async writeHash(id: string, data: any, replace: boolean) {
		const mutation = this.beginMutation(id);
		const cacheLocally = this.getOndemandBucket(id, true) !== undefined;

		try {
			if (replace) {
				await this.replaceHash(id, data);
				this.pendingReads.delete(mutation.normalizedKey);
				if (!cacheLocally) return;

				const { observedAt, ttl, value } = await this.readHash(this.buildKey(id));
				this.publishMutation(id, mutation, value, ttl, observedAt);
				return;
			}

			const key = this.buildKey(id);
			const expiration = resolveExpirationPolicy(this.getResourceOptions(id).expire);
			const transaction = this.client.multi().hSet(key, toDb(data));
			const observedAt = Date.now();

			switch (expiration.type) {
				case 'expire':
					transaction.pExpire(key, expiration.milliseconds);
					break;
				case 'persist':
					transaction.persist(key);
					break;
				case 'preserve':
					break;
			}
			if (cacheLocally) transaction.hGetAll(key).pTTL(key);

			const results = await transaction.exec();
			this.pendingReads.delete(mutation.normalizedKey);
			if (!cacheLocally) return;

			this.publishMutation(
				id,
				mutation,
				toNormal(hashReply(results.at(-2))),
				integerReply('PTTL', results.at(-1)),
				observedAt,
			);
		} finally {
			this.finishMutation(mutation.normalizedKey, mutation.token);
		}
	}

	private relationshipKey(to: string) {
		const namespace = `${this.namespace}:`;
		return `${namespace}relationships:${to.startsWith(namespace) ? to.slice(namespace.length) : to}`;
	}

	private legacyRelationshipFromKey(key: string) {
		const value = key.slice(`${this.namespace}:`.length);
		const separator = value.lastIndexOf('.uset.');
		if (separator === -1) return;
		return {
			id: value.slice(separator + '.uset.'.length),
			to: value.slice(0, separator),
		};
	}

	private isLegacyRelationshipKey(key: string) {
		const value = key.slice(`${this.namespace}:`.length);
		const separator = value.search(/[.:]/);
		const resource = separator === -1 ? value : value.slice(0, separator);
		return Object.hasOwn(CACHE_RESOURCE_NAMES, resource);
	}

	private async migrateLegacyRelationships() {
		let migrated: number;
		do {
			migrated = 0;
			for await (const batch of this.scanKeyBatches('*.uset.*', 'string')) {
				const sentinelKeys = batch.filter(key => this.isLegacyRelationshipKey(key));
				if (!sentinelKeys.length) continue;

				await this.runInBatches(sentinelKeys, keys =>
					Promise.all(
						keys.map(async key => {
							const relationship = this.legacyRelationshipFromKey(key);
							if (!relationship) return;

							const expiresAt = await this.client.pExpireTime(key);
							if (expiresAt === -2 || (expiresAt >= 0 && expiresAt <= Date.now())) return;

							const fields = new Map([[relationship.id, '1']]);
							if (expiresAt === -1) {
								await this.client.hSetEx(this.relationshipKey(relationship.to), fields, { mode: 'FNX' });
							} else {
								await this.client.hSetEx(this.relationshipKey(relationship.to), fields, {
									expiration: { type: 'PXAT', value: expiresAt },
									mode: 'FNX',
								});
							}
						}),
					),
				);
				await this.deleteRedisKeys(sentinelKeys);
				migrated += sentinelKeys.length;
			}
		} while (migrated > 0);

		await Promise.all([
			this.removeScannedKeys('*:set', 'set', key => this.isLegacyRelationshipKey(key)),
			this.removeScannedKeys('*:set:indexed', 'string', key => this.isLegacyRelationshipKey(key)),
		]);
	}

	async scan(query: string, returnKeys?: false): Promise<any[]>;
	async scan(query: string, returnKeys: true): Promise<string[]>;
	async scan(query: string, returnKeys = false) {
		const relationshipPrefix = `${this.namespace}:relationships:`;
		const keys = (await this.scanKeys(query, 'hash')).filter(key => !key.startsWith(relationshipPrefix));
		return returnKeys ? keys : this.bulkGet(keys);
	}

	getToRelationship(to: string): Promise<string[]> {
		return this.client.hKeys(this.relationshipKey(to));
	}

	async bulkAddToRelationShip(data: Record<string, string[]>): Promise<void> {
		await this.runInBatches(
			Object.entries(data).filter(([, values]) => values.length),
			batch =>
				Promise.all(
					batch.map(async ([to, values]) => {
						const fields = new Map(values.map(value => [value, '1']));
						const expiration = resolveExpirationPolicy(this.getResourceOptions(to).expire);

						switch (expiration.type) {
							case 'preserve':
								await this.client.hSetEx(this.relationshipKey(to), fields, { expiration: 'KEEPTTL' });
								break;
							case 'expire':
								await this.client.hSetEx(this.relationshipKey(to), fields, {
									expiration: { type: 'PX', value: expiration.milliseconds },
								});
								break;
							case 'persist':
								await this.client.hSetEx(this.relationshipKey(to), fields);
								break;
						}
					}),
				),
		);
	}

	async addToRelationship(to: string, keys: string | string[]): Promise<void> {
		await this.bulkAddToRelationShip({
			[to]: Array.isArray(keys) ? keys : [keys],
		});
	}

	async removeToRelationship(to: string, keys: string | string[]): Promise<void> {
		const relationshipIds = Array.isArray(keys) ? keys : [keys];
		if (!relationshipIds.length) return;
		await this.client.hDel(this.relationshipKey(to), relationshipIds);
	}

	async removeRelationship(to: string | string[]): Promise<void> {
		const exactRelationships: string[] = [];
		for (const relationship of Array.isArray(to) ? to : [to]) {
			if (relationship.includes('*')) {
				await this.removeScannedKeys(this.relationshipKey(relationship), 'hash');
			} else {
				exactRelationships.push(relationship);
			}
		}

		await this.runInBatches(exactRelationships, batch =>
			this.client.del(batch.map(relationship => this.relationshipKey(relationship))),
		);
	}

	async count(to: string): Promise<number> {
		// Redis 8.0 HLEN can include lazily expired fields; HKEYS keeps count aligned with list and membership reads.
		return (await this.client.hKeys(this.relationshipKey(to))).length;
	}

	async contains(to: string, key: string): Promise<boolean> {
		return (await this.client.hExists(this.relationshipKey(to), key)) > 0;
	}

	async flush(): Promise<void> {
		this.clearOndemandCache();
		await this.removeScannedKeys('*', 'hash');
	}

	async bulkSet(data: [string, any][]) {
		await this.runInBatches(data, batch => Promise.all(batch.map(([key, value]) => this.set(key, value))));
	}

	async set(id: string, data: any) {
		await this.writeHash(id, data, true);
	}

	async get(keys: string): Promise<any> {
		const cached = this.getCachedValue(keys);
		if (cached !== undefined) {
			return cached;
		}

		if (!this.getOndemandBucket(keys, true)) return super.get(keys);

		const normalizedKey = this.buildKey(keys);
		const token = {};
		this.pendingReads.set(normalizedKey, token);

		try {
			const { observedAt, ttl, value } = await this.readHash(normalizedKey);
			if (value !== undefined && this.pendingReads.get(normalizedKey) === token) {
				this.cacheValue(keys, value, ttl, observedAt);
			}
			return value;
		} finally {
			if (this.pendingReads.get(normalizedKey) === token) {
				this.pendingReads.delete(normalizedKey);
			}
		}
	}

	async bulkGet(keys: string[]) {
		const result = await Promise.all(keys.map(key => this.get(key)));
		return result.filter(x => x !== undefined);
	}

	async patch(id: string, data: any): Promise<void> {
		await this.writeHash(id, data, Array.isArray(data));
	}

	async remove(keys: string): Promise<void> {
		const mutation = this.beginMutation(keys);
		this.deleteCachedValue(keys);
		try {
			await super.remove(keys);
		} finally {
			this.pendingReads.delete(mutation.normalizedKey);
			this.deleteCachedValue(keys);
			this.finishMutation(mutation.normalizedKey, mutation.token);
		}
	}

	async bulkRemove(keys: string[]) {
		await this.runInBatches(keys, async batch => {
			const mutations = batch.map(key => [key, this.beginMutation(key)] as const);
			for (const key of batch) {
				this.deleteCachedValue(key);
			}
			try {
				await super.bulkRemove(batch);
			} finally {
				for (const [key, mutation] of mutations) {
					this.pendingReads.delete(mutation.normalizedKey);
					this.deleteCachedValue(key);
					this.finishMutation(mutation.normalizedKey, mutation.token);
				}
			}
		});
	}
}
