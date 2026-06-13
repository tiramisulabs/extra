import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(join(process.cwd(), 'package.json'));
const tscPath = require.resolve('typescript/bin/tsc');

export function setup() {
	const generatedFixturesDir = join(process.cwd(), 'test/.generated/fixtures');
	rmSync(generatedFixturesDir, { recursive: true, force: true });
	execFileSync(process.execPath, [tscPath, '--project', join(process.cwd(), 'test/fixtures/tsconfig.json')], {
		cwd: process.cwd(),
		stdio: 'inherit',
	});
}
