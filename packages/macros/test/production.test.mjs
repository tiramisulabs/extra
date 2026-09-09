test('compiled bot starts with only its production dependency installed', () => {
	const consumer = inject('consumer');
	const production = fs.mkdtempSync(path.join(os.tmpdir(), 'slipher-macros-production-'));
	try {
		fs.cpSync(path.join(consumer, 'dist'), path.join(production, 'dist'), { recursive: true });
		fs.writeFileSync(
			path.join(production, 'package.json'),
			JSON.stringify({
				private: true,
				type: 'module',
				dependencies: { seyfert: '5.1.0' },
			}),
		);
		run('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], production);
		expect(run(process.execPath, ['dist/start.js'], production)).toContain('Ready: search');
		expect(
			run(
				process.execPath,
				[
					'--input-type=module',
					'-e',
					`
			import { UserButton } from './dist/user-button.js';
			const button = new UserButton();
			const context = { customId: 'user:123' };
			if (!await button.filter(context)) throw Error('CustomId did not match');
			console.log(button.run(context));
		`,
				],
				production,
			),
		).toBe('123');
	} finally {
		fs.rmSync(production, { recursive: true, force: true });
	}
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, inject, test } from 'vitest';
import { run } from './process.mjs';
