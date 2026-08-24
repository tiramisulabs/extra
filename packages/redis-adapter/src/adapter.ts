import { createClient, type RedisClientOptions, type RedisClientType } from '@redis/client';
import type { Adapter } from 'seyfert/lib/cache';

const BULK_BATCH_SIZE = 100;

export interface RedisAdapterOptions {
	namespace?: string;
}

export class RedisAdapter implements Adapter {
	isAsync = true;

	client: RedisClientType;
	namespace: string;

	constructor(data?: ({ client: RedisClientType } | { redisOptions: RedisClientOptions }) & RedisAdapterOptions) {
		this.client = data && 'client' in data ? data.client : createClient(data?.redisOptions);
		this.namespace = data?.namespace ?? 'seyfert';
	}

	async start() {
		await this.client.connect();
	}

	protected async *scanKeyBatches(query: string, type: 'hash' | 'set' | 'string') {
		const match = this.buildKey(query);

		for await (const keys of this.client.scanIterator({
			MATCH: match,
			TYPE: type,
		})) {
			yield keys;
		}
	}

	protected async scanKeys(query: string, type: 'hash' | 'set' | 'string') {
		const keys: string[] = [];
		for await (const batch of this.scanKeyBatches(query, type)) {
			keys.push(...batch);
		}

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

	protected async deleteRedisKeys(keys: string[]) {
		if (!keys.length) return;
		await this.runInBatches(keys, batch => this.client.del(batch));
	}

	async scan(query: string, returnKeys?: false): Promise<any[]>;
	async scan(query: string, returnKeys: true): Promise<string[]>;
	async scan(query: string, returnKeys = false) {
		const keys = await this.scanKeys(query, 'hash');
		return returnKeys ? keys : this.bulkGet(keys);
	}

	async bulkGet(keys: string[]) {
		const promises: Promise<any>[] = [];
		for (const key of keys) {
			promises.push(this.client.hGetAll(this.buildKey(key)));
		}

		return (
			(await Promise.all(promises))
				?.filter(x => x)
				.map(x => toNormal(x as Record<string, any>))
				.filter(x => x) ?? []
		);
	}

	async get(keys: string): Promise<any> {
		const value = await this.client.hGetAll(this.buildKey(keys));
		if (value) {
			return toNormal(value);
		}
	}

	async bulkSet(data: [string, any][]) {
		await this.runInBatches(data, batch => Promise.all(batch.map(([key, value]) => this.set(key, value))));
	}

	async set(id: string, data: any) {
		const key = this.buildKey(id);
		await this.client.multi().del(key).hSet(key, toDb(data)).exec();
	}

	async bulkPatch(data: [string, any][]) {
		await this.runInBatches(data, batch => Promise.all(batch.map(([key, value]) => this.patch(key, value))));
	}

	async patch(id: string, data: any): Promise<void> {
		if (Array.isArray(data)) {
			await this.set(id, data);
			return;
		}
		await this.client.hSet(this.buildKey(id), toDb(data));
	}

	async values(to: string): Promise<any[]> {
		const array: unknown[] = [];
		const data = await this.keys(to);
		if (data.length) {
			const items = await this.bulkGet(data);
			for (const item of items) {
				if (item) {
					array.push(item);
				}
			}
		}

		return array;
	}

	async keys(to: string): Promise<string[]> {
		const data = await this.getToRelationship(to);
		return data.map(id => this.buildKey(`${to}.${id}`));
	}

	async count(to: string): Promise<number> {
		return this.client.sCard(`${this.buildKey(to)}:set`);
	}

	async bulkRemove(keys: string[]) {
		await this.deleteRedisKeys(keys.map(key => this.buildKey(key)));
	}

	async remove(keys: string): Promise<void> {
		await this.client.del(this.buildKey(keys));
	}

	async flush(): Promise<void> {
		await Promise.all([this.removeScannedKeys('*', 'hash'), this.removeScannedKeys('*:set', 'set')]);
	}

	async contains(to: string, keys: string): Promise<boolean> {
		return (await this.client.sIsMember(`${this.buildKey(to)}:set`, keys)) > 0;
	}

	getToRelationship(to: string): Promise<string[]> {
		return this.client.sMembers(`${this.buildKey(to)}:set`);
	}

	async bulkAddToRelationShip(data: Record<string, string[]>): Promise<void> {
		await this.runInBatches(Object.entries(data), batch =>
			Promise.all(batch.map(([key, value]) => this.client.sAdd(`${this.buildKey(key)}:set`, value))),
		);
	}

	async addToRelationship(to: string, keys: string | string[]): Promise<void> {
		await this.client.sAdd(`${this.buildKey(to)}:set`, Array.isArray(keys) ? keys : [keys]);
	}

	async removeToRelationship(to: string, keys: string | string[]): Promise<void> {
		await this.client.sRem(`${this.buildKey(to)}:set`, Array.isArray(keys) ? keys : [keys]);
	}

	async removeRelationship(to: string | string[]): Promise<void> {
		await this.runInBatches(Array.isArray(to) ? to : [to], batch =>
			this.client.del(batch.map(relationship => `${this.buildKey(relationship)}:set`)),
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
		if (key.startsWith('O_')) {
			result[key.slice(2)] = JSON.parse(value);
		} else if (key.startsWith('N_')) {
			result[key.slice(2)] = Number(value);
		} else if (key.startsWith('B_')) {
			result[key.slice(2)] = value === 't';
		} else {
			result[key] = value;
		}
	}
	return result;
}

export function toDb(target: Record<string, any> | Record<string, any>[]): Record<string, any> | { ARRAY_OF: string } {
	if (Array.isArray(target)) return { ARRAY_OF: JSON.stringify(target.map(toDb)) };
	const result: Record<string, any> = {};
	for (const [key, value] of Object.entries(target)) {
		switch (typeof value) {
			case 'boolean':
				result[`B_${key}`] = value ? 't' : 'f';
				break;
			case 'number':
				result[`N_${key}`] = `${value}`;
				break;
			case 'object': {
				if (Array.isArray(value)) {
					result[`O_${key}`] = JSON.stringify(value);
					break;
				}
				if (isObject(value)) {
					result[`O_${key}`] = JSON.stringify(value);
					break;
				}
				if (!Number.isNaN(value)) {
					result[`O_${key}`] = 'null';
					break;
				}
				result[`O_${key}`] = JSON.stringify(value);
				break;
			}
			default:
				result[key] = value;
				break;
		}
	}
	return result;
}
