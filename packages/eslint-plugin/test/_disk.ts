import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ESLint, type Linter } from 'eslint';
import * as tseslint from 'typescript-eslint';
import plugin from '../src/rules/_';

const require = createRequire(import.meta.url);
// Resolve the real seyfert package dir so fixtures in a temp project can
// `import { ... } from 'seyfert'` (mirrors seyfert-core's symlink trick).
const seyfertDir = dirname(require.resolve('seyfert/package.json'));

const FIXTURE_TSCONFIG = JSON.stringify({
	compilerOptions: {
		module: 'CommonJS',
		target: 'ESNext',
		lib: ['ESNext'],
		moduleResolution: 'node',
		experimentalDecorators: true,
		emitDecoratorMetadata: true,
		strict: true,
		esModuleInterop: true,
		skipLibCheck: true,
		noEmit: true,
		types: [],
	},
	include: ['**/*.ts'],
});

export interface DiskMessage {
	ruleId: string | null;
	messageId?: string;
	message: string;
	line: number;
}

export interface DiskResult {
	file: string;
	messages: DiskMessage[];
}

/**
 * Write `files` into an isolated temp project (with `seyfert` symlinked in),
 * lint them through a real TypeScript program, then clean up. This is the
 * seyfert-core-style harness: real files on disk, real multi-file type graph.
 */
export async function lintProject(files: Record<string, string>, rules: Linter.RulesRecord): Promise<DiskResult[]> {
	const root = mkdtempSync(join(tmpdir(), 'seyfert-eslint-'));
	try {
		mkdirSync(join(root, 'node_modules'), { recursive: true });
		symlinkSync(seyfertDir, join(root, 'node_modules', 'seyfert'), 'dir');
		writeFileSync(join(root, 'tsconfig.json'), FIXTURE_TSCONFIG);
		for (const [name, code] of Object.entries(files)) {
			const filePath = join(root, name);
			mkdirSync(dirname(filePath), { recursive: true });
			writeFileSync(filePath, code);
		}

		const eslint = new ESLint({
			cwd: root,
			overrideConfigFile: true,
			overrideConfig: [
				{
					files: ['**/*.ts'],
					languageOptions: {
						parser: tseslint.parser,
						parserOptions: { project: ['./tsconfig.json'], tsconfigRootDir: root },
					},
					plugins: { seyfert: plugin },
					rules,
				},
			],
		});

		const results = await eslint.lintFiles(Object.keys(files).map(name => join(root, name)));
		return results.map(result => ({
			file: result.filePath,
			messages: result.messages.map(message => ({
				ruleId: message.ruleId,
				messageId: message.messageId,
				message: message.message,
				line: message.line,
			})),
		}));
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
}
