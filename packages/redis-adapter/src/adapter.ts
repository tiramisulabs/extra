import { createHash } from 'node:crypto';
import { createClient, type RedisClientOptions, type RedisClientType } from '@redis/client';
import type { Adapter, AdapterEntry, AdapterRelationship } from 'seyfert/lib/cache';

const BULK_BATCH_SIZE = 100;
const RELATIONSHIP_PREFIX = 'relationships:';
const RELATIONSHIP_OWNERS = `${RELATIONSHIP_PREFIX}owners`;
const EMPTY_OBJECT_FIELD = '\0';

const SCRIPT_HELPERS = `
local function type_name(key)
	local reply = redis.call('TYPE', key)
	if type(reply) == 'table' then return reply.ok end
	return reply
end

local function assert_hash_or_none(key)
	local keyType = type_name(key)
	if keyType ~= 'none' and keyType ~= 'hash' then
		error('WRONGTYPE expected hash or none for ' .. key)
	end
end

local function parse_owner(owner)
	if not owner then return nil, nil end
	local to, id = string.match(owner, '^(.*)%.([^%.]+)$')
	if not to or not id then error('ERR invalid cache relationship owner') end
	return to, id
end

local function hset_with_expiry(key, field, value, expiresAt)
	if expiresAt >= 0 then
		redis.call('HSETEX', key, 'PXAT', tostring(expiresAt), 'FIELDS', 1, field, value)
	else
		redis.call('HSETEX', key, 'FIELDS', 1, field, value)
	end
end
`;

const WRITE_ENTRY_SCRIPT = `${SCRIPT_HELPERS}
local logicalKey = ARGV[1]
local relationshipTo = ARGV[2]
local relationshipId = ARGV[3]
local operation = ARGV[4]
local expirationMode = ARGV[5]
local expirationMs = tonumber(ARGV[6])
local fieldCount = tonumber(ARGV[7])
local logicalFieldCount = tonumber(ARGV[8])
local relationshipPrefix = string.sub(KEYS[3], 1, string.len(KEYS[3]) - string.len('owners'))

assert_hash_or_none(KEYS[1])
assert_hash_or_none(KEYS[2])
assert_hash_or_none(KEYS[3])

local oldOwner = redis.call('HGET', KEYS[3], logicalKey)
local oldTo, oldId = parse_owner(oldOwner)
local oldRelationshipKey = nil
if oldTo then
	oldRelationshipKey = relationshipPrefix .. oldTo
	assert_hash_or_none(oldRelationshipKey)
end

local expiresAt = -1
if expirationMode == 'preserve' then
	expiresAt = redis.call('PEXPIRETIME', KEYS[1])
elseif expirationMode == 'expire' then
	local time = redis.call('TIME')
	expiresAt = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000) + expirationMs
end
if expiresAt > 70368744177663 then error('ERR cache expiry exceeds Redis hash-field deadline limit') end

if operation == 'replace' then
	redis.call('DEL', KEYS[1])
else
	local logicalFieldsOffset = 8 + fieldCount * 2
	for index = 1, logicalFieldCount do
		local field = ARGV[logicalFieldsOffset + index]
		redis.call('HDEL', KEYS[1], field, 'B_' .. field, 'N_' .. field, 'O_' .. field)
	end
end
local command = {'HSET', KEYS[1]}
for index = 1, fieldCount * 2 do table.insert(command, ARGV[8 + index]) end
redis.call(unpack(command))

if expiresAt >= 0 then redis.call('PEXPIREAT', KEYS[1], expiresAt)
else redis.call('PERSIST', KEYS[1]) end

local newOwner = relationshipTo .. '.' .. relationshipId
if oldRelationshipKey and oldOwner ~= newOwner then redis.call('HDEL', oldRelationshipKey, oldId) end
hset_with_expiry(KEYS[2], relationshipId, logicalKey, expiresAt)
hset_with_expiry(KEYS[3], logicalKey, newOwner, expiresAt)

if ARGV[9 + fieldCount * 2 + logicalFieldCount] == '1' then
	return {redis.call('HGETALL', KEYS[1]), redis.call('PTTL', KEYS[1])}
end
return 1
`;

