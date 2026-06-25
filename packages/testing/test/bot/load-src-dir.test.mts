import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
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
});
