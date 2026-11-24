import type { MockBot } from '@slipher/testing';

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

export function readyPacket(options: { guilds: string[] }): DispatchPacket {
	return {
		op: 0,
		t: 'READY',
		s: 1,
		d: {
			v: 10,
			user: { id: BOT_ID, username: 'bot', discriminator: '0', avatar: null, global_name: null },
			guilds: options.guilds.map(id => ({ id, unavailable: true })),
			session_id: 'session-1',
			resume_gateway_url: 'wss://gateway.invalid',
			shard: [0, 1],
			application: { id: APPLICATION_ID, flags: 0 },
		},
	};
}

export interface GuildPayload {
	id: string;
	name?: string;
	roles?: { id: string; name?: string }[];
}

export function guildPacket(t: 'GUILD_UPDATE' | 'RAW_GUILD_CREATE', s: number, guild: GuildPayload) {
	return { op: 0, t, s, d: guild } satisfies DispatchPacket;
}

/** A promise with its resolver, for holding an operation open across other work. */
export function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(res => {
		resolve = res;
	});
	return { promise, resolve };
}
