import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

// Guardrail: `expect(x?.y).not.toContain(z)` passes VACUOUSLY when `x` is undefined (undefined contains nothing),
// so a typo'd accessor or a refactored lookup silently turns a real assertion into a green no-op. This is the
// exact footgun the expect* helpers and the lastEmbed/lastComponents throwing accessors exist to remove. Fail at
// author time: guard the accessor (`expect(x).toBeDefined()` first) or assert on a non-optional value.

const TEST_DIR = join(process.cwd(), 'test');
const SELF = 'no-vacuous-assertions.test.mts';
const VACUOUS = /expect\([^)]*\?\.[^)]*\)\.not\.(toContain|toMatch)\(/;

function collectMts(dir: string, out: string[]): void {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) collectMts(full, out);
		else if (entry.name.endsWith('.mts') && entry.name !== SELF) out.push(full);
	}
}

describe('test hygiene', () => {
	test('no vacuous `.not.toContain/.not.toMatch` on an optional chain', () => {
		const files: string[] = [];
		collectMts(TEST_DIR, files);
		const offenders: string[] = [];
		for (const file of files) {
			readFileSync(file, 'utf8')
				.split('\n')
				.forEach((line, index) => {
					if (VACUOUS.test(line)) offenders.push(`${file}:${index + 1}  ${line.trim()}`);
				});
		}
		expect(
			offenders,
			`Vacuous-pass risk (an optional chain feeding a negative containment matcher). Guard with toBeDefined() or assert a non-optional value:\n${offenders.join('\n')}`,
		).toEqual([]);
	});
});
