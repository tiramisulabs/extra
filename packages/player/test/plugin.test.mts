import { createMockBot } from '@slipher/testing';
import { voice } from '@slipher/voice';
import { describe, expect, test, vi } from 'vitest';
import { player } from '../src';

describe('player plugin', () => {
	test('requires voice from the plugin registry and contributes one manager to client and context', async () => {
		const voicePlugin = voice();
		const plugin = player();
		const bot = await createMockBot({ plugins: [voicePlugin, plugin] });

		expect(plugin.imports).toBeUndefined();
		expect(plugin.requires).toEqual(['plugin:@slipher/voice']);
		expect(bot.client.plugins.map(value => value.name)).toEqual(['@slipher/voice', '@slipher/player']);
		expect(bot.client.player).toBe(plugin.manager);
		expect(bot.client.options.context?.({} as never)).toEqual({
			voice: bot.client.voice,
			player: bot.client.player,
		});
		await bot.close();
	});

	test('routes voice state events and closes the manager during teardown', async () => {
		const plugin = player();
		const manager = plugin.manager;
		const attach = vi.spyOn(manager, 'attach');
		const handle = vi.spyOn(manager, 'handleVoiceStateChange');
		const close = vi.spyOn(manager, 'close');
		const bot = await createMockBot({ plugins: [voice(), plugin] });
		const connection = {} as never;
		const state = {} as never;
		await bot.emit('voiceConnectionStateChange', [connection, state], { updateCache: false });

		expect(attach).toHaveBeenCalledExactlyOnceWith(bot.client);
		expect(handle).toHaveBeenCalledExactlyOnceWith(connection, state);
		await bot.close();
		expect(close).toHaveBeenCalledOnce();
	});

	test('rejects a client configuration without the required voice plugin', async () => {
		await expect(createMockBot({ plugins: [player()] })).rejects.toThrow(/@slipher\/voice/);
	});
});
