import type { createClient, RedisClientOptions } from '@redis/client';
import { type MakeRequired, MergeOptions } from 'seyfert/lib/common';
import { RedisAdapter, type RedisAdapterOptions, toDb } from './adapter';

export interface ResourceLimitedMemoryAdapter {
	/** Expiration time for Redis keys in milliseconds. */
	expire?: number;
	/** Keeps fetched entries in a local in-memory cache for this resource. */
	ondemand?: boolean;
	/** Skips the local on-demand cache and relies on Redis/client-native caching instead. */
	native?: boolean;
	/** Maximum number of keys kept in the local on-demand cache for this resource. */
	limit?: number;
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
	protected readonly ondemandCache = new Map<string, Map<string, any>>();

	constructor(
		data: ({ client: ReturnType<typeof createClient> } | { redisOptions: RedisClientOptions }) & RedisAdapterOptions = {
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
	}

	protected resolveCacheType(key: string): keyof ExpirableRedisAdapterOptions {
		const normalized = key.startsWith(`${this.namespace}:`) ? key.slice(this.namespace.length + 1) : key;
		const cacheType = normalized.split('.')[0] as keyof ExpirableRedisAdapterOptions;
		return cacheType in this.options ? cacheType : 'default';
	}

	protected getResourceOptions(key: string) {
		const cacheType = this.resolveCacheType(key);
		return this.options[cacheType] ?? this.options.default;
	}

	protected getOndemandBucket(key: string, create = false) {
		const options = this.getResourceOptions(key);
		if (!options.ondemand || options.native) return;

		const cacheType = this.resolveCacheType(key);
		let bucket = this.ondemandCache.get(cacheType);

		if (!bucket && create) {
			bucket = new Map<string, any>();
			this.ondemandCache.set(cacheType, bucket);
		}

		return bucket;
	}

	protected getCachedValue(key: string) {
		const bucket = this.getOndemandBucket(key);
		const normalizedKey = this.buildKey(key);
		const value = bucket?.get(normalizedKey);

		// Refresh insertion order so the map behaves like an LRU cache.
		if (bucket && value !== undefined) {
			bucket.delete(normalizedKey);
			bucket.set(normalizedKey, value);
		}

		return value;
	}

	protected cacheValue(key: string, value: any) {
		const bucket = this.getOndemandBucket(key, true);
		if (!bucket) return;

		const normalizedKey = this.buildKey(key);
		if (bucket.has(normalizedKey)) {
			bucket.delete(normalizedKey);
		}

		bucket.set(normalizedKey, value);

		const limit = this.getResourceOptions(key).limit;
		if (limit && limit > 0) {
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

		for (const [key, value] of Object.entries(data)) {
			const cacheType = key.split('.')[0] as keyof ExpirableRedisAdapterOptions;
			const expire = this.options[cacheType]?.expire ?? this.options.default.expire!;
			if (expire > 0) {
				promises.push(this.client.set(`${this.buildKey(key)}.uset.${value}`, 's', { PX: expire }));
			} else {
				promises.push(this.client.set(`${this.buildKey(key)}.uset.${value}`, 's'));
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
			promisesScan.push(this.scan(`${this.buildKey(i)}.uset.*`));
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
		const promises: Promise<unknown>[] = [];
		promises.push(this.client.hSet(this.buildKey(id), toDb(data)));
		this.cacheValue(id, data);

		const expire = this.getResourceOptions(id).expire ?? this.options.default.expire!;
		if (expire > 0) {
			promises.push(this.client.pExpire(this.buildKey(id), expire));
		}

		await Promise.all(promises);
	}

	async get(keys: string): Promise<any> {
		const cached = this.getCachedValue(keys);
		if (cached !== undefined) {
			return cached;
		}

		const value = await super.get(keys);
		if (value !== undefined) {
			this.cacheValue(keys, value);
		}
		return value;
	}

	async bulkGet(keys: string[]) {
		const result = await Promise.all(keys.map(key => this.get(key)));
		return result.filter(x => x !== undefined);
	}

	async patch(id: string, data: any): Promise<void> {
		const promises: Promise<unknown>[] = [this.client.hSet(this.buildKey(id), toDb(data))];

		const oldValue = this.getCachedValue(id);
		if (oldValue !== undefined && !Array.isArray(oldValue) && !Array.isArray(data)) {
			this.cacheValue(id, { ...oldValue, ...data });
		} else {
			this.deleteCachedValue(id);
		}

		const expire = this.getResourceOptions(id).expire ?? this.options.default.expire!;
		if (expire > 0) {
			promises.push(this.client.pExpire(this.buildKey(id), expire));
		}

		await Promise.all(promises);
	}

	async remove(keys: string): Promise<void> {
		this.deleteCachedValue(keys);
		await super.remove(keys);
	}

	async bulkRemove(keys: string[]) {
		for (const key of keys) {
			this.deleteCachedValue(key);
		}
		await super.bulkRemove(keys);
	}
}
