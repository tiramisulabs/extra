import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageName = process.argv[2];
if (!packageName) {
	throw new TypeError('Usage: node scripts/vendor-internal.mjs <package-name>');
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const internalLib = resolve(root, 'packages/internal/lib');
const target = resolve(root, `packages/${packageName}/lib/node_modules/@slipher/internal`);

rmSync(target, { force: true, recursive: true });
mkdirSync(target, { recursive: true });
cpSync(internalLib, resolve(target, 'lib'), { recursive: true });
writeFileSync(
	resolve(target, 'package.json'),
	`${JSON.stringify(
		{
			name: '@slipher/internal',
			version: '0.0.0',
			private: true,
			main: './lib/index.js',
			types: './lib/index.d.ts',
		},
		null,
		'\t',
	)}\n`,
);
