import type { createClient, RedisClientOptions } from '@redis/client';
import { type MakeRequired, MergeOptions } from 'seyfert/lib/common';
import { RedisAdapter, type RedisAdapterOptions, toDb } from './adapter';

export interface ResourceLimitedMemoryAdapter {
	expire?: number;
	// limit?: number; soontm?
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
				},
			} satisfies ExpirableRedisAdapterOptions,
			options,
		);
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
		const promisesScan: Promise<string>[] = [];

		for (const i of Array.isArray(to) ? to : [to]) {
			await this.scan(`${this.buildKey(i)}.uset.*`);
		}

		await this.client.del(await Promise.all(promisesScan));
	}

	async count(to: string): Promise<number> {
		return (await this.keys(to)).length;
	}

	async flush(): Promise<void> {
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
		const cacheType = id.split('.')[0] as keyof ExpirableRedisAdapterOptions;

		const expire = this.options[cacheType]?.expire ?? this.options.default.expire!;
		if (expire > 0) {
			promises.push(this.client.pExpire(this.buildKey(id), expire));
		}

		await Promise.all(promises);
	}

	async patch(id: string, data: any): Promise<void> {
		const promises: Promise<unknown>[] = [this.client.hSet(this.buildKey(id), toDb(data))];

		const cacheType = id.split('.')[0] as keyof ExpirableRedisAdapterOptions;
		const expire = this.options[cacheType]?.expire ?? this.options.default.expire!;
		if (expire > 0) {
			promises.push(this.client.pExpire(this.buildKey(id), expire));
		}

		await Promise.all(promises);
	}
}
