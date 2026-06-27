import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import * as catalogSource from '../fixtures/e2e-commands/catalog-source';

const COMMANDS_DIR = join(process.cwd(), 'test/fixtures/e2e-commands');

// `lazy: true` defers transformation: nothing loads at startup, and a command's group is imported the first time it
// is dispatched (anchored to the dispatched `name`). The DX goal is `commandsDir` + dispatch, with no `only`, no
// strings, and no class lists — only what you dispatch is transformed.
describe('lazy command loading', () => {
	test('loads only the dispatched group, not the whole tree', async () => {
		const imported: string[] = [];
		const bot = await createMockBot({
			commandsDir: COMMANDS_DIR,
			lazy: true,
			loadModule: p => {
				imported.push(p);
				return import(p);
			},
		});

		const result = await bot.slash({ name: 'ping' });
		expect(result.content).toBe('pong');
		// `ping` lives at the root; folder==name path-first loads just it. The catalog/mass/intake groups never import.
		expect(imported.some(p => p.includes('ping'))).toBe(true);
		expect(imported.some(p => p.includes('catalog') || p.includes('mass') || p.includes('intake'))).toBe(false);
		await bot.close();
	});

	test('path-first loads an @AutoLoad group whose folder matches the command name, with its dep stubbed', async () => {
		const spy = vi.spyOn(catalogSource, 'totalItems').mockReturnValue(11);
		const bot = await createMockBot({ commandsDir: COMMANDS_DIR, lazy: true, loadModule: p => import(p) });

		const result = await bot.slash({ name: 'catalog', subcommand: 'list' });
		expect(result.content).toBe('total: 11');
		expect(spy).toHaveBeenCalledOnce();
		await bot.close();
		spy.mockRestore();
	});

	test('falls back to a full scan when the folder name differs from the command name', async () => {
		const bot = await createMockBot({ commandsDir: COMMANDS_DIR, lazy: true, loadModule: p => import(p) });
		// folder `mass/`, command `mass-dm` → path-first misses, fallback scan finds it.
		const result = await bot.slash({ name: 'mass-dm' });
		expect(result.content).toBe('mass');
		await bot.close();
	});

	test('groups accumulate across dispatches', async () => {
		const bot = await createMockBot({ commandsDir: COMMANDS_DIR, lazy: true, loadModule: p => import(p) });
		await expect(bot.slash({ name: 'ping' })).resolves.toMatchObject({ content: 'pong' });
		await expect(bot.slash({ name: 'ping' })).resolves.toMatchObject({ content: 'pong' }); // re-dispatch, no reload
		await bot.close();
	});

	test('a lazily-loaded command can drive a modal via fillModal chaining', async () => {
		const bot = await createMockBot({ commandsDir: COMMANDS_DIR, lazy: true, loadModule: p => import(p) });
		const result = await bot.slash({ name: 'intake' }).fillModal('intake-modal', { reason: 'broken link' });
		expect(result.content).toBe('reason:broken link');
		await bot.close();
	});

	test('an unknown command still fails with the not-registered error after the fallback scan', async () => {
		const bot = await createMockBot({ commandsDir: COMMANDS_DIR, lazy: true, loadModule: p => import(p) });
		await expect(bot.slash({ name: 'does-not-exist' })).rejects.toThrow(/not registered/);
		await bot.close();
	});

	test('lazy + only is rejected (both narrow loading)', async () => {
		await expect(
			createMockBot({ commandsDir: COMMANDS_DIR, lazy: true, only: ['ping'], loadModule: p => import(p) }),
		).rejects.toThrow(/`lazy` and `only`/);
	});

	test('lazy without a commandsDir is rejected', async () => {
		await expect(createMockBot({ lazy: true })).rejects.toThrow(/needs a `commandsDir`/);
	});
});
