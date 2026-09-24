export default function setup({ provide }) {
	const root = fileURLToPath(new URL('..', import.meta.url));
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'slipher-macros-'));
	try {
		run(process.execPath, ['scripts/build.cjs'], root);
		const [pack] = JSON.parse(
			run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], root),
		);
		const consumer = path.join(directory, 'consumer');
		fs.cpSync(path.join(root, 'test/consumer'), consumer, { recursive: true });
		fs.writeFileSync(
			path.join(consumer, 'package.json'),
			JSON.stringify(
				{
					name: 'macros-consumer',
					private: true,
					type: 'module',
					scripts: { build: 'tsc' },
					dependencies: { seyfert: '5.1.0' },
					devDependencies: { '@slipher/macros': `file:../${pack.filename}`, typescript: '6.0.3' },
				},
				null,
				2,
			),
		);
		run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], consumer);
		fs.copyFileSync(path.join(root, '../../examples/macros/custom-id.ts'), path.join(consumer, 'src/custom-id.ts'));
		run(process.execPath, ['node_modules/@slipher/macros/lib/build.cjs'], consumer);
		provide('consumer', consumer);
		return () => fs.rmSync(directory, { recursive: true, force: true });
	} catch (error) {
		fs.rmSync(directory, { recursive: true, force: true });
		throw error;
	}
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './process.mjs';
