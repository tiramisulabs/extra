import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

describe('emitted declaration surface', () => {
	test('MockBot.world is present in the package declarations', () => {
		const outDir = join(process.cwd(), 'test/.generated/declarations');
		rmSync(outDir, { recursive: true, force: true });
		execFileSync(
			'pnpm',
			['exec', 'tsc', '--project', './tsconfig.json', '--emitDeclarationOnly', '--outDir', outDir, '--pretty', 'false'],
			{ cwd: process.cwd(), stdio: 'pipe' },
		);

		const botDts = readFileSync(join(outDir, 'bot/bot.d.ts'), 'utf8');
		expect(botDts).toMatch(/get world\(\): WorldStateReader;/);
	});
});
