import {
	type GatewayDispatchPayload,
	GatewayIntentBits,
	GatewayOpcodes,
	type PluginGatewayDispatchInterceptor,
	PluginOrder,
	type PluginOrderOpt,
} from 'seyfert';
import { BaseClient } from 'seyfert/lib/client/base';
import { describe, expect, test, vi } from 'vitest';
import type { DaveSessionFactoryResource } from '../src/dave/types';
import type { VoiceManager } from '../src/manager';
import { createVoicePlugin } from '../src/plugin';
import type { VoiceRuntimeAdapter } from '../src/runtime/types';

function createDaveFactory(): DaveSessionFactoryResource {
	const factory = vi.fn(() => {
		throw new Error('The test DAVE factory must not create a session.');
	}) as unknown as DaveSessionFactoryResource;
	factory.close = vi.fn();
	return factory;
}

function createRuntime(): VoiceRuntimeAdapter {
	return {
		createWebSocket() {
			throw new Error('The test runtime must not create a WebSocket.');
		},
		async createUdpSocket() {
			throw new Error('The test runtime must not create a UDP socket.');
		},
		now: Date.now,
		random: Math.random,
	};
}

function createClient() {
	return {
		me: { id: '100000000000000001' },
		gateway: {
			calculateShardId: () => 0,
			send: async () => true,
		},
		events: { emit: vi.fn() },
		logger: { warn: vi.fn() },
	};
}

function runtimeConfig() {
	return {
		token: 'token',
		locations: { base: '' },
		intents: 0,
	};
}

describe('voice plugin', () => {
	test('installs the same manager through Seyfert client and context lifecycle', async () => {
		const daveFactory = createDaveFactory();
		const plugin = createVoicePlugin(createRuntime(), daveFactory);
		const client = new BaseClient({ getRC: runtimeConfig, plugins: [plugin] }) as BaseClient & {
			voice: VoiceManager;
		};

		expect(client.options.context?.({} as never)).toEqual({ voice: client.voice });
		expect(client.cache.intents & GatewayIntentBits.GuildVoiceStates).toBe(GatewayIntentBits.GuildVoiceStates);

		await client.start();
		await client.close();

		expect(daveFactory.close).toHaveBeenCalledOnce();
	});

	test('contributes one manager, the required intent, and a transparent raw dispatch observer', async () => {
		const daveFactory = createDaveFactory();
		const plugin = createVoicePlugin(createRuntime(), daveFactory);
		const client = createClient();
		const manager = plugin.client!.voice(client as never);
		const contextManager = plugin.ctx!.voice({} as never, client as never);
		const addIntents = vi.fn();
		let interceptor: PluginGatewayDispatchInterceptor | undefined;
		let interceptorOptions: { order?: PluginOrderOpt } | undefined;

		plugin.register!({
			gateway: {
				addIntents,
				onDispatch(value: PluginGatewayDispatchInterceptor, options?: { order?: PluginOrderOpt }) {
					interceptor = value;
					interceptorOptions = options;
					return () => {};
				},
			},
		} as never);
		await plugin.setup!(client as never);

		expect(contextManager).toBe(manager);
		expect(addIntents).toHaveBeenCalledWith('GuildVoiceStates');
		expect(interceptorOptions).toEqual({ order: PluginOrder.Before });

		const packet = {
			op: GatewayOpcodes.Dispatch,
			t: 'VOICE_SERVER_UPDATE',
			s: 1,
			d: {
				guild_id: '200000000000000001',
				token: 'voice-token',
				endpoint: 'voice.example.test',
			},
		} as GatewayDispatchPayload;
		const snapshot = structuredClone(packet);
		const next = vi.fn(async (value?: GatewayDispatchPayload) => value ?? packet);

		await expect(interceptor!(packet, next, { client: client as never, shardId: 7 })).resolves.toBe(packet);
		expect(next).toHaveBeenCalledOnce();
		expect(next).toHaveBeenCalledWith(packet);
		expect(packet).toEqual(snapshot);

		daveFactory.close = vi.fn(async () => {
			await expect(
				manager.connect({ guildId: '200000000000000001', channelId: '300000000000000001' }),
			).rejects.toMatchObject({ code: 'VOICE_CONNECTION_DESTROYED' });
		});
		await plugin.teardown!(client as never);
		expect(daveFactory.close).toHaveBeenCalledOnce();
	});

	test('closes the DAVE resource even when manager cleanup fails', async () => {
		const daveFactory = createDaveFactory();
		const plugin = createVoicePlugin(createRuntime(), daveFactory);
		const manager = plugin.client!.voice({} as never);
		const managerError = new Error('manager close failed');
		vi.spyOn(manager, 'close').mockRejectedValue(managerError);

		await expect(plugin.teardown!({} as never)).rejects.toMatchObject({
			errors: [managerError],
		});
		expect(daveFactory.close).toHaveBeenCalledOnce();
	});
});
