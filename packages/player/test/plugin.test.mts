import type { VoiceManager } from '@slipher/voice';
import { voice } from '@slipher/voice';
import { BaseClient } from 'seyfert/lib/client/base';
import { describe, expect, test, vi } from 'vitest';
import { player } from '../src';

function runtimeConfig() {
	return {
		token: 'token',
		locations: { base: '' },
		intents: 0,
	};
}

describe('player plugin', () => {
	test('requires voice from the plugin registry and contributes one manager to client and context', () => {
		const voicePlugin = voice();
		const plugin = player();
		const client = new BaseClient({ getRC: runtimeConfig, plugins: [voicePlugin, plugin] }) as BaseClient & {
			player: typeof plugin.manager;
			voice: VoiceManager;
		};

		expect(plugin.imports).toBeUndefined();
		expect(plugin.requires).toEqual(['plugin:@slipher/voice']);
		expect(client.plugins.map(value => value.name)).toEqual(['@slipher/voice', '@slipher/player']);
		expect(client.player).toBe(plugin.manager);
		expect(client.options.context?.({} as never)).toEqual({ voice: client.voice, player: client.player });
	});

	test('routes voice state events and closes the manager during teardown', async () => {
		const plugin = player();
		const manager = plugin.manager;
		const attach = vi.spyOn(manager, 'attach');
		const handle = vi.spyOn(manager, 'handleVoiceStateChange');
		const close = vi.spyOn(manager, 'close');
		let listener: ((...args: readonly unknown[]) => unknown) | undefined;

		plugin.register?.({
			events: {
				on(_name: string, value: (...args: readonly unknown[]) => unknown) {
					listener = value;
					return () => undefined;
				},
			},
		} as never);
		const client = { events: { emit: vi.fn() }, logger: { warn: vi.fn() } };
		await plugin.setup?.(client as never);
		const connection = {} as never;
		const state = {} as never;
		listener?.(connection, state, undefined);

		expect(attach).toHaveBeenCalledExactlyOnceWith(client);
		expect(handle).toHaveBeenCalledExactlyOnceWith(connection, state);
		await plugin.teardown?.(client as never);
		expect(close).toHaveBeenCalledOnce();
	});

	test('rejects a client configuration without the required voice plugin', () => {
		expect(() => new BaseClient({ getRC: runtimeConfig, plugins: [player()] })).toThrow(/@slipher\/voice/);
	});
});
