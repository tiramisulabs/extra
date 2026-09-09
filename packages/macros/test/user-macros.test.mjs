function verifyUserMacros() {
	const root = inject('consumer');
	const compiler = path.join(root, 'node_modules/@slipher/macros/lib/build.cjs');
	const manifest = path.join(root, 'package.json');
	const original = fs.readFileSync(manifest, 'utf8');
	const macroFile = path.join(root, 'src/user-macros.ts');
	const macroSource = fs.readFileSync(macroFile, 'utf8');
	try {
		for (const type of ['commonjs', 'module']) {
			fs.writeFileSync(manifest, JSON.stringify({ ...JSON.parse(original), type }));
			let result = spawnSync(process.execPath, [compiler], { cwd: root, encoding: 'utf8' });
			expect(result.status, result.stdout + result.stderr).toBe(0);
			const emitted = fs.readFileSync(path.join(root, 'dist/user-macros.js'), 'utf8');
			expect(
				!emitted.includes('@slipher/macros') && !emitted.includes('$record') && !emitted.includes('$double'),
				emitted,
			).toBeTruthy();
			const declarations = fs.readFileSync(path.join(root, 'dist/user-macros.d.ts'), 'utf8');
			expect(!declarations.includes('$double'), declarations).toBeTruthy();
			result = spawnSync(
				process.execPath,
				[
					'--input-type=module',
					'-e',
					`import { execute } from './dist/user-macros.js';
import { CustomCommand } from './dist/custom-command.js';
const result = execute();
if (result.value !== 42 || result.events.join() !== 'expanded') throw Error(JSON.stringify(result));
const custom = new CustomCommand().run({ options: { query: 'typed' } });
if (custom.query !== 'typed' || custom.value !== 42) throw Error(JSON.stringify(custom));`,
				],
				{ cwd: root, encoding: 'utf8' },
			);
			expect(result.status, result.stdout + result.stderr).toBe(0);
		}
		fs.writeFileSync(macroFile, macroSource.replace('$record!(events', '$record(events'));
		const invalid = spawnSync(process.execPath, [compiler], { cwd: root, encoding: 'utf8' });
		expect(invalid.status).toBe(1);
		expect(invalid.stderr.includes('TS99002'), invalid.stderr).toBeTruthy();
	} finally {
		fs.writeFileSync(macroFile, macroSource);
		fs.writeFileSync(manifest, original);
	}
}

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, inject, test } from 'vitest';

test('user macros generate logic without runtime references', verifyUserMacros);
