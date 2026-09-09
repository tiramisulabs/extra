#!/usr/bin/env node
function build() {
	const parsedArgs = ts.parseCommandLine(process.argv.slice(2));
	if (parsedArgs.options.watch) throw new Error('Watch mode is not supported in v1.');
	const configPath = resolveConfigPath(parsedArgs.options.project);
	const config = ts.readConfigFile(configPath, ts.sys.readFile);
	if (config.error) return report([config.error]);
	const parsed = ts.parseJsonConfigFileContent(
		config.config,
		ts.sys,
		path.dirname(configPath),
		parsedArgs.options,
		configPath,
	);
	if (parsed.projectReferences?.length) throw new Error('Project references are not supported in v1.');
	const host = ts.createCompilerHost(parsed.options, true);
	const original = ts.createProgram(parsed.fileNames, parsed.options, host);
	const expansion = expand(original, ts, true);
	const getSourceFile = host.getSourceFile.bind(host);
	host.getSourceFile = (file, options, ...args) => {
		const generated = expansion.files.get(file);
		return generated
			? ts.createSourceFile(file, generated.text, options, true, generated.source.scriptKind)
			: getSourceFile(file, options, ...args);
	};
	const program = ts.createProgram(parsed.fileNames, parsed.options, host);
	const transforms = userMacros(program, ts);
	const diagnostics = [
		...parsedArgs.errors,
		...parsed.errors,
		...expansion.diagnostics,
		...transforms.diagnostics,
		...ts.getPreEmitDiagnostics(program),
	];
	if (diagnostics.length) return report(diagnostics, expansion);
	const result = program.emit(undefined, undefined, undefined, undefined, transforms);
	return report(result.diagnostics, expansion);
}

function report(diagnostics, expansion) {
	const mapped = diagnostics.map(item => {
		const entry = expansion && item.file && expansion.files.get(item.file.fileName);
		if (!entry || item.file === entry.source || item.start === undefined) return item;
		const span = entry.span({ start: item.start, length: item.length ?? 0 });
		return { ...item, file: entry.source, start: span.start, length: span.length };
	});
	if (mapped.length)
		console.error(
			ts.formatDiagnosticsWithColorAndContext(mapped, {
				getCanonicalFileName: file => file,
				getCurrentDirectory: ts.sys.getCurrentDirectory,
				getNewLine: () => '\n',
			}),
		);
	process.exitCode = mapped.some(item => item.category === ts.DiagnosticCategory.Error) ? 1 : 0;
}

function resolveConfigPath(project) {
	if (project) {
		const resolved = path.resolve(project);
		return ts.sys.directoryExists(resolved) ? path.join(resolved, 'tsconfig.json') : resolved;
	}
	const found = ts.findConfigFile(process.cwd(), ts.sys.fileExists, 'tsconfig.json');
	if (!found) throw new Error('tsconfig not found');
	return found;
}

const path = require('node:path');
const ts = require('typescript');
const { expand } = require('./transform.cjs');
const { userMacros } = require('./user-macros.cjs');
build();
