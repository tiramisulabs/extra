import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import * as catalogSource from '../fixtures/e2e-commands/catalog-source';

// Integration boot: catalog a command directory from TS source (as in production, but pointed at src), then import
// matching groups on dispatch with dependency stubs working. loadModule is the runner-agnostic bridge —
// `p => import(p)` defined here, in a file the runner transforms, so loaded command files stay in the runner's graph.
const makeBot = (opts: Parameters<typeof createMockBot>[0]) => createMockBot({ loadModule: p => import(p), ...opts });

const COMMANDS_DIR = join(process.cwd(), 'test/fixtures/e2e-commands');

describe('booting a command directory from TS source', () => {
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

	// Files are imported sequentially, not via Promise.all: firing every import() concurrently deadlocks a
	// Vite-style module runner when the command files share a barrel/circular graph (here: list.ts goes through
	// a re-export hub while override.ts imports the same circular submodules directly).
	test('loads a directory whose commands share a circular/barrel dependency graph', async () => {
		const imported: string[] = [];
		const bot = await createMockBot({
			commandsDir: join(process.cwd(), 'test/fixtures/circular-commands/cmd'),
			loadModule: path => {
				imported.push(path.replaceAll('\\', '/'));
				return import(path);
			},
		});

		await expect(bot.slash({ name: 'circ', subcommand: 'list' })).resolves.toMatchObject({
			content: 'fmt:x:store',
		});
		await expect(bot.slash({ name: 'circ', subcommand: 'override' })).resolves.toMatchObject({
			content: 'fmt-store|fmt:y:store',
		});
		expect(imported.filter(path => path.includes('/cmd/')).map(path => path.split('/').at(-1))).toEqual([
			'circ.ts',
			'list.ts',
			'override.ts',
		]);
		expect(imported.some(path => path.includes('/deps/'))).toBe(false);
		await bot.close();
	});
});
