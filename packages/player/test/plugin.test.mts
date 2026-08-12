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
	test('imports the exact voice plugin and contributes one manager to client and context', () => {
		const voicePlugin = voice();
		const plugin = player({ voice: voicePlugin });
		const client = new BaseClient({ getRC: runtimeConfig, plugins: [plugin] }) as BaseClient & {
			player: typeof plugin.manager;
			voice: VoiceManager;
		};

		expect(plugin.imports).toEqual([voicePlugin]);
		expect(client.plugins.map(value => value.name)).toEqual(['@slipher/voice', '@slipher/player']);
		expect(client.player).toBe(plugin.manager);
		expect(client.options.context?.({} as never)).toEqual({ voice: client.voice, player: client.player });
	});

	test('routes voice state events and closes the manager during teardown', async () => {
		const voicePlugin = voice();
		const plugin = player({ voice: voicePlugin });
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

	test('rejects a missing or unrelated voice plugin before allocating the manager', () => {
		expect(() => player(undefined as never)).toThrow(/requires the @slipher\/voice plugin/);
		expect(() => player({ voice: { name: 'other' } } as never)).toThrow(/requires the @slipher\/voice plugin/);
	});
});
