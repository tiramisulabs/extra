import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import CatalogParent from '../fixtures/e2e-commands/catalog/catalog';
import * as catalogSource from '../fixtures/e2e-commands/catalog-source';

// Integration boot: load the WHOLE command directory from TS source (as in production, but pointed at src), with
// dependency stubs working. loadModule is the runner-agnostic bridge — `p => import(p)` defined here, in a file
// the runner transforms, so the loaded command files (and their deps) stay in the runner's module graph.
const makeBot = (opts: Parameters<typeof createMockBot>[0]) => createMockBot({ loadModule: p => import(p), ...opts });

const COMMANDS_DIR = join(process.cwd(), 'test/fixtures/e2e-commands');

describe('booting a full command directory from TS source', () => {
	test('loads a flat command from source', async () => {
		const bot = await makeBot({ commandsDir: COMMANDS_DIR });
		const result = await bot.slash({ name: 'ping' });
		expect(result.content).toBe('pong');
		await bot.close();
	});

	test('runs @AutoLoad filesystem scan and dispatches a subcommand, with its dep stubbed', async () => {
		const spy = vi.spyOn(catalogSource, 'totalItems').mockReturnValue(42);

		const bot = await makeBot({ commandsDir: COMMANDS_DIR });
		const result = await bot.slash({ name: 'catalog', subcommand: 'list' });

		expect(result.content).toBe('total: 42');
		expect(spy).toHaveBeenCalledOnce();
		await bot.close();
		spy.mockRestore();
	});

	// only:[Class] loads just that group's subtree (type-safe via the imported parent class), skipping the rest
	// of the tree — so a large bot doesn't transform every command to test one group.
	test('only:[Class] loads just the named group and skips the rest', async () => {
		const spy = vi.spyOn(catalogSource, 'totalItems').mockReturnValue(7);
		const bot = await makeBot({ commandsDir: COMMANDS_DIR, only: [CatalogParent] });

		await expect(bot.slash({ name: 'catalog', subcommand: 'list' })).resolves.toMatchObject({ content: 'total: 7' });
		// `ping` lives at the dir root but outside the catalog group, so it was never loaded.
		expect(() => bot.slash({ name: 'ping' })).toThrow(/not registered/);

		await bot.close();
		spy.mockRestore();
	});

	// Files are imported sequentially, not via Promise.all: firing every import() concurrently deadlocks a
	// Vite-style module runner when the command files share a barrel/circular graph (here: list.ts goes through
	// a re-export hub while override.ts imports the same circular submodules directly).
	test('loads a directory whose commands share a circular/barrel dependency graph', async () => {
		const bot = await makeBot({ commandsDir: join(process.cwd(), 'test/fixtures/circular-commands/cmd') });

		await expect(bot.slash({ name: 'circ', subcommand: 'list' })).resolves.toMatchObject({
			content: 'fmt:x:store',
		});
		await expect(bot.slash({ name: 'circ', subcommand: 'override' })).resolves.toMatchObject({
			content: 'fmt-store|fmt:y:store',
		});
		await bot.close();
	});
});
