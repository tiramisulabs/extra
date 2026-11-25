import type { MockBot } from '@slipher/testing';
import {
	type Adapter,
	type AdapterEntry,
	type AdapterIncrementOptions,
	type AdapterRelationship,
	MemoryAdapter,
} from 'seyfert';

export const BOT_ID = '1000';
export const APPLICATION_ID = '2000';

export interface DispatchPacket {
	op: 0;
	t: string;
	s: number;
	d?: unknown;
}

export type Dispatch = (packet: DispatchPacket, shardId?: number) => Promise<unknown>;

/** Drives the client's real packet path: Gateway interceptors, core cache, plugin cache resources, listeners. */
export function gatewayDispatch(bot: MockBot): Dispatch {
	const handlePayload = bot.gateway.options.handlePayload as (shardId: number, packet: unknown) => Promise<unknown>;
	return (packet, shardId = 0) => handlePayload(shardId, packet);
}

export function readyPacket(options: {
	guilds: string[];
	s?: number;
	sessionId?: string;
	shard?: [id: number, total: number];
}): DispatchPacket {
	return {
		op: 0,
		t: 'READY',
		s: options.s ?? 1,
		d: {
			v: 10,
			user: { id: BOT_ID, username: 'bot', discriminator: '0', avatar: null, global_name: null },
			guilds: options.guilds.map(id => ({ id, unavailable: true })),
			session_id: options.sessionId ?? 'session-1',
			resume_gateway_url: 'wss://gateway.invalid',
			shard: options.shard ?? [0, 1],
			application: { id: APPLICATION_ID, flags: 0 },
		},
	};
}

export interface GuildPayload {
	id: string;
	name?: string;
	unavailable?: boolean;
	roles?: { id: string; name?: string }[];
	channels?: { id: string; type: number; name?: string; permission_overwrites?: object[] }[];
	threads?: { id: string; type: number; thread_metadata?: { archived: boolean } }[];
	emojis?: { id: string; name?: string }[];
	stickers?: { id: string; name?: string }[];
	members?: { user: { id: string; username?: string }; roles?: string[] }[];
	voice_states?: { user_id: string; channel_id: string }[];
	presences?: { user: { id: string }; status?: string }[];
	stage_instances?: { id: string; channel_id: string }[];
}

export function guildPacket(
	t: 'GUILD_CREATE' | 'GUILD_UPDATE' | 'RAW_GUILD_CREATE',
	s: number,
	guild: GuildPayload,
): DispatchPacket {
	return { op: 0, t, s, d: guild };
}

export function guildDeletePacket(
	t: 'GUILD_DELETE' | 'RAW_GUILD_DELETE',
	s: number,
	guild: { id: string; unavailable?: boolean },
): DispatchPacket {
	return { op: 0, t, s, d: guild };
}

/** Seyfert emits this without a payload, reusing the sequence of the packet that completed the stream. */
export function guildsReadyPacket(s: number): DispatchPacket {
	return { op: 0, t: 'GUILDS_READY', s };
}

/** A promise with its resolver, for holding an operation open across other work. */
export function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(res => {
		resolve = res;
	});
	return { promise, resolve };
}

/** Lets promise continuations that are already queued run, without advancing timers. */
export async function settleMicrotasks(turns = 30): Promise<void> {
	for (let turn = 0; turn < turns; turn++) await Promise.resolve();
}

/** A guild ID Discord's shard formula assigns to `index % totalShards`. */
export function guildOn(index: number): string {
	return (BigInt(index) << 22n).toString();
}

type AdapterMethod = Exclude<keyof Adapter, 'isAsync'>;

/**
 * Asynchronous adapter over an in-memory store. Individual calls can be held open or made to reject, which is
 * how the tests reorder completion and exercise storage failures.
 *
 * By default a held call lets later calls overtake it. With `serial`, calls reach the store in the order they
 * were issued, like commands on one connection: a held call holds everything issued after it.
 */
export class AsyncAdapter implements Adapter {
	readonly isAsync = true;
	readonly memory = new MemoryAdapter();
	readonly calls: AdapterMethod[] = [];
	private readonly gates = new Map<AdapterMethod, Promise<void>[]>();
	private readonly failures = new Map<AdapterMethod, { error: unknown; partial?: () => void }[]>();
	private tail: Promise<unknown> = Promise.resolve();

	constructor(private readonly options: { serial?: boolean } = {}) {}

	/** Holds the next call of `method` open until `until` settles. */
	gate(method: AdapterMethod, until: Promise<void>): void {
		this.gates.set(method, [...(this.gates.get(method) ?? []), until]);
	}

	/** Makes the next call of `method` reject, optionally after `partial` already changed the store. */
	failNext(method: AdapterMethod, error: unknown, partial?: () => void): void {
		this.failures.set(method, [...(this.failures.get(method) ?? []), { error, partial }]);
	}

	private run<T>(method: AdapterMethod, apply: () => T): Promise<T> {
		this.calls.push(method);
		const gate = this.gates.get(method)?.shift();
		const execute = async () => {
			await gate;
			const failure = this.failures.get(method)?.shift();
			if (failure) {
				failure.partial?.();
				throw failure.error;
			}
			return apply();
		};
		if (!this.options.serial) return execute();
		const result = this.tail.then(execute);
		this.tail = result.catch(() => undefined);
		return result;
	}

	start() {
		return this.run('start', () => undefined);
	}
	scan(query: string, keys?: boolean) {
		return this.run('scan', () => this.memory.scan(query, keys as true));
	}
	bulkGet(keys: string[]) {
		return this.run('bulkGet', () => this.memory.bulkGet(keys));
	}
	get(key: string) {
		return this.run('get', () => this.memory.get(key));
	}
	bulkSet(entries: AdapterEntry[]) {
		return this.run('bulkSet', () => this.memory.bulkSet(entries));
	}
	set(key: string, value: unknown, relationship: AdapterRelationship) {
		return this.run('set', () => this.memory.set(key, value, relationship));
	}
	bulkPatch(entries: AdapterEntry[]) {
		return this.run('bulkPatch', () => this.memory.bulkPatch(entries));
	}
	patch(key: string, value: unknown, relationship: AdapterRelationship) {
		return this.run('patch', () => this.memory.patch(key, value, relationship));
	}
	increment(key: string, field: string, delta: number, options?: AdapterIncrementOptions) {
		return this.run('increment', () => this.memory.increment(key, field, delta, options));
	}
	values(to: string) {
		return this.run('values', () => this.memory.values(to));
	}
	keys(to: string) {
		return this.run('keys', () => this.memory.keys(to));
	}
	count(to: string) {
		return this.run('count', () => this.memory.count(to));
	}
	bulkRemove(keys: string[]) {
		return this.run('bulkRemove', () => this.memory.bulkRemove(keys));
	}
	remove(key: string) {
		return this.run('remove', () => this.memory.remove(key));
	}
	flush() {
		return this.run('flush', () => this.memory.flush());
	}
	contains(to: string, key: string) {
		return this.run('contains', () => this.memory.contains(to, key));
	}
	getToRelationship(to: string) {
		return this.run('getToRelationship', () => this.memory.getToRelationship(to));
	}
	removeToRelationship(to: string, keys: string | string[]) {
		return this.run('removeToRelationship', () => this.memory.removeToRelationship(to, keys));
	}
	removeRelationship(to: string | string[]) {
		return this.run('removeRelationship', () => this.memory.removeRelationship(to));
	}
}
