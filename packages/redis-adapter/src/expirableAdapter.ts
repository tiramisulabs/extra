import type { RedisClientOptions, RedisClientType } from '@redis/client';
import type { AdapterRelationship } from 'seyfert/lib/cache';
import { type MakeRequired, MergeOptions } from 'seyfert/lib/common';
import { RedisAdapter, type RedisAdapterOptions, toNormal } from './adapter';

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
	/** Migrates pre-atomic relationship indexes during startup. Run only while cache writers are stopped. */
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

export class ExpirableRedisAdapter extends RedisAdapter<false> {
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
		super(data, false);
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

	override async start() {
		await super.start();
		if (this.migrateLegacyRelationshipsOnStart) await this.migrateLegacyRelationships();
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
			if (entry.expiresAt !== undefined && entry.expiresAt <= now) bucket.delete(key);
			else if (entry.expiresAt !== undefined && (nextExpiry === undefined || entry.expiresAt < nextExpiry)) {
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
		if (bucket.has(normalizedKey)) bucket.delete(normalizedKey);

		const expiresAt = ttl > 0 ? observedAt + ttl : undefined;
		bucket.set(normalizedKey, { expiresAt, value });
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
		if (this.activeMutations.get(normalizedKey) === token) this.activeMutations.delete(normalizedKey);
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

	protected override async readBeforePatch(key: string) {
		return (await this.readHash(this.buildKey(key))).value;
	}

	protected override getExpirationPolicy(key: string) {
		const expire = this.getResourceOptions(key).expire;
		if (expire === undefined) return { type: 'preserve' } as const;
		if (expire > 0) return { type: 'expire', milliseconds: expire } as const;
		return { type: 'persist' } as const;
	}

	private publishMutation(
		key: string,
		mutation: { normalizedKey: string; token: object },
		value: ReturnType<typeof toNormal>,
		ttl: number,
		observedAt: number,
	) {
		this.pendingReads.delete(mutation.normalizedKey);
		if (this.activeMutations.get(mutation.normalizedKey) !== mutation.token) {
			this.deleteCachedValue(key);
			return;
		}
		if (value === undefined) this.deleteCachedValue(key);
		else this.cacheValue(key, value, ttl, observedAt);
	}

	protected override async writeEncodedEntry(
		key: string,
		relationship: AdapterRelationship,
		replace: boolean,
		encoded: { fields: string[]; logicalFields: string[] },
	) {
		const mutation = this.beginMutation(key);
		const cacheLocally = this.getOndemandBucket(key, true) !== undefined;
		try {
			const result = await super.writeEntry(key, relationship, replace, encoded, cacheLocally);
			this.pendingReads.delete(mutation.normalizedKey);
			if (result) this.publishMutation(key, mutation, result.value, result.ttl, result.observedAt);
		} finally {
			this.finishMutation(mutation.normalizedKey, mutation.token);
		}
	}

	private legacyRelationshipFromKey(key: string) {
		const value = key.slice(`${this.namespace}:`.length);
		const separator = value.lastIndexOf('.uset.');
		if (separator === -1) return;
		return { id: value.slice(separator + '.uset.'.length), to: value.slice(0, separator) };
	}

	private isLegacyRelationshipKey(key: string) {
		const value = key.slice(`${this.namespace}:`.length);
		const separator = value.search(/[.:]/);
		const resource = separator === -1 ? value : value.slice(0, separator);
		return Object.hasOwn(CACHE_RESOURCE_NAMES, resource);
	}

	private async resolveLegacyLogicalKey(to: string, id: string) {
		const resource = to.split('.')[0]!;
		const candidates = [...new Set([`${to}.${id}`, `${resource}.${id}`])];
		const exists = await Promise.all(candidates.map(key => this.client.exists(this.buildKey(key))));
		const matches = candidates.filter((_, index) => exists[index] > 0);
		if (matches.length > 1) throw new Error(`Ambiguous legacy relationship ${to}.${id}`);
		return matches[0];
	}

	private async migrateLegacyRelationships() {
		const relationships = new Map<string, AdapterRelationship>();
		const relationshipHashFields = new Map<string, { id: string; key: string }[]>();
		const add = (to: string, id: string) => {
			const identity = JSON.stringify([to, id]);
			relationships.set(identity, [to, id]);
			return identity;
		};

		const sentinelKeys = (await this.scanKeys('*.uset.*', 'string')).filter(key => this.isLegacyRelationshipKey(key));
		for (const key of sentinelKeys) {
			const relationship = this.legacyRelationshipFromKey(key);
			if (relationship) add(relationship.to, relationship.id);
		}

		const setKeys = (await this.scanKeys('*:set', 'set')).filter(key => this.isLegacyRelationshipKey(key));
		for (const key of setKeys) {
			const to = key.slice(`${this.namespace}:`.length, -':set'.length);
			for (const id of await this.client.sMembers(key)) add(to, id);
		}

		const relationshipKeys = (await this.scanKeys('relationships:*', 'hash')).filter(
			key => key !== this.relationshipOwnersKey,
		);
		for (const key of relationshipKeys) {
			const to = key.slice(this.relationshipPrefix.length);
			for (const id of await this.client.hKeys(key)) {
				const identity = add(to, id);
				const fields = relationshipHashFields.get(identity) ?? [];
				fields.push({ id, key });
				relationshipHashFields.set(identity, fields);
			}
		}

		const migrations: { logicalKey: string; relationship: AdapterRelationship }[] = [];
		for (const [to, id] of relationships.values()) {
			const logicalKey = await this.resolveLegacyLogicalKey(to, id);
			if (!logicalKey) continue;
			const relationship = [to, id] as const;
			migrations.push({ logicalKey, relationship });
		}

		const migratedIdentities = new Set<string>();
		for (const { logicalKey, relationship } of migrations) {
			if ((await this.migrateEntry(logicalKey, relationship)) === 1) {
				migratedIdentities.add(JSON.stringify(relationship));
			}
		}
		for (const [identity, fields] of relationshipHashFields) {
			if (migratedIdentities.has(identity)) continue;
			for (const { id, key } of fields) await this.client.hDel(key, id);
		}

		await Promise.all([
			this.deleteRedisKeys(sentinelKeys),
			this.deleteRedisKeys(setKeys),
			this.removeScannedKeys('*:set:indexed', 'string', key => this.isLegacyRelationshipKey(key)),
		]);
	}

	override async get(key: string): Promise<any> {
		const cached = this.getCachedValue(key);
		if (cached !== undefined) return cached;
		if (!this.getOndemandBucket(key, true)) return super.get(key);

		const normalizedKey = this.buildKey(key);
		const token = {};
		this.pendingReads.set(normalizedKey, token);
		try {
			const { observedAt, ttl, value } = await this.readHash(normalizedKey);
			if (value !== undefined && this.pendingReads.get(normalizedKey) === token) {
				this.cacheValue(key, value, ttl, observedAt);
			}
			return value;
		} finally {
			if (this.pendingReads.get(normalizedKey) === token) this.pendingReads.delete(normalizedKey);
		}
	}

	override async bulkGet(keys: string[]) {
		const result = await Promise.all(keys.map(key => this.get(key)));
		return result.filter(value => value !== undefined);
	}

	override async remove(key: string): Promise<void> {
		const mutation = this.beginMutation(key);
		this.deleteCachedValue(key);
		try {
			await super.remove(key);
		} finally {
			this.pendingReads.delete(mutation.normalizedKey);
			this.deleteCachedValue(key);
			this.finishMutation(mutation.normalizedKey, mutation.token);
		}
	}

	override async removeToRelationship(to: string, keys: string | string[]): Promise<void> {
		for (const id of Array.isArray(keys) ? keys : [keys]) {
			const logicalKey = await this.removeRelationshipMember(to, id);
			if (logicalKey === null) continue;
			const mutation = this.beginMutation(logicalKey);
			try {
				this.pendingReads.delete(mutation.normalizedKey);
				this.deleteCachedValue(logicalKey);
			} finally {
				this.finishMutation(mutation.normalizedKey, mutation.token);
			}
		}
	}

	override async removeRelationship(to: string | string[]): Promise<void> {
		this.clearOndemandCache();
		try {
			await super.removeRelationship(to);
		} finally {
			this.clearOndemandCache();
		}
	}

	override async count(to: string): Promise<number> {
		return (await this.client.hKeys(this.relationshipKey(to))).length;
	}

	override async flush(): Promise<void> {
		this.clearOndemandCache();
		await super.flush();
	}
}
