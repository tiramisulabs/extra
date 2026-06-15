import { ActivityType, GatewayOpcodes, PresenceUpdateStatus } from 'seyfert/lib/types';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';

const englishLang = { greeting: 'Hello!' };

declare module 'seyfert' {
	interface SeyfertRegistry {
		langs: typeof englishLang;
	}
}

describe('mock gateway', () => {
	test('records presence, sends, and exposes controllable shards', async () => {
		const bot = await createMockBot({ shards: 3, shardLatency: 12 });
		bot.client.gateway.setPresence({
			activities: [{ name: 'testing', type: ActivityType.Playing }],
			afk: false,
			since: null,
			status: PresenceUpdateStatus.Online,
		});
		await bot.client.gateway.send(0, { op: GatewayOpcodes.Heartbeat, d: 1 });

		expect([...bot.client.gateway.values()]).toHaveLength(3);
		expect(bot.gateway.presences.at(-1)).toMatchObject({ activities: [{ name: 'testing' }] });
		expect(bot.gateway.sent).toMatchObject([{ shardId: 0, payload: { op: GatewayOpcodes.Heartbeat } }]);
		expect(bot.gateway.latency).toBe(12);
		await bot.close();
	});

	test('simulateDisconnect and simulateReconnect call configured shard hooks', async () => {
		const seen: string[] = [];
		const bot = await createMockBot({
			clientOptions: {
				onShardDisconnect: async data => {
					seen.push(`disconnect:${data.shardId}:${data.code}`);
				},
				onShardReconnect: async data => {
					seen.push(`reconnect:${data.shardId}`);
				},
			},
		});

		await bot.gateway.simulateDisconnect(0, 4000, 'test');
		await bot.gateway.simulateReconnect(0);

		expect(seen).toEqual(['disconnect:0:4000', 'reconnect:0']);
		await bot.close();
	});

	test('send records transformed payloads and honors vetoes', async () => {
		const bot = await createMockBot({
			clientOptions: {
				handleSendPayload: async (_shardId, payload) =>
					payload.op === GatewayOpcodes.Heartbeat && payload.d === 1 ? { op: GatewayOpcodes.Heartbeat, d: 99 } : null,
			},
		});

		await expect(bot.client.gateway.send(0, { op: GatewayOpcodes.Heartbeat, d: 1 })).resolves.toBe(true);
		await expect(bot.client.gateway.send(0, { op: GatewayOpcodes.Heartbeat, d: 2 })).resolves.toBe(false);

		expect(bot.gateway.sent).toEqual([{ shardId: 0, payload: { op: GatewayOpcodes.Heartbeat, d: 99 } }]);
		await bot.close();
	});
});
