import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import CatalogList from '../fixtures/e2e-commands/catalog/list';
import * as catalogSource from '../fixtures/e2e-commands/catalog-source';
import MassCommand from '../fixtures/e2e-commands/mass/mass';
import PingCommand from '../fixtures/e2e-commands/ping';

const COMMANDS_DIR = join(process.cwd(), 'test/fixtures/e2e-commands');
const normalized = (path: string | undefined) => path?.replaceAll('\\', '/');
const catalogEntry = (bot: Awaited<ReturnType<typeof createMockBot>>, suffix: string) =>
	bot.registeredCommands().find(entry => normalized(entry.path)?.endsWith(suffix));

// `commandsDir` catalogs command files at startup, then imports a command's group the first time it is dispatched
// (anchored to the dispatched `name`). The DX goal is `commandsDir` + dispatch, with no eager tree transformation.
describe('lazy command loading', () => {
	test('loads only the dispatched group, not the whole tree', async () => {
		const imported: string[] = [];
		const bot = await createMockBot({
			commandsDir: COMMANDS_DIR,
			loadModule: p => {
				imported.push(p);
				return import(p);
			},
		});

		expect(catalogEntry(bot, '/ping.ts')).toMatchObject({ loaded: false, found: [] });
		const result = await bot.slash({ name: 'ping' });
		expect(result.content).toBe('pong');
		expect(catalogEntry(bot, '/ping.ts')).toMatchObject({
			loaded: true,
			found: [{ name: 'ping', type: 'chatInput' }],
		});
		// `ping` lives at the root; folder==name path-first loads just it. The catalog/mass/intake groups never import.
		expect(imported.some(p => p.includes('ping'))).toBe(true);
		expect(imported.some(p => p.includes('catalog') || p.includes('mass') || p.includes('intake'))).toBe(false);
		await bot.close();
	});

	test('path-first loads an @AutoLoad group whose folder matches the command name, with its dep stubbed', async () => {
		const spy = vi.spyOn(catalogSource, 'totalItems').mockReturnValue(11);
		const bot = await createMockBot({ commandsDir: COMMANDS_DIR, loadModule: p => import(p) });

		const result = await bot.slash({ name: 'catalog', subcommand: 'list' });
		expect(result.content).toBe('total: 11');
		expect(catalogEntry(bot, '/catalog/catalog.ts')).toMatchObject({
			loaded: true,
			found: [{ name: 'catalog', type: 'chatInput' }],
		});
		expect(catalogEntry(bot, '/catalog/list.ts')).toMatchObject({
			loaded: true,
			found: [{ name: 'list', type: 'subcommand', parentName: 'catalog' }],
		});
		expect(spy).toHaveBeenCalledOnce();
		await bot.close();
		spy.mockRestore();
	});

	test('subcommand class dispatch does a one-time full scan to discover its @AutoLoad parent', async () => {
		const imported: string[] = [];
		const spy = vi.spyOn(catalogSource, 'totalItems').mockReturnValue(13);
		const bot = await createMockBot({
			commandsDir: COMMANDS_DIR,
			loadModule: p => {
				imported.push(p);
				return import(p);
			},
		});

		const result = await bot.slash(CatalogList);
		expect(result.content).toBe('total: 13');
		expect(result.command).toEqual({ name: 'catalog', subcommand: 'list' });
		expect(imported.some(p => p.includes('catalog'))).toBe(true);
		expect(spy).toHaveBeenCalledOnce();
		await bot.close();
		spy.mockRestore();
	});

	test('top-level command class dispatch loads the command from commandsDir', async () => {
		const bot = await createMockBot({ commandsDir: COMMANDS_DIR, loadModule: p => import(p) });
		const result = await bot.slash(PingCommand);
		expect(result.content).toBe('pong');
		expect(catalogEntry(bot, '/ping.ts')).toMatchObject({
			loaded: true,
			found: [{ name: 'ping', type: 'chatInput' }],
		});
		await bot.close();
	});

	test('falls back to a full scan when the folder name differs from the command name', async () => {
		const bot = await createMockBot({ commandsDir: COMMANDS_DIR, loadModule: p => import(p) });
		// folder `mass/`, command `mass-dm` → path-first misses, fallback scan finds it.
		const result = await bot.slash(MassCommand);
		expect(result.content).toBe('mass');
		expect(catalogEntry(bot, '/mass/mass.ts')).toMatchObject({
			loaded: true,
			found: [{ name: 'mass-dm', type: 'chatInput' }],
		});
		await bot.close();
	});

	test('groups accumulate across dispatches', async () => {
		const bot = await createMockBot({ commandsDir: COMMANDS_DIR, loadModule: p => import(p) });
		await expect(bot.slash({ name: 'ping' })).resolves.toMatchObject({ content: 'pong' });
		await expect(bot.slash({ name: 'ping' })).resolves.toMatchObject({ content: 'pong' }); // re-dispatch, no reload
		await bot.close();
	});

	test('a lazily-loaded command can drive a modal via fillModal chaining', async () => {
		const bot = await createMockBot({ commandsDir: COMMANDS_DIR, loadModule: p => import(p) });
		const result = await bot.slash({ name: 'intake' }).fillModal('intake-modal', { reason: 'broken link' });
		expect(result.content).toBe('reason:broken link');
		await bot.close();
	});

	test('an unknown command still fails with the not-registered error after the fallback scan', async () => {
		const bot = await createMockBot({ commandsDir: COMMANDS_DIR, loadModule: p => import(p) });
		await expect(bot.slash({ name: 'does-not-exist' })).rejects.toThrow(/not registered/);
		await bot.close();
	});
});