const REMOVE_ENTRY_SCRIPT = `${SCRIPT_HELPERS}
local logicalKey = ARGV[1]
local relationshipPrefix = string.sub(KEYS[2], 1, string.len(KEYS[2]) - string.len('owners'))

assert_hash_or_none(KEYS[1])
assert_hash_or_none(KEYS[2])

local owner = redis.call('HGET', KEYS[2], logicalKey)
local to, id = parse_owner(owner)
local relationshipKey = nil
if to then
	relationshipKey = relationshipPrefix .. to
	assert_hash_or_none(relationshipKey)
end

redis.call('DEL', KEYS[1])
if relationshipKey then redis.call('HDEL', relationshipKey, id) end
redis.call('HDEL', KEYS[2], logicalKey)
return 1
`;

const REMOVE_RELATIONSHIP_MEMBER_SCRIPT = `${SCRIPT_HELPERS}
local relationshipTo = ARGV[1]
local relationshipId = ARGV[2]
local valuePrefix = ARGV[3]

assert_hash_or_none(KEYS[1])
assert_hash_or_none(KEYS[2])

local logicalKey = redis.call('HGET', KEYS[1], relationshipId)
if not logicalKey then return false end
local expectedOwner = relationshipTo .. '.' .. relationshipId
local owner = redis.call('HGET', KEYS[2], logicalKey)
if owner == expectedOwner then
	local valueKey = valuePrefix .. logicalKey
	assert_hash_or_none(valueKey)
	redis.call('DEL', valueKey)
	redis.call('HDEL', KEYS[2], logicalKey)
	redis.call('HDEL', KEYS[1], relationshipId)
	return logicalKey
end
redis.call('HDEL', KEYS[1], relationshipId)
return false
`;

const REMOVE_RELATIONSHIP_SCRIPT = `${SCRIPT_HELPERS}
local relationshipTo = ARGV[1]
local valuePrefix = ARGV[2]

assert_hash_or_none(KEYS[1])
assert_hash_or_none(KEYS[2])

local entries = redis.call('HGETALL', KEYS[1])
for index = 1, #entries, 2 do
	local id = entries[index]
	local logicalKey = entries[index + 1]
	local expectedOwner = relationshipTo .. '.' .. id
	if redis.call('HGET', KEYS[2], logicalKey) == expectedOwner then
		assert_hash_or_none(valuePrefix .. logicalKey)
	end
end

for index = 1, #entries, 2 do
	local id = entries[index]
	local logicalKey = entries[index + 1]
	local expectedOwner = relationshipTo .. '.' .. id
	if redis.call('HGET', KEYS[2], logicalKey) == expectedOwner then
		redis.call('DEL', valuePrefix .. logicalKey)
		redis.call('HDEL', KEYS[2], logicalKey)
	end
end
redis.call('DEL', KEYS[1])
return #entries / 2
`;

const MIGRATE_ENTRY_SCRIPT = `${SCRIPT_HELPERS}
local logicalKey = ARGV[1]
local relationshipTo = ARGV[2]
local relationshipId = ARGV[3]

assert_hash_or_none(KEYS[1])
assert_hash_or_none(KEYS[2])
assert_hash_or_none(KEYS[3])
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end

local owner = redis.call('HGET', KEYS[3], logicalKey)
if owner and owner ~= relationshipTo .. '.' .. relationshipId then
	error('ERR conflicting cache relationship owner for ' .. logicalKey)
end

local expiresAt = redis.call('PEXPIRETIME', KEYS[1])
hset_with_expiry(KEYS[2], relationshipId, logicalKey, expiresAt)
hset_with_expiry(KEYS[3], logicalKey, relationshipTo .. '.' .. relationshipId, expiresAt)
return 1
`;

const CACHE_SCRIPTS = [
	WRITE_ENTRY_SCRIPT,
	REMOVE_ENTRY_SCRIPT,
	REMOVE_RELATIONSHIP_MEMBER_SCRIPT,
	REMOVE_RELATIONSHIP_SCRIPT,
	MIGRATE_ENTRY_SCRIPT,
] as const;
const CACHE_SCRIPT_SHAS: ReadonlyMap<string, string> = new Map(
	CACHE_SCRIPTS.map(script => [script, createHash('sha1').update(script).digest('hex')]),
);

function isNoScriptError(error: unknown) {
	return error instanceof Error && error.message.includes('NOSCRIPT');
}

function hashReply(value: unknown, adapterName = 'RedisAdapter'): Record<string, any> {
	if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Error) {
		throw new TypeError(`${adapterName} expected HGETALL to return an object`);
	}
	return value as Record<string, any>;
}

