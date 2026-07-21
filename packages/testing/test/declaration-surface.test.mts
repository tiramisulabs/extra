import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

// Resolve the installed tsc and run it via node directly — `pnpm exec` isn't
// cross-platform (Node can't resolve the `pnpm` shim without a shell on Windows).
const tsc = createRequire(join(process.cwd(), 'package.json')).resolve('typescript/bin/tsc');

describe('emitted declaration surface', () => {
	test('keeps public MockBot readers and strips internal REST history', () => {
		const outDir = join(process.cwd(), 'test/.generated/declarations');
		rmSync(outDir, { recursive: true, force: true });
		execFileSync(
			process.execPath,
			[tsc, '--project', './tsconfig.json', '--emitDeclarationOnly', '--outDir', outDir, '--pretty', 'false'],
			{ cwd: process.cwd(), stdio: 'pipe' },
		);

		const botDts = readFileSync(join(outDir, 'bot/bot.d.ts'), 'utf8');
		const restDts = readFileSync(join(outDir, 'bot/rest.d.ts'), 'utf8');
		expect(botDts).toMatch(/get world\(\): WorldStateReader;/);
		expect(restDts).not.toMatch(/readonly actions: RecordedAction\[\];/);
	});
});
