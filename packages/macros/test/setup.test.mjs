function verifySetup() {
	const root = inject('consumer');
	const manifest = path.join(root, 'package.json');
	const config = path.join(root, 'tsconfig.json');
	const originalManifest = fs.readFileSync(manifest, 'utf8');
	const originalConfig = fs.readFileSync(config, 'utf8');
	const run = (...args) =>
		spawnSync('npm', ['exec', '--offline', '--', 'slipher-macros', 'setup', ...args], { cwd: root, encoding: 'utf8' });
	const selectedConfig = path.join(root, 'tsconfig.build.json');
	try {
		fs.writeFileSync(
			config,
			originalConfig
				.replace('"compilerOptions": {', '// Preserve my comment\n"compilerOptions": {')
				.replace(/"plugins":\s*\[[\s\S]*?\]/, '"plugins": [{ "name": "other-plugin", "enabled": true }]'),
		);
		let result = run();
		expect(result.status, result.stderr).toBe(0);
		const firstConfig = fs.readFileSync(config, 'utf8');
		const firstManifest = fs.readFileSync(manifest, 'utf8');
		expect(firstConfig.includes('// Preserve my comment')).toBeTruthy();
		expect(firstConfig.includes('other-plugin')).toBeTruthy();
		expect(JSON.parse(firstManifest).scripts.build).toBe('slipher-macros build');
		const compiled = spawnSync('npm', ['run', 'build'], { cwd: root, encoding: 'utf8' });
		expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
		result = run();
		expect(result.status, result.stderr).toBe(0);
		expect(fs.readFileSync(config, 'utf8')).toBe(firstConfig);
		expect(fs.readFileSync(manifest, 'utf8')).toBe(firstManifest);
		const custom = JSON.parse(firstManifest);
		custom.scripts.build = 'vite build';
		fs.writeFileSync(manifest, JSON.stringify(custom));
		result = run();
		expect(result.status).toBe(1);
		expect(fs.readFileSync(config, 'utf8')).toBe(firstConfig);
		expect(JSON.parse(fs.readFileSync(manifest, 'utf8')).scripts.build).toBe('vite build');
		fs.writeFileSync(selectedConfig, originalConfig.replace('@slipher/macros/plugin', 'other-plugin'));
		fs.writeFileSync(manifest, firstManifest);
		result = run('-p', 'tsconfig.build.json');
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(fs.readFileSync(manifest, 'utf8')).scripts.build).toBe(
			'slipher-macros build -p "tsconfig.build.json"',
		);
		custom.scripts.build = 'tsc -p "tsconfig.build.json" && node dist/start.js';
		fs.writeFileSync(manifest, JSON.stringify(custom));
		result = run();
		expect(result.status, result.stderr).toBe(0);
		expect(fs.readFileSync(config, 'utf8')).toBe(firstConfig);
		expect(fs.readFileSync(selectedConfig, 'utf8').includes('@slipher/macros/plugin')).toBeTruthy();
		expect(JSON.parse(fs.readFileSync(manifest, 'utf8')).scripts.build).toBe(
			'slipher-macros build -p "tsconfig.build.json" && node dist/start.js',
		);
		result = run('-p', 'tsconfig.json');
		expect(result.status).toBe(1);
	} finally {
		fs.rmSync(selectedConfig, { force: true });
		fs.writeFileSync(manifest, originalManifest);
		fs.writeFileSync(config, originalConfig);
	}
}

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, inject, test } from 'vitest';

test('setup preserves configuration and selects the build project', verifySetup);