function flatHashReply(value: unknown, adapterName = 'RedisAdapter') {
	if (!Array.isArray(value) || value.length % 2 !== 0) {
		throw new TypeError(`${adapterName} expected HGETALL to return field-value pairs`);
	}
	const hash: Record<string, any> = {};
	for (let index = 0; index < value.length; index += 2) {
		const field = value[index];
		if (typeof field !== 'string') throw new TypeError(`${adapterName} expected a string hash field`);
		hash[field] = value[index + 1];
	}
	return hash;
}

function integerReply(command: string, value: unknown, adapterName = 'RedisAdapter'): number {
	if (typeof value !== 'number') throw new TypeError(`${adapterName} expected ${command} to return a number`);
	return value;
}

function encodeEntryData(data: any) {
	const fields = Object.entries(toDb(data)).flatMap(([field, value]) => {
		if (typeof value !== 'string') throw new TypeError(`RedisAdapter cannot encode field ${field}`);
		return [field, value];
	});
	return { fields, logicalFields: Array.isArray(data) ? [] : Object.keys(data) };
}

type ExpirationPolicy = { type: 'preserve' } | { type: 'expire'; milliseconds: number } | { type: 'persist' };

export interface RedisAdapterOptions {
	namespace?: string;
}

export class RedisAdapter<SupportsAtomicCooldowns extends boolean = true> implements Adapter {
	isAsync = true;
	readonly supportsAtomicCooldowns: SupportsAtomicCooldowns;

	client: RedisClientType;
	namespace: string;

	constructor(
		data?: ({ client: RedisClientType } | { redisOptions: RedisClientOptions }) & RedisAdapterOptions,
		supportsAtomicCooldowns: SupportsAtomicCooldowns = true as SupportsAtomicCooldowns,
	) {
		this.client = data && 'client' in data ? data.client : createClient(data?.redisOptions);
		this.namespace = data?.namespace ?? 'seyfert';
		this.supportsAtomicCooldowns = supportsAtomicCooldowns;
	}

	async start() {
		await this.client.connect();
		await Promise.all(CACHE_SCRIPTS.map(script => this.client.scriptLoad(script)));
	}

	protected get relationshipPrefix() {
		return this.buildKey(RELATIONSHIP_PREFIX);
	}

	protected relationshipKey(to: string) {
		const namespace = `${this.namespace}:`;
		return `${this.relationshipPrefix}${to.startsWith(namespace) ? to.slice(namespace.length) : to}`;
	}

	protected get relationshipOwnersKey() {
		return this.buildKey(RELATIONSHIP_OWNERS);
	}

	protected async runScript<T>(script: string, keys: string[], args: string[]): Promise<T> {
		const options = { arguments: args, keys };
		try {
			return (await this.client.evalSha(CACHE_SCRIPT_SHAS.get(script)!, options)) as T;
		} catch (error) {
			if (!isNoScriptError(error)) throw error;
			return (await this.client.eval(script, options)) as T;
		}
	}

	protected getExpirationPolicy(_key: string): ExpirationPolicy {
		return { type: 'persist' };
	}

	protected async *scanKeyBatches(query: string, type: 'hash' | 'set' | 'string') {
		for await (const keys of this.client.scanIterator({ MATCH: this.buildKey(query), TYPE: type })) yield keys;
	}

	protected async scanKeys(query: string, type: 'hash' | 'set' | 'string') {
		const keys: string[] = [];
		for await (const batch of this.scanKeyBatches(query, type)) keys.push(...batch);
		return keys;
	}

	protected async removeScannedKeys(
		query: string,
		type: 'hash' | 'set' | 'string',
		filter: (key: string) => boolean = () => true,
	) {
		let removed: number;
		do {
			removed = 0;
			for await (const batch of this.scanKeyBatches(query, type)) {
				const keys = batch.filter(filter);
				if (!keys.length) continue;
				await this.deleteRedisKeys(keys);
				removed += keys.length;
			}
		} while (removed > 0);
	}

	protected async runInBatches<T>(items: T[], operation: (batch: T[]) => Promise<unknown>) {
		for (let offset = 0; offset < items.length; offset += BULK_BATCH_SIZE) {
			await operation(items.slice(offset, offset + BULK_BATCH_SIZE));
		}
	}

