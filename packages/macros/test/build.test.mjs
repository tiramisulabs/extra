async function verifyBuild() {
	const root = inject('consumer');
	const compiler = path.join(root, 'node_modules/@slipher/macros/lib/build.cjs');
	const file = path.join(root, 'src/command.ts');
	const config = path.join(root, 'package.json');
	const original = fs.readFileSync(file, 'utf8');
	const tsconfig = path.join(root, 'tsconfig.json');
	const originalTsconfig = fs.readFileSync(tsconfig, 'utf8');
	const originalConfig = fs.readFileSync(config, 'utf8');
	const run = () => spawnSync(process.execPath, [compiler], { cwd: root, encoding: 'utf8' });
	try {
		for (const type of ['commonjs', 'module']) {
			fs.writeFileSync(config, JSON.stringify({ ...JSON.parse(originalConfig), type }));
			let result = run();
			expect(result.status, result.stdout + result.stderr).toBe(0);
			const javascript = fs.readFileSync(path.join(root, 'dist/command.js'), 'utf8');
			expect(!javascript.includes('@slipher/macros'), javascript).toBeTruthy();
			expect(!fs.readFileSync(path.join(root, 'dist/guild.js'), 'utf8').includes('@slipher/macros')).toBeTruthy();
			const declarations = fs.readFileSync(path.join(root, 'dist/command.d.ts'), 'utf8');
			expect(declarations).toMatch(/run\(ctx: import\('seyfert'\).CommandContext<typeof options, "staff">\)/);
			result = spawnSync(
				process.execPath,
				[
					'--input-type=module',
					'-e',
					`
                import { Search, Named } from './dist/command.js';
                import { GuildChat, GuildSub } from './dist/guild.js';
                import { Unrelated } from './dist/unrelated.js';
                const guild = new GuildChat().run({ guildId: 'guild', member: { user: {} }, options: { query: 'hello' }, metadata: { staff: { userId: 'staff' } } });
                if (JSON.stringify(guild) !== JSON.stringify({ id: 'guild', query: 'hello', staff: 'staff' })) throw Error('Guild inference changed runtime');
                if (new GuildSub().run({ guildId: undefined }) !== undefined) throw Error('GuildContext must not add a runtime guard');
                const command = new Search();
                const result = await command.run({ options: { query: 'hello', limit: 3 }, metadata: { staff: { userId: 'staff' } } });
                if (JSON.stringify(result) !== JSON.stringify({ query: 'hello', limit: 3, userId: 'staff' })) throw Error('Incorrect command result');
                if (command.name !== 'search' || command.options.length !== 2) throw Error('Decorators lost');
                if (await new Named().run({ metadata: { staff: { userId: 'staff' } } }) !== 'staff') throw Error('SubCommand failed');
                if (new Unrelated().run({ existing: 'ok' }) !== 'ok') throw Error('Unrelated decorator changed');
            `,
				],
				{ cwd: root, encoding: 'utf8' },
			);
			expect(result.status, result.stdout + result.stderr).toBe(0);
		}
		const esmConfig = JSON.parse(originalTsconfig);
		esmConfig.compilerOptions.verbatimModuleSyntax = true;
		fs.writeFileSync(tsconfig, JSON.stringify(esmConfig));
		const verbatim = run();
		expect(verbatim.status, verbatim.stdout + verbatim.stderr).toBe(0);
		expect(!fs.readFileSync(path.join(root, 'dist/command.js'), 'utf8').includes('@slipher/macros')).toBeTruthy();
		expect(!fs.readFileSync(path.join(root, 'dist/guild.js'), 'utf8').includes('@slipher/macros')).toBeTruthy();
		fs.writeFileSync(tsconfig, originalTsconfig);
		const withGuildImport = "import { GuildContext } from '@slipher/macros';\n" + original;
		const negativeCases = [
			[withGuildImport.replace('@Context()', '@GuildContext()\n\t@Context()'), 'TS99001'],
			[
				withGuildImport
					.replace('@Context()', '@GuildContext()')
					.replace('async run(ctx)', 'async onInternalError(ctx)'),
				'TS99001',
			],
			[original.replace('const query: string', 'const query: number'), 'TS2322'],
			[original.replace('@CommandOptions(options)', '@CommandOptions({ query: options.query })'), 'TS99001'],
			[original.replace('async run(ctx)', 'async run(ctx: unknown)'), 'TS99001'],
			[
				original.replace(
					'export class Search extends Command',
					'class Intermediate extends Command {}\nexport class Search extends Intermediate',
				),
				'TS99001',
			],
		];
		for (const [source, expected] of negativeCases) {
			fs.writeFileSync(file, source);
			const result = run();
			expect(result.status, result.stdout + result.stderr).toBe(1);
			expect(result.stderr.includes(expected), result.stderr).toBeTruthy();
			if (expected === 'TS2322') {
				const position = source.indexOf('query: number');
				const prefix = source.slice(0, position).split('\n');
				const plain = result.stderr.replace(/\x1b\[[0-9;]*m/g, '');
				expect(plain.includes(`command.ts:${prefix.length}:${prefix.at(-1).length + 1}`), plain).toBeTruthy();
			}
		}
	} finally {
		fs.writeFileSync(file, original);
		fs.writeFileSync(config, originalConfig);
		fs.writeFileSync(tsconfig, originalTsconfig);
	}
	const result = run();
	expect(result.status, result.stdout + result.stderr).toBe(0);
}

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, inject, test } from 'vitest';

test('contexts compile with strict types and execute in CJS and ESM', verifyBuild);
