import { createClient, type RedisClientOptions } from '@redis/client';
import type { LockStore, LockStoreResult } from './store';

const releaseScript = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
	return redis.call("DEL", KEYS[1])
end
return 0
`;

const extendScript = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
	return redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return 0
`;

export type RedisLockClient = ReturnType<typeof createClient>;

export interface RedisLockStoreOptions {
	client?: RedisLockClient;
	redisOptions?: RedisClientOptions;
	namespace?: string;
}

export class RedisLockStore implements LockStore {
	readonly client: RedisLockClient;
	readonly namespace: string;
	private readonly ownsClient: boolean;

	constructor(options: RedisLockStoreOptions = {}) {
		this.client = options.client ?? createClient(options.redisOptions);
		this.namespace = options.namespace ?? 'slipher:locks';
		this.ownsClient = !options.client;
	}

	start(): Promise<RedisLockClient> {
		if (this.client.isOpen) return Promise.resolve(this.client);
		return this.client.connect();
	}

	async quit(): Promise<void> {
		if (!this.ownsClient || !this.client.isOpen) return;
		await this.client.quit();
	}

	async acquire(key: string, token: string, ttl: number, now: number): Promise<LockStoreResult> {
		const expiresIn = toRedisTtl(ttl);
		const acquired = await this.client.set(this.buildKey(key), token, {
			condition: 'NX',
			expiration: {
				type: 'PX',
				value: expiresIn,
			},
		});

		return {
			acquired: acquired === 'OK',
			expiresAt: now + expiresIn,
		};
	}

	async release(key: string, token: string): Promise<boolean> {
		const released = await this.client.eval(releaseScript, {
			keys: [this.buildKey(key)],
			arguments: [token],
		});

		return Number(released) === 1;
	}

	async extend(key: string, token: string, ttl: number, _now: number): Promise<boolean> {
		const expiresIn = toRedisTtl(ttl);
		const extended = await this.client.eval(extendScript, {
			keys: [this.buildKey(key)],
			arguments: [token, String(expiresIn)],
		});

		return Number(extended) === 1;
	}

	async clear(): Promise<void> {
		const keys: string[] = [];
		for await (const batch of this.client.scanIterator({
			MATCH: this.buildKey('*'),
		}) as AsyncIterable<string[]>) {
			keys.push(...batch);
		}

		if (keys.length) await this.client.del(keys);
	}

	protected buildKey(key: string): string {
		return key.startsWith(`${this.namespace}:`) ? key : `${this.namespace}:${key}`;
	}
}

function toRedisTtl(ttl: number): number {
	if (!Number.isFinite(ttl) || ttl <= 0) throw new RangeError('Redis lock ttl must be a positive finite number.');
	return Math.max(1, Math.ceil(ttl));
}