	protected async runBulk<T>(items: T[], operation: (item: T) => Promise<unknown>) {
		const failures: unknown[] = [];
		await this.runInBatches(items, async batch => {
			const results = await Promise.allSettled(batch.map(operation));
			for (const result of results) {
				if (result.status === 'rejected') failures.push(result.reason);
			}
		});
		if (failures.length) {
			throw new AggregateError(failures, `RedisAdapter bulk operation failed for ${failures.length} entries`);
		}
	}

	protected async deleteRedisKeys(keys: string[]) {
		if (!keys.length) return;
		await this.runInBatches(keys, batch => this.client.del(batch));
	}

	async scan(query: string, returnKeys?: false): Promise<any[]>;
	async scan(query: string, returnKeys: true): Promise<string[]>;
	async scan(query: string, returnKeys = false) {
		const namespace = `${this.namespace}:`;
		const keys = (await this.scanKeys(query, 'hash'))
			.filter(key => !key.startsWith(this.relationshipPrefix))
			.map(key => key.slice(namespace.length));
		return returnKeys ? keys : this.bulkGet(keys);
	}

	async bulkGet(keys: string[]) {
		const values = await Promise.all(keys.map(key => this.client.hGetAll(this.buildKey(key))));
		return values.map(value => toNormal(hashReply(value))).filter(value => value !== undefined);
	}

	async get(key: string): Promise<any> {
		return toNormal(hashReply(await this.client.hGetAll(this.buildKey(key))));
	}

	protected async readBeforePatch(key: string) {
		return this.get(key);
	}

	protected async writeEntry(
		key: string,
		relationship: AdapterRelationship,
		replace: boolean,
		encoded: { fields: string[]; logicalFields: string[] },
		returnValue = false,
	) {
		const { fields, logicalFields } = encoded;
		if (!replace) await this.readBeforePatch(key);
		const expiration = this.getExpirationPolicy(key);
		const observedAt = Date.now();
		const result = await this.runScript<unknown[]>(
			WRITE_ENTRY_SCRIPT,
			[this.buildKey(key), this.relationshipKey(relationship[0]), this.relationshipOwnersKey],
			[
				key,
				relationship[0],
				relationship[1],
				replace ? 'replace' : 'patch',
				expiration.type,
				expiration.type === 'expire' ? String(expiration.milliseconds) : '0',
				String(fields.length / 2),
				String(logicalFields.length),
				...fields,
				...logicalFields,
				returnValue ? '1' : '0',
			],
		);
		return returnValue ? { ...this.parseWriteResult(result), observedAt } : undefined;
	}

	protected async writeEncodedEntry(
		key: string,
		relationship: AdapterRelationship,
		replace: boolean,
		encoded: { fields: string[]; logicalFields: string[] },
	) {
		await this.writeEntry(key, relationship, replace, encoded);
	}

	protected parseWriteResult(result: unknown[]) {
		if (!Array.isArray(result) || result.length !== 2) {
			throw new TypeError('RedisAdapter expected the write script to return value and TTL');
		}
		return {
			ttl: integerReply('PTTL', result[1]),
			value: toNormal(flatHashReply(result[0])),
		};
	}

	async bulkSet(entries: AdapterEntry[]) {
		const prepared = entries.map(([key, value, relationship]) => [key, relationship, encodeEntryData(value)] as const);
		await this.runBulk(prepared, ([key, relationship, encoded]) =>
			this.writeEncodedEntry(key, relationship, true, encoded),
		);
	}

	async set(key: string, data: any, relationship: AdapterRelationship) {
		await this.writeEncodedEntry(key, relationship, true, encodeEntryData(data));
	}

	async bulkPatch(entries: AdapterEntry[]) {
		const prepared = entries.map(
			([key, value, relationship]) => [key, relationship, Array.isArray(value), encodeEntryData(value)] as const,
		);
		await this.runBulk(prepared, ([key, relationship, replace, encoded]) =>
			this.writeEncodedEntry(key, relationship, replace, encoded),
		);
	}

	async patch(key: string, data: any, relationship: AdapterRelationship): Promise<void> {
		await this.writeEncodedEntry(key, relationship, Array.isArray(data), encodeEntryData(data));
	}

	async eval<T = unknown>(script: string, keys: string[] = [], args: string[] = []): Promise<T> {
		return this.client.eval(script, {
			arguments: args,
			keys: keys.map(key => this.buildKey(key)),
		}) as Promise<T>;
	}

