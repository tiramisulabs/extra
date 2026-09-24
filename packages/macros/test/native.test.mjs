async function verifyServer() {
	const dir = inject('consumer');
	const file = path.join(dir, 'src/command.ts');
	const text = fs.readFileSync(file, 'utf8');
	const server = spawn(
		process.execPath,
		[require.resolve('typescript/lib/tsserver.js', { paths: [dir] }), '--disableAutomaticTypingAcquisition'],
		{
			cwd: dir,
			stdio: ['pipe', 'pipe', 'pipe'],
		},
	);
	const pending = new Map();
	let sequence = 0;
	let buffer = Buffer.alloc(0);
	let stderr = '';
	server.stderr.on('data', chunk => {
		stderr += chunk;
	});
	server.stdout.on('data', chunk => {
		buffer = Buffer.concat([buffer, chunk]);
		while (true) {
			const headerEnd = buffer.indexOf('\r\n\r\n');
			if (headerEnd < 0) return;
			const length = Number(/Content-Length: (\d+)/.exec(buffer.subarray(0, headerEnd).toString())?.[1]);
			if (!Number.isFinite(length)) throw new Error('Invalid tsserver frame');
			const bodyStart = headerEnd + 4;
			if (buffer.length < bodyStart + length) return;
			const message = JSON.parse(buffer.subarray(bodyStart, bodyStart + length).toString());
			buffer = buffer.subarray(bodyStart + length);
			if (message.type === 'response') pending.get(message.request_seq)?.(message);
		}
	});
	function request(command, args) {
		return new Promise((resolve, reject) => {
			const seq = ++sequence;
			const timer = setTimeout(() => {
				pending.delete(seq);
				reject(new Error(`tsserver timed out on ${command}: ${stderr}`));
			}, 15000);
			pending.set(seq, response => {
				clearTimeout(timer);
				pending.delete(seq);
				if (!response.success) reject(new Error(response.message));
				else resolve(response.body);
			});
			server.stdin.write(`${JSON.stringify({ seq, type: 'request', command, arguments: args })}\n`);
		});
	}
	async function completions(source) {
		const expression = 'ctx.options.';
		const position = source.indexOf(expression) + expression.length;
		const lines = source.slice(0, position).split('\n');
		const result = await request('completionInfo', { file, line: lines.length, offset: lines.at(-1).length + 1 });
		return result.entries.map(entry => entry.name).sort();
	}
	try {
		await request('open', { file, projectRootPath: dir });
		const buttonFile = path.join(dir, 'src/user-button.ts');
		const buttonText = fs.readFileSync(buttonFile, 'utf8');
		await request('open', { file: buttonFile, projectRootPath: dir });
		expect(await request('semanticDiagnosticsSync', { file: buttonFile })).toEqual([]);
		const paramPosition = buttonText.indexOf('ctx.params.') + 'ctx.params.'.length;
		const paramLines = buttonText.slice(0, paramPosition).split('\n');
		const paramLocation = { file: buttonFile, line: paramLines.length, offset: paramLines.at(-1).length + 1 };
		const paramCompletions = await request('completionInfo', paramLocation);
		expect(paramCompletions.entries.map(entry => entry.name)).toEqual(['userId']);
		const paramHover = await request('quickinfo', paramLocation);
		expect(paramHover.displayString).toMatch(/userId: string/);
		const changedButton = buttonText.replaceAll('userId', 'memberId');
		const buttonLines = buttonText.split('\n');
		await request('change', {
			file: buttonFile,
			line: 1,
			offset: 1,
			endLine: buttonLines.length,
			endOffset: buttonLines.at(-1).length + 1,
			insertString: changedButton,
		});
		expect(await request('semanticDiagnosticsSync', { file: buttonFile })).toEqual([]);
		const changedCompletions = await request('completionInfo', paramLocation);
		expect(changedCompletions.entries.map(entry => entry.name)).toEqual(['memberId']);
		const handlersFile = path.join(dir, 'src/handlers.ts');
		const handlers = fs.readFileSync(handlersFile, 'utf8');
		await request('open', { file: handlersFile, projectRootPath: dir });
		expect(await request('semanticDiagnosticsSync', { file: handlersFile })).toEqual([]);
		const handlerKinds = [
			['ChatHooks', 'CommandContext'],
			['SubHooks', 'CommandContext'],
			['ButtonHooks', 'ComponentContext'],
			['ModalHooks', 'ModalContext'],
			['UserMenuHooks', 'MenuCommandContext'],
			['MessageMenuHooks', 'MenuCommandContext'],
			['EntryHooks', 'EntryPointContext'],
		];
		for (const [name, expected] of handlerKinds) {
			const start = handlers.indexOf(`class ${name} `);
			const position = handlers.indexOf('ctx.', start) + 1;
			const prefix = handlers.slice(0, position).split('\n');
			const result = await request('quickinfo', {
				file: handlersFile,
				line: prefix.length,
				offset: prefix.at(-1).length + 1,
			});
			expect(result.displayString.includes(expected), result.displayString).toBeTruthy();
		}
		const guildFile = path.join(dir, 'src/guild.ts');
		const guildText = fs.readFileSync(guildFile, 'utf8');
		await request('open', { file: guildFile, projectRootPath: dir });
		expect(await request('semanticDiagnosticsSync', { file: guildFile })).toEqual([]);
		const guildPosition = guildText.indexOf('ctx.guildId') + 'ctx.'.length + 1;
		const guildLines = guildText.slice(0, guildPosition).split('\n');
		const guildHover = await request('quickinfo', {
			file: guildFile,
			line: guildLines.length,
			offset: guildLines.at(-1).length + 1,
		});
		expect(guildHover.displayString).toMatch(/guildId: string/);
		expect(!guildHover.displayString.includes('undefined')).toBeTruthy();
		// Changing the marker in memory must remove the guild-only assumption.
		const regular = guildText.replace('@GuildContext()', '@Context()');
		const previousLines = guildText.split('\n');
		await request('change', {
			file: guildFile,
			line: 1,
			offset: 1,
			endLine: previousLines.length,
			endOffset: previousLines.at(-1).length + 1,
			insertString: regular,
		});
		const regularDiagnostics = await request('semanticDiagnosticsSync', { file: guildFile });
		const expected = regular.indexOf('id: string');
		const expectedLines = regular.slice(0, expected).split('\n');
		expect(
			regularDiagnostics.some(
				item =>
					item.code === 2322 &&
					item.start.line === expectedLines.length &&
					item.start.offset === expectedLines.at(-1).length + 1,
			),
			JSON.stringify(regularDiagnostics),
		).toBeTruthy();
		expect(await request('semanticDiagnosticsSync', { file })).toEqual([]);
		expect(await completions(text)).toEqual(['limit', 'query']);
		const contextPosition = text.indexOf('ctx.options.query') + 1;
		const contextLines = text.slice(0, contextPosition).split('\n');
		const location = { file, line: contextLines.length, offset: contextLines.at(-1).length + 1 };
		const hover = await request('quickinfo', location);
		expect(hover.displayString).toMatch(/CommandContext/);
		const definitions = await request('definition', location);
		expect(definitions.length).toBeTruthy();
		expect(definitions.every(item => item.start.line <= text.split('\n').length)).toBeTruthy();
		expect(
			text
				.split('\n')
				[definitions[0].start.line - 1].slice(definitions[0].start.offset - 1, definitions[0].end.offset - 1),
		).toBe('ctx');
		const namedPosition = text.lastIndexOf('ctx.metadata.') + 'ctx.metadata.'.length;
		const namedLines = text.slice(0, namedPosition).split('\n');
		const named = await request('completionInfo', {
			file,
			line: namedLines.length,
			offset: namedLines.at(-1).length + 1,
		});
		expect(named.entries.map(item => item.name)).toEqual(['staff']);
		await request('reloadProjects', {});
		expect(await request('semanticDiagnosticsSync', { file })).toEqual([]);
		const edited = text
			.replace('query: createStringOption', 'term: createStringOption')
			.replaceAll('.options.query', '.options.term');
		const lines = text.split('\n');
		await request('change', {
			file,
			line: 1,
			offset: 1,
			endLine: lines.length,
			endOffset: lines.at(-1).length + 1,
			insertString: edited,
		});
		expect(await request('semanticDiagnosticsSync', { file })).toEqual([]);
		expect(await completions(edited)).toEqual(['limit', 'term']);
		const editedLines = edited.split('\n');
		const invalid = edited
			.replace('const query: string = ctx.options.term', 'const query: number = ctx.options.term')
			.replace('async run(ctx) {\n\t\tconst query', 'async run(ctx) { const query');
		await request('change', {
			file,
			line: 1,
			offset: 1,
			endLine: editedLines.length,
			endOffset: editedLines.at(-1).length + 1,
			insertString: invalid,
		});
		const diagnostics = await request('semanticDiagnosticsSync', { file });
		expect(
			diagnostics.some(item => item.code === 2322),
			JSON.stringify(diagnostics),
		).toBeTruthy();
		const wrong = diagnostics.find(item => item.code === 2322);
		const wrongPosition = invalid.indexOf('query: number');
		const wrongLines = invalid.slice(0, wrongPosition).split('\n');
		expect(wrong.start).toEqual({ line: wrongLines.length, offset: wrongLines.at(-1).length + 1 });
	} finally {
		server.kill();
	}
}

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, inject, test } from 'vitest';

const require = createRequire(import.meta.url);
test('native tsserver keeps inference and source positions across edits', verifyServer);
