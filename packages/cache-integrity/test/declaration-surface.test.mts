import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, test } from 'vitest';

const tsc = createRequire(join(process.cwd(), 'package.json')).resolve('typescript/bin/tsc');

describe('emitted declaration surface', () => {
	test('keeps the Redis subpath valid after internal types are stripped', { timeout: 30_000 }, () => {
		const outDir = join(process.cwd(), 'test/.generated/declarations');
		try {
			rmSync(outDir, { recursive: true, force: true });
			execFileSync(
				process.execPath,
				[tsc, '--project', './tsconfig.json', '--emitDeclarationOnly', '--outDir', outDir, '--pretty', 'false'],
				{ cwd: process.cwd(), stdio: 'pipe' },
			);
			const consumer = join(outDir, 'consumer.ts');
			writeFileSync(
				consumer,
				[
					"import { type RedisCoordinator, redisCoordinator } from './coordinators/redis';",
					"import type { ReconciliationCoordinator } from './coordinator';",
					'declare const coordinator: RedisCoordinator;',
					'const publicCoordinator: ReconciliationCoordinator = coordinator;',
					'void publicCoordinator;',
					'void redisCoordinator;',
				].join('\n'),
			);
			execFileSync(
				process.execPath,
				[
					tsc,
					'--ignoreConfig',
					'--noEmit',
					'--strict',
					'--skipLibCheck',
					'false',
					'--module',
					'CommonJS',
					'--moduleResolution',
					'node',
					'--target',
					'ESNext',
					'--types',
					'node',
					'--ignoreDeprecations',
					'6.0',
					consumer,
				],
				{ cwd: process.cwd(), stdio: 'pipe' },
			);
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	});
});