	async values(to: string): Promise<any[]> {
		return this.bulkGet(await this.keys(to));
	}

	async keys(to: string): Promise<string[]> {
		return this.client.hVals(this.relationshipKey(to));
	}

	async count(to: string): Promise<number> {
		return this.client.hLen(this.relationshipKey(to));
	}

	async bulkRemove(keys: string[]) {
		await this.runBulk(keys, key => this.remove(key));
	}

	async remove(key: string): Promise<void> {
		await this.runScript(REMOVE_ENTRY_SCRIPT, [this.buildKey(key), this.relationshipOwnersKey], [key]);
	}

	async flush(): Promise<void> {
		await this.removeScannedKeys('*', 'hash');
	}

	async contains(to: string, key: string): Promise<boolean> {
		return (await this.client.hExists(this.relationshipKey(to), key)) > 0;
	}

	getToRelationship(to: string): Promise<string[]> {
		return this.client.hKeys(this.relationshipKey(to));
	}

	protected async removeRelationshipMember(to: string, id: string) {
		return this.runScript<string | null>(
			REMOVE_RELATIONSHIP_MEMBER_SCRIPT,
			[this.relationshipKey(to), this.relationshipOwnersKey],
			[to, id, `${this.namespace}:`],
		);
	}

	async removeToRelationship(to: string, keys: string | string[]): Promise<void> {
		for (const id of Array.isArray(keys) ? keys : [keys]) {
			await this.removeRelationshipMember(to, id);
		}
	}

	async removeRelationship(to: string | string[]): Promise<void> {
		for (const relationship of Array.isArray(to) ? to : [to]) {
			if (!relationship.includes('*')) {
				await this.removeExactRelationship(relationship);
				continue;
			}
			const keys = (await this.scanKeys(`${RELATIONSHIP_PREFIX}${relationship}`, 'hash')).filter(
				key => key !== this.relationshipOwnersKey,
			);
			for (const key of keys) await this.removeExactRelationship(key.slice(this.relationshipPrefix.length));
		}
	}

	protected async migrateEntry(logicalKey: string, relationship: AdapterRelationship) {
		return this.runScript<number>(
			MIGRATE_ENTRY_SCRIPT,
			[this.buildKey(logicalKey), this.relationshipKey(relationship[0]), this.relationshipOwnersKey],
			[logicalKey, relationship[0], relationship[1]],
		);
	}

	private async removeExactRelationship(to: string) {
		await this.runScript(
			REMOVE_RELATIONSHIP_SCRIPT,
			[this.relationshipKey(to), this.relationshipOwnersKey],
			[to, `${this.namespace}:`],
		);
	}

	protected buildKey(key: string) {
		return key.startsWith(`${this.namespace}:`) ? key : `${this.namespace}:${key}`;
	}
}

export const isObject = (o: unknown) => {
	return !!o && typeof o === 'object' && !Array.isArray(o);
};

export function toNormal(target: Record<string, any>): undefined | Record<string, any> | Record<string, any>[] {
	if (typeof target.ARRAY_OF === 'string') return JSON.parse(target.ARRAY_OF as string).map(toNormal);
	if (!Object.keys(target).length) return undefined;
	const result: Record<string, any> = {};
	for (const [key, value] of Object.entries(target)) {
		if (key === EMPTY_OBJECT_FIELD) continue;
		if (key.startsWith('O_')) result[key.slice(2)] = JSON.parse(value);
		else if (key.startsWith('N_')) result[key.slice(2)] = Number(value);
		else if (key.startsWith('B_')) result[key.slice(2)] = value === 't';
		else result[key] = value;
	}
	return result;
}

export function toDb(target: Record<string, any> | Record<string, any>[]): Record<string, string> {
	if (Array.isArray(target)) return { ARRAY_OF: JSON.stringify(target.map(toDb)) };
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(target)) {
		switch (typeof value) {
			case 'boolean':
				result[`B_${key}`] = value ? 't' : 'f';
				break;
			case 'number':
				result[`N_${key}`] = `${value}`;
				break;
			case 'object':
				result[`O_${key}`] = value === null ? 'null' : JSON.stringify(value);
				break;
			case 'string':
				result[key] = value;
				break;
			default:
				throw new TypeError(`RedisAdapter cannot encode ${typeof value} field ${key}`);
		}
	}
	if (!Object.keys(result).length) result[EMPTY_OBJECT_FIELD] = '1';
	return result;
}
