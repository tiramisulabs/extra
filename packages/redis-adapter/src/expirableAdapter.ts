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

export interface ExpirableRedisAdapterOptions {
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

export class ExpirableRedisAdapter extends RedisAdapter {
	options: MakeRequired<ExpirableRedisAdapterOptions, 'default'>;
	protected readonly ondemandCache = new Map<string, Map<string, CachedValue>>();

	constructor(
		data: ({ client: RedisClientType } | { redisOptions: RedisClientOptions }) & RedisAdapterOptions = {
			redisOptions: {},
		},
		options: ExpirableRedisAdapterOptions = {},
	) {
		super(data);
		this.options = MergeOptions(
			{
				default: {
					expire: undefined,
					ondemand: false,
					native: false,
				},
			} satisfies ExpirableRedisAdapterOptions,
			options,
		);
		this.validateOptions();
	}

	protected resolveCacheType(key: string): keyof ExpirableRedisAdapterOptions {
		const namespace = `${this.namespace}:`;
		const normalized = key.startsWith(namespace) ? key.slice(namespace.length) : key;
		const cacheType = normalized.split('.')[0];
		return Object.hasOwn(this.options, cacheType) ? (cacheType as keyof ExpirableRedisAdapterOptions) : 'default';
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

		return bucket;
	}

	protected getCachedValue(key: string) {
		const bucket = this.getOndemandBucket(key);
		const normalizedKey = this.buildKey(key);
		const entry = bucket?.get(normalizedKey);

		if (!bucket || !entry) return;
		if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
			bucket.delete(normalizedKey);
			return;
		}

		// Refresh insertion order so the bucket behaves like an LRU cache.
		if (bucket) {
			bucket.delete(normalizedKey);
			bucket.set(normalizedKey, entry);
		}

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

		bucket.set(normalizedKey, {
			expiresAt: ttl > 0 ? observedAt + ttl : undefined,
			value,
		});

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

	private async writeHash(id: string, data: any) {
		const key = this.buildKey(id);
		const expire = this.getResourceOptions(id).expire;
		const cacheLocally = this.getOndemandBucket(id, true) !== undefined;
		const transaction = this.client.multi().hSet(key, toDb(data));
		const observedAt = Date.now();

		if (expire !== undefined) {
			if (expire > 0) transaction.pExpire(key, expire);
			else transaction.persist(key);
		}

		if (cacheLocally) transaction.hGetAll(key).pTTL(key);
		const results = await transaction.exec();
		if (!cacheLocally) return;

		const value = toNormal(hashReply(results.at(-2)));
		const ttl = integerReply('PTTL', results.at(-1));

		if (value === undefined) this.deleteCachedValue(id);
		else this.cacheValue(id, value, ttl, observedAt);
	}

	async __scanString(query: string, returnKeys?: false): Promise<any[]>;
	async __scanString(query: string, returnKeys: true): Promise<string[]>;
	async __scanString(query: string, returnKeys = false) {
		const match = this.buildKey(query);
		const keys: any[] = [];

		for await (const i of this.client.scanIterator({
			MATCH: match,
			TYPE: 'string',
		})) {
			keys.push(...i);
		}

		return returnKeys ? keys.map(x => this.buildKey(x)) : this.bulkGet(keys);
	}

	async getToRelationship(to: string): Promise<string[]> {
		const keys = await this.__scanString(`${to}.uset.*`, true);
		return keys.map(x => x.replace(`${this.namespace}:${to}.uset.`, ''));
	}

	async bulkAddToRelationShip(data: Record<string, string[]>): Promise<void> {
		const promises: Promise<unknown>[] = [];

		for (const [key, values] of Object.entries(data)) {
			const expire = this.getResourceOptions(key).expire;
			for (const value of values) {
				const relationshipKey = `${this.buildKey(key)}.uset.${value}`;
				promises.push(
					expire !== undefined && expire > 0
						? this.client.set(relationshipKey, 's', { PX: expire })
						: this.client.set(relationshipKey, 's'),
				);
			}
		}

		await Promise.all(promises);
	}

	async addToRelationship(to: string, keys: string | string[]): Promise<void> {
		await this.bulkAddToRelationShip({
			[to]: Array.isArray(keys) ? keys : [keys],
		});
	}

	async removeToRelationship(to: string, keys: string | string[]): Promise<void> {
		const promises: Promise<unknown>[] = [];

		for (const i of Array.isArray(keys) ? keys : [keys]) {
			promises.push(this.client.del(`${this.buildKey(to)}.uset.${i}`));
		}

		await Promise.all(promises);
	}

	async removeRelationship(to: string | string[]): Promise<void> {
		const promisesScan: Promise<string[]>[] = [];

		for (const i of Array.isArray(to) ? to : [to]) {
			promisesScan.push(this.__scanString(`${this.buildKey(i)}.uset.*`, true));
		}

		if (promisesScan.length) {
			const keys = (await Promise.all(promisesScan)).flat();
			if (keys.length) {
				await this.client.del(keys);
			}
		}
	}

	async count(to: string): Promise<number> {
		return (await this.keys(to)).length;
	}

	async contains(to: string, key: string): Promise<boolean> {
		return (await this.client.exists(`${this.buildKey(to)}.uset.${key}`)) > 0;
	}

	async flush(): Promise<void> {
		this.clearOndemandCache();
		const keys = await Promise.all([
			this.scan(this.buildKey('*'), true),
			this.__scanString(this.buildKey('*'), true),
		]).then(x => x.flat());
		if (!keys.length) return;
		await this.bulkRemove(keys);
	}

	async bulkSet(data: [string, any][]) {
		const promises: Promise<any>[] = [];

		for (const [k, v] of data) {
			promises.push(this.set(this.buildKey(k), v));
		}

		await Promise.all(promises);
	}

	async set(id: string, data: any) {
		await this.writeHash(id, data);
	}

	async get(keys: string): Promise<any> {
		const cached = this.getCachedValue(keys);
		if (cached !== undefined) {
			return cached;
		}

		if (!this.getOndemandBucket(keys, true)) return super.get(keys);

		const { observedAt, ttl, value } = await this.readHash(this.buildKey(keys));
		if (value !== undefined) {
			this.cacheValue(keys, value, ttl, observedAt);
		}
		return value;
	}

	async bulkGet(keys: string[]) {
		const result = await Promise.all(keys.map(key => this.get(key)));
		return result.filter(x => x !== undefined);
	}

	async patch(id: string, data: any): Promise<void> {
		await this.writeHash(id, data);
	}

	async remove(keys: string): Promise<void> {
		this.deleteCachedValue(keys);
		try {
			await super.remove(keys);
		} finally {
			this.deleteCachedValue(keys);
		}
	}

	async bulkRemove(keys: string[]) {
		for (const key of keys) {
			this.deleteCachedValue(key);
		}
		try {
			await super.bulkRemove(keys);
		} finally {
			for (const key of keys) {
				this.deleteCachedValue(key);
			}
		}
	}
}
