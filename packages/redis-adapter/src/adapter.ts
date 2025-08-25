import { createClient, type RedisClientOptions } from '@redis/client';
import type { Adapter } from 'seyfert/lib/cache';

export interface RedisAdapterOptions {
	namespace?: string;
}

export class RedisAdapter implements Adapter {
	isAsync = true;

	client: ReturnType<typeof createClient>;
	namespace: string;

	constructor(
		data?: ({ client: ReturnType<typeof createClient> } | { redisOptions: RedisClientOptions }) & RedisAdapterOptions,
	) {
		this.client = data && 'client' in data ? data.client : createClient(data?.redisOptions);
		this.namespace = data?.namespace ?? 'seyfert';
	}

	async start() {
		await this.client.connect();
	}

	async __scanSets(query: string, returnKeys?: false): Promise<any[]>;
	async __scanSets(query: string, returnKeys: true): Promise<string[]>;
	async __scanSets(query: string, returnKeys = false) {
		const match = this.buildKey(query);
		const keys: any[] = [];

		for await (const i of this.client.scanIterator({
			MATCH: match,
			TYPE: 'set',
		})) {
			keys.push(...i);
		}
		return returnKeys ? keys.map(x => this.buildKey(x)) : this.bulkGet(keys);
	}

	async scan(query: string, returnKeys?: false): Promise<any[]>;
	async scan(query: string, returnKeys: true): Promise<string[]>;
	async scan(query: string, returnKeys = false) {
		const match = this.buildKey(query);
		const values: string[] = [];
		for await (const i of this.client.scanIterator({
			MATCH: match,
			TYPE: 'hash',
		})) {
			values.push(...i);
		}

		return returnKeys ? values : this.bulkGet(values);
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
		const promises: Promise<any>[] = [];

		for (const [k, v] of data) {
			promises.push(this.client.hSet(this.buildKey(k), toDb(v)));
		}

		await Promise.all(promises);
	}

	async set(id: string, data: any) {
		await this.client.hSet(this.buildKey(id), toDb(data));
	}

	async bulkPatch(data: [string, any][]) {
		const promises: Promise<any>[] = [];

		for (const [k, v] of data) {
			promises.push(this.patch(k, v));
		}

		await Promise.all(promises);
	}

	async patch(id: string, data: any): Promise<void> {
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
		if (!keys.length) return;
		await this.client.del(keys.map(x => this.buildKey(x)));
	}

	async remove(keys: string): Promise<void> {
		await this.client.del(this.buildKey(keys));
	}

	async flush(): Promise<void> {
		const keys = await Promise.all([
			this.scan(this.buildKey('*'), true),
			this.__scanSets(this.buildKey('*'), true),
		]).then(x => x.flat());
		if (!keys.length) return;
		await this.bulkRemove(keys);
	}

	async contains(to: string, keys: string): Promise<boolean> {
		return (await this.client.sIsMember(`${this.buildKey(to)}:set`, keys)) > 0;
	}

	getToRelationship(to: string): Promise<string[]> {
		return this.client.sMembers(`${this.buildKey(to)}:set`);
	}

	async bulkAddToRelationShip(data: Record<string, string[]>): Promise<void> {
		const promises: Promise<unknown>[] = [];

		for (const [key, value] of Object.entries(data)) {
			promises.push(this.client.sAdd(`${this.buildKey(key)}:set`, value));
		}

		await Promise.all(promises);
	}

	async addToRelationship(to: string, keys: string | string[]): Promise<void> {
		await this.client.sAdd(`${this.buildKey(to)}:set`, Array.isArray(keys) ? keys : [keys]);
	}

	async removeToRelationship(to: string, keys: string | string[]): Promise<void> {
		await this.client.sRem(`${this.buildKey(to)}:set`, Array.isArray(keys) ? keys : [keys]);
	}

	async removeRelationship(to: string | string[]): Promise<void> {
		await this.client.del(Array.isArray(to) ? to.map(x => `${this.buildKey(x)}:set`) : [`${this.buildKey(to)}:set`]);
	}

	protected buildKey(key: string) {
		console.log({ key }, 'buildKey');
		return key.startsWith(this.namespace) ? key : `${this.namespace}:${key}`;
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
