import type { GatewaySendPayload } from 'seyfert/lib/types';

/** Minimal shard shape exposed by MockGateway.values(). */
export interface MockShard {
	id: number;
	latency: number;
}

/** Hook bag used to approximate Seyfert gateway callbacks in-process. */
export interface MockGatewayOptions {
	handlePayload?: (shardId: number, payload: unknown) => unknown;
	handleSendPayload?: (
		shardId: number,
		payload: GatewaySendPayload,
	) => GatewaySendPayload | null | undefined | void | Promise<GatewaySendPayload | null | undefined | void>;
	onShardDisconnect?: (data: { shardId: number; code: number; reason: string }) => unknown;
	onShardReconnect?: (data: { shardId: number }) => unknown;
}

/**
 * In-process stand-in for Seyfert's ShardManager: records outbound gateway
 * traffic and exposes controllable shards. It does not open sockets.
 */
export class MockGateway extends Map<number, MockShard> {
	/** setPresence payloads, in order; .at(-1) is the bot's current presence. */
	readonly presences: unknown[] = [];
	/** Raw payloads sent through gateway.send, in order. */
	readonly sent: { shardId: number; payload: unknown }[] = [];
	/** Callback bag mirrored from Seyfert's ShardManager options. */
	readonly options: MockGatewayOptions = { handlePayload: () => undefined };

	constructor(shardCount = 1, latency = 0) {
		super();
		for (let id = 0; id < shardCount; id++) this.set(id, { id, latency });
	}

	/** Average latency across exposed shards. */
	get latency(): number {
		const shards = [...this.values()];
		return shards.reduce((total, shard) => total + shard.latency, 0) / (shards.length || 1);
	}

	/** Record the current bot presence payload. */
	setPresence(payload: unknown): void {
		this.presences.push(payload);
	}

	/** Resolve client/plugin send hooks, then record the payload that would reach the shard. */
	async send(shardId: number, payload: GatewaySendPayload): Promise<boolean> {
		const result = await this.options.handleSendPayload?.(shardId, payload);
		if (result === null) return false;
		this.sent.push({ shardId, payload: result ?? payload });
		return true;
	}

	/** Invoke the wrapped client shard-disconnect hook without opening a socket. */
	async simulateDisconnect(shardId: number, code = 1000, reason = 'mock disconnect'): Promise<void> {
		await this.options.onShardDisconnect?.({ shardId, code, reason });
	}

	/** Invoke the wrapped client shard-reconnect hook without opening a socket. */
	async simulateReconnect(shardId: number): Promise<void> {
		await this.options.onShardReconnect?.({ shardId });
	}
}
